/**
 * Unit tests for ClipboardManager.appendChunk — streaming incremental-paste path.
 *
 * ## Mocking strategy
 *
 * `clipboard.js` uses CommonJS `require("electron")` and `require("child_process")`
 * at module-evaluation time.  Vitest's vi.mock() intercepts ESM import() calls but
 * does NOT intercept the CJS require() calls that run inside a CJS module such as
 * clipboard.js.  To work around this we inject our mock objects directly into
 * Node's require.cache BEFORE requiring clipboard.js, then delete clipboard.js from
 * require.cache so that each beforeEach gets a fresh module evaluation that picks up
 * the injected mocks.
 *
 * ## Timer strategy
 *
 * `sleep()` in clipboard.js is built on `setTimeout`.  We use `vi.useFakeTimers()`
 * so that `vi.advanceTimersByTimeAsync(n)` drives the delays deterministically
 * without any real waiting.
 *
 * ## Platform strategy
 *
 * We force `process.platform = "linux"` so appendChunk skips the darwin
 * accessibility-check branch (which would spawn an extra osascript process) and
 * routes `_pressPaste` to `xdotool` — a single, predictable spawn per paste.
 *
 * ## Constants under test (from clipboard.js)
 *   PASTE_SETTLE_MS  = 60   — sleep BEFORE spawning the paste process
 *   PASTE_CONSUME_MS = 90   — sleep AFTER the paste process emits 'close'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import path from "path";

// ─── Resolve module paths once ───────────────────────────────────────────────

const ELECTRON_PATH    = require.resolve("electron");
const CHILD_PROC_PATH  = require.resolve("child_process");

// Resolve clipboard.js path using fileURLToPath to handle spaces in directory
// names correctly (import.meta.url uses %20 encoding which require() rejects).
const __dirname_test   = path.dirname(fileURLToPath(import.meta.url));
const CLIPBOARD_PATH   = path.resolve(__dirname_test, "../src/helpers/clipboard.js");

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("ClipboardManager.appendChunk — streaming incremental-paste", () => {
  // Per-test shared state — initialised in beforeEach.
  let mockClipboard;
  let mockSpawn;
  let spawnedProcesses;
  let ClipboardManager;

  const logger = { info() {}, warn() {}, error() {} };

  beforeEach(() => {
    // ── 1. Build mock implementations ────────────────────────────────────────

    spawnedProcesses = [];
    let clipboardBuffer = "";

    mockClipboard = {
      writeText: vi.fn((text) => { clipboardBuffer = text; }),
      readText:  vi.fn(() => clipboardBuffer),
    };

    mockSpawn = vi.fn((_cmd, _args) => {
      const proc = new EventEmitter();
      // _pressPaste listens on 'close' and 'error'; we also expose kill() so
      // the paste-timeout branch doesn't throw if it fires in a test.
      proc.kill = vi.fn();
      spawnedProcesses.push(proc);
      return proc;
    });

    // ── 2. Inject mocks into require.cache before requiring clipboard.js ──────
    //
    // electron is not a real Node module (its index.js exports the binary
    // path), so require("electron") returns a Buffer/string, not an object
    // with a clipboard property.  We override the cache entry so that when
    // clipboard.js does `const { clipboard } = require("electron")` it gets
    // our mock object.

    require.cache[ELECTRON_PATH] = {
      id:       ELECTRON_PATH,
      filename: ELECTRON_PATH,
      loaded:   true,
      exports:  { clipboard: mockClipboard },
    };

    // child_process is a native built-in; it has no require.cache entry by
    // default.  Setting one here causes Node to return our mock object for
    // `require("child_process")` inside clipboard.js, so `const { spawn } =
    // require("child_process")` captures our mockSpawn function.

    require.cache[CHILD_PROC_PATH] = {
      id:       CHILD_PROC_PATH,
      filename: CHILD_PROC_PATH,
      loaded:   true,
      exports:  { spawn: mockSpawn },
    };

    // ── 3. Delete clipboard.js from cache so it re-evaluates with the mocks ──

    delete require.cache[CLIPBOARD_PATH];

    // ── 4. Force linux BEFORE requiring so the darwin guard in the constructor
    //       does not attempt to require("osascript"). ─────────────────────────

    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    ClipboardManager = require(CLIPBOARD_PATH);

    // ── 5. Activate fake timers so sleep() is driven by advanceTimersByTimeAsync

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();

    // Remove injected cache entries so subsequent tests (and the rest of the
    // test suite) see the real modules.
    delete require.cache[ELECTRON_PATH];
    delete require.cache[CHILD_PROC_PATH];
    delete require.cache[CLIPBOARD_PATH];

    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });

  // ── Test 1: Non-empty text ordering ────────────────────────────────────────

  describe("non-empty text", () => {
    /**
     * Invariant: writeText fires synchronously (before any sleep), spawn fires
     * only after PASTE_SETTLE_MS has elapsed, and the returned promise does NOT
     * resolve until at least PASTE_CONSUME_MS after the spawn process emits
     * 'close'.
     */
    it("calls writeText immediately, spawns after PASTE_SETTLE_MS, and resolves only after PASTE_CONSUME_MS", async () => {
      // Arrange
      const PASTE_SETTLE_MS  = 60;
      const PASTE_CONSUME_MS = 90;
      const manager = new ClipboardManager(logger);

      // Act — start the chunk without awaiting so we can observe intermediate state.
      const chunkPromise = manager.appendChunk("hello");

      // Flush microtasks: the run() callback inside _pasteChain.then() executes
      // synchronously up to the first `await sleep(PASTE_SETTLE_MS)`.
      await vi.advanceTimersByTimeAsync(0);

      // Assert: writeText must have fired BEFORE any sleep.
      expect(mockClipboard.writeText).toHaveBeenCalledWith("hello");
      // spawn must NOT yet have been called — it is gated behind the settle sleep.
      expect(mockSpawn).not.toHaveBeenCalled();

      // Advance to 1 ms BEFORE the settle delay expires — spawn still absent.
      await vi.advanceTimersByTimeAsync(PASTE_SETTLE_MS - 1);
      expect(mockSpawn).not.toHaveBeenCalled();

      // Cross the settle boundary — _pressPaste() runs and spawn fires.
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // The promise must NOT resolve yet (paste process still running, consume
      // wait has not started).
      let resolved = false;
      chunkPromise.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      expect(resolved).toBe(false);

      // Simulate the paste process exiting successfully.
      spawnedProcesses[0].emit("close", 0);

      // Even after process exit, the promise must wait for PASTE_CONSUME_MS.
      await vi.advanceTimersByTimeAsync(PASTE_CONSUME_MS - 1);
      await Promise.resolve(); // extra microtask flush
      expect(resolved).toBe(false);

      // Cross the consume boundary — the promise should now resolve.
      await vi.advanceTimersByTimeAsync(1);
      await chunkPromise; // must not throw
      expect(resolved).toBe(true);
    });
  });

  // ── Test 2: Empty text ─────────────────────────────────────────────────────

  describe("empty text", () => {
    /**
     * Invariant: appendChunk("") must never call writeText and must never spawn
     * a paste process; it only drains/awaits the serial _pasteChain.
     */
    it("never calls writeText and never spawns a paste process", async () => {
      // Arrange + Act
      const manager = new ClipboardManager(logger);
      const emptyPromise = manager.appendChunk("");

      // Drain all possible timers — even if timers existed they must not fire
      // writeText or spawn.
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert: clipboard and spawn both untouched.
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();

      // The promise itself must still resolve (empty chunk is a serial barrier,
      // not a failure).
      await emptyPromise;
    });

    /**
     * An empty chunk draining the chain must not prevent a subsequent non-empty
     * chunk from running.
     */
    it("resolves the serial chain so a subsequent non-empty chunk can proceed", async () => {
      // Arrange — prime the chain with an empty chunk.
      const manager = new ClipboardManager(logger);
      const emptyPromise = manager.appendChunk("");

      // Flush microtasks so the empty chunk's run() runs and resolves.
      await vi.advanceTimersByTimeAsync(0);
      await emptyPromise;

      // Act — enqueue a real chunk AFTER the empty one is done.
      const chunkPromise = manager.appendChunk("world");
      await vi.advanceTimersByTimeAsync(0);

      // The real chunk's writeText must fire now.
      expect(mockClipboard.writeText).toHaveBeenCalledWith("world");

      // Drive the real chunk to completion.
      await vi.advanceTimersByTimeAsync(60); // PASTE_SETTLE_MS
      spawnedProcesses[0].emit("close", 0);
      await vi.advanceTimersByTimeAsync(90); // PASTE_CONSUME_MS
      await chunkPromise;

      // Exactly one spawn — the empty chunk never spawned.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 3: Two serialized calls run strictly in order ─────────────────────

  describe("serialization — two consecutive appendChunk calls", () => {
    /**
     * Invariant: the second chunk's writeText must NOT execute until the first
     * chunk's full settle + paste + consume cycle has completed.  The serial
     * _pasteChain guarantees this ordering.
     */
    it("second chunk writeText does not fire until first chunk full cycle completes", async () => {
      // Arrange
      const PASTE_SETTLE_MS  = 60;
      const PASTE_CONSUME_MS = 90;
      const manager = new ClipboardManager(logger);

      const order = [];

      // Act — fire both chunks without awaiting so they queue on _pasteChain.
      const chunk1 = manager.appendChunk("first");
      const chunk2 = manager.appendChunk("second");

      // Flush microtasks — chunk1's run() starts; chunk2 waits on the chain.
      await vi.advanceTimersByTimeAsync(0);

      // Only "first" should be written at this point.
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
      expect(mockClipboard.writeText).toHaveBeenNthCalledWith(1, "first");

      // Advance through chunk1's settle delay — spawn fires for chunk1 only.
      await vi.advanceTimersByTimeAsync(PASTE_SETTLE_MS);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // "second" must still not have been written.
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);

      // Chunk1 paste process exits.
      spawnedProcesses[0].emit("close", 0);

      // Advance through chunk1's consume wait — chunk1 resolves.
      await vi.advanceTimersByTimeAsync(PASTE_CONSUME_MS);
      await chunk1;
      order.push("chunk1-resolved");

      // chunk2's run() should now be dequeued — flush microtasks.
      await vi.advanceTimersByTimeAsync(0);

      // "second" must now have been written.
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(2);
      expect(mockClipboard.writeText).toHaveBeenNthCalledWith(2, "second");
      order.push("chunk2-writeText");

      // Advance through chunk2's settle delay — second spawn fires.
      await vi.advanceTimersByTimeAsync(PASTE_SETTLE_MS);
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // Chunk2 paste process exits.
      spawnedProcesses[1].emit("close", 0);

      // Advance through chunk2's consume wait — chunk2 resolves.
      await vi.advanceTimersByTimeAsync(PASTE_CONSUME_MS);
      await chunk2;
      order.push("chunk2-resolved");

      // Assert strict ordering: chunk1 fully resolved BEFORE chunk2 wrote.
      expect(order).toEqual([
        "chunk1-resolved",
        "chunk2-writeText",
        "chunk2-resolved",
      ]);
    });
  });
});
