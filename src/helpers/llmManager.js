const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

// 本地 LLM 引擎清单：仅 4B，安装后后台静默下载到用户数据目录（不打进安装包）。
// 命名与 huggingface unsloth 仓库对齐（Qwen3.5 GGUF，Q4_K_M，Apache-2.0）。
const LOCAL_ENGINES = {
  "local-4b": {
    fileName: "Qwen3.5-4B-Q4_K_M.gguf",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    expectedSize: 2740937888, // ~2.74GB
    bundled: false,
  },
};

// 国内镜像直链（resolve/main）：一开始就走 hf-mirror.com（不走国外 huggingface.co）。
// 路径结构与 HuggingFace 相同。ModelScope 作为二级兜底。
const HF_BASE = "https://hf-mirror.com";
const MODELSCOPE_BASE = "https://modelscope.cn/models";

const DEFAULT_LOCAL_ENGINE = "local-4b";
const INIT_TIMEOUT_MS = 120000; // 加载 GGUF 最长等待

// 本地 LLM 平台支持：Windows-ARM64 不支持（llama-cpp-python 无可靠 win_arm64 轮子，
// 嵌入式 Python 未打包该依赖）。macOS（Metal 轮子）与 Windows-x64（CPU 轮子）均支持。
const LOCAL_LLM_SUPPORTED = !(process.platform === "win32" && process.arch === "arm64");

class LLMManager {
  constructor(logger = null) {
    this.logger = logger || console;
    this.pythonCmd = null;
    this.serverProcess = null;
    this.serverReady = false;
    this.serverStartError = null;
    this.currentEngine = null; // 当前已加载的引擎 key
    this.initializationPromise = null;
    this._cmdChain = null;
    this._cmdSeq = 0;
    this._pendingStdinReject = null;
    this._intentionalStop = false;
    this._downloading = new Set(); // 正在下载的引擎 key，防重复
    this._cachedPythonEnv = null;
  }

  // ——— 路径解析（复用 funasrManager 的嵌入式 Python 布局约定）———

  getLLMServerPath() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "llm_server.py");
    }
    return path.join(process.resourcesPath, "app.asar.unpacked", "llm_server.py");
  }

  getEmbeddedPythonDir() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "python");
    }
    return path.join(process.resourcesPath, "app.asar.unpacked", "python");
  }

  getEmbeddedPythonPath() {
    const pythonDir = this.getEmbeddedPythonDir();
    if (process.platform === "win32") {
      return path.join(pythonDir, "python.exe");
    }
    return path.join(pythonDir, "bin", "python3.11");
  }

  getEmbeddedSitePackages(pythonHome) {
    if (process.platform === "win32") {
      return path.join(pythonHome, "Lib", "site-packages");
    }
    return path.join(pythonHome, "lib", "python3.11", "site-packages");
  }

  // 内置模型目录：开发态在仓库 models/，打包态在 app.asar.unpacked/models/。
  getBundledModelsDir() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "models");
    }
    return path.join(process.resourcesPath, "app.asar.unpacked", "models");
  }

  // 按需下载模型目录：用户数据目录下 models/（可写、随构建不丢）。
  getUserModelsDir() {
    try {
      const { app } = require("electron");
      return path.join(app.getPath("userData"), "models");
    } catch (e) {
      // 非 Electron 环境（如单测）回退到临时目录
      return path.join(os.tmpdir(), "wordtaker_models");
    }
  }

  // 解析某引擎的 GGUF 文件绝对路径：内置引擎优先内置目录，否则用户数据目录。
  getModelPath(engine) {
    const cfg = LOCAL_ENGINES[engine];
    if (!cfg) return null;
    if (cfg.bundled) {
      return path.join(this.getBundledModelsDir(), cfg.fileName);
    }
    return path.join(this.getUserModelsDir(), cfg.fileName);
  }

  isValidLocalEngine(engine) {
    return Object.prototype.hasOwnProperty.call(LOCAL_ENGINES, engine);
  }

  // 本地 LLM 在当前平台是否可用（win32+arm64 不可用，其余平台可用）。
  isLocalLLMSupported() {
    return LOCAL_LLM_SUPPORTED;
  }

  // 某引擎的模型文件是否已就绪（存在且大小达标）。平台不支持一律视为未就绪，
  // 让上层（额度降级/预热/后台下载）自然跳过本地路径。
  isModelReady(engine) {
    if (!LOCAL_LLM_SUPPORTED) return false;
    const cfg = LOCAL_ENGINES[engine];
    if (!cfg) return false;
    const p = this.getModelPath(engine);
    try {
      const stats = fs.statSync(p);
      return stats.size >= cfg.expectedSize * 0.98; // 允许 2% 误差
    } catch (e) {
      return false;
    }
  }

  buildPythonEnvironment() {
    if (this._cachedPythonEnv) return this._cachedPythonEnv;
    const env = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
    };
    try {
      env.ELECTRON_USER_DATA = require("electron").app.getPath("userData");
    } catch (e) {
      // 非 Electron 环境忽略
    }
    const pythonHome = this.getEmbeddedPythonDir();
    const sitePackages = this.getEmbeddedSitePackages(pythonHome);
    if (fs.existsSync(this.getEmbeddedPythonPath())) {
      env.PYTHONHOME = pythonHome;
      env.PYTHONPATH = sitePackages;
      if (process.platform === "win32") {
        env.PATH = `${pythonHome};${path.join(pythonHome, "Scripts")};${env.PATH || ""}`;
      } else {
        env.LD_LIBRARY_PATH = path.join(pythonHome, "lib");
        env.DYLD_LIBRARY_PATH = path.join(pythonHome, "lib");
      }
    }
    delete env.PYTHONUSERBASE;
    delete env.PYTHONSTARTUP;
    delete env.VIRTUAL_ENV;
    this._cachedPythonEnv = env;
    return env;
  }

  findPythonExecutable() {
    if (this.pythonCmd) return this.pythonCmd;
    const embedded = this.getEmbeddedPythonPath();
    if (fs.existsSync(embedded)) {
      this.pythonCmd = embedded;
      return embedded;
    }
    // 开发态回退系统 python3.11（与 funasrManager 的宽松回退一致）
    if (process.env.NODE_ENV === "development") {
      this.pythonCmd = "python3.11";
      return this.pythonCmd;
    }
    throw new Error("嵌入式 Python 不可用，无法启动本地 LLM");
  }

  // ——— 引擎生命周期 ———

  // 确保指定引擎已加载并就绪；引擎变化时重载。返回 { success, error? }。
  async ensureEngine(engine) {
    if (!LOCAL_LLM_SUPPORTED) {
      const msg = `本地模型暂不支持当前设备（${process.platform}/${process.arch}），请使用云端AI`;
      this.logger.warn && this.logger.warn("本地 LLM 平台不支持，拒绝启动", { platform: process.platform, arch: process.arch });
      return { success: false, error: msg, code: "platform_unsupported" };
    }
    if (!this.isValidLocalEngine(engine)) {
      return { success: false, error: `无效的本地引擎: ${engine}` };
    }
    // 已就绪且是同一引擎，直接复用
    if (this.serverReady && this.currentEngine === engine && this.serverProcess) {
      return { success: true };
    }
    // 引擎变更或未启动：停旧起新
    if (this.serverProcess) {
      await this._stopServer();
    }
    if (!this.isModelReady(engine)) {
      return {
        success: false,
        error: `模型未就绪(${engine})，请先下载`,
        code: "model_not_ready",
      };
    }
    this.currentEngine = engine;
    this.initializationPromise = this._startServer(engine);
    const r = await this.initializationPromise;
    this.initializationPromise = null;
    return r;
  }

  _startServer(engine) {
    return new Promise((resolve) => {
      this._intentionalStop = false;
      this.serverStartError = null;
      this.serverReady = false;

      let pythonCmd, serverPath, modelPath;
      try {
        pythonCmd = this.findPythonExecutable();
        serverPath = this.getLLMServerPath();
        modelPath = this.getModelPath(engine);
      } catch (e) {
        this.serverStartError = { reason: "resolve-failed", message: e.message };
        return resolve({ success: false, error: e.message });
      }

      if (!fs.existsSync(serverPath)) {
        const msg = `llm_server.py 未找到: ${serverPath}`;
        this.serverStartError = { reason: "server-script-missing", message: msg };
        return resolve({ success: false, error: msg });
      }
      if (!fs.existsSync(modelPath)) {
        const msg = `模型文件未找到: ${modelPath}`;
        this.serverStartError = { reason: "model-missing", message: msg };
        return resolve({ success: false, error: msg });
      }

      const env = this.buildPythonEnvironment();
      this.logger.info && this.logger.info("启动本地 LLM 服务器", { engine, modelPath });

      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const proc = spawn(pythonCmd, [serverPath, "--model", modelPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
      this.serverProcess = proc;

      proc.stdin.on("error", (error) => {
        this.logger.error && this.logger.error("LLM stdin 管道错误", error);
        if (this._pendingStdinReject) {
          const r = this._pendingStdinReject;
          this._pendingStdinReject = null;
          r(new Error(`LLM 服务器管道已关闭: ${error && error.message ? error.message : error}`));
        }
      });

      proc.stdout.on("data", (data) => {
        const lines = data.toString().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          if (settled) {
            // 就绪后的输出交给命令级监听器处理
            continue;
          }
          try {
            const result = JSON.parse(line);
            // 初始化响应（无 d/done 字段）
            if (result.success === true) {
              this.serverReady = true;
              this.serverStartError = null;
              this.logger.info && this.logger.info("本地 LLM 就绪", { engine });
              settle({ success: true });
            } else if (result.success === false) {
              this.serverStartError = { reason: result.type || "init-failed", message: result.error };
              this.logger.error && this.logger.error("本地 LLM 初始化失败", result);
              settle({ success: false, error: result.error || "LLM 初始化失败" });
            }
          } catch (e) {
            // 非 JSON（llama.cpp 日志理论上走 stderr，这里防御性忽略）
          }
        }
      });

      // 留存启动期 stderr 末尾（Windows 上 python.exe 缺 DLL/import 失败等
      // 只会打到 stderr 就退出；没有它，日志里只剩一个裸退出码，无法定位）。
      let stderrTail = "";
      proc.stderr.on("data", (data) => {
        const s = data.toString();
        if (!settled) stderrTail = (stderrTail + s).slice(-800);
        this.logger.debug && this.logger.debug("LLM stderr", { out: s });
      });

      proc.on("close", (code) => {
        this.logger.warn && this.logger.warn("本地 LLM 进程退出", { code });
        if (this.serverProcess === proc) {
          this.serverProcess = null;
          this.serverReady = false;
        }
        if (!settled) {
          this.logger.error && this.logger.error("本地 LLM 初始化前退出", {
            code,
            pythonCmd,
            modelPath,
            stderrTail,
          });
          this.serverStartError = { reason: "process-exited", message: `进程在初始化前退出(${code})` };
          settle({ success: false, error: `LLM 进程退出(${code})${stderrTail ? `: ${stderrTail.slice(-200)}` : ""}` });
        }
      });

      proc.on("error", (error) => {
        this.logger.error && this.logger.error("本地 LLM 进程错误", error);
        if (this.serverProcess === proc) {
          this.serverProcess = null;
          this.serverReady = false;
        }
        this.serverStartError = { reason: "spawn-failed", message: error.message };
        settle({ success: false, error: error.message });
      });

      setTimeout(() => {
        if (!settled) {
          this.serverStartError = { reason: "timeout", message: "LLM 加载超时" };
          try { proc.kill(); } catch (e) {}
          settle({ success: false, error: "LLM 加载超时" });
        }
      }, INIT_TIMEOUT_MS);
    });
  }

  async _stopServer() {
    this._intentionalStop = true;
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;
    this.currentEngine = null;
    if (proc) {
      try { proc.stdin && proc.stdin.write(JSON.stringify({ action: "exit" }) + "\n"); } catch (e) {}
      try { proc.kill(); } catch (e) {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch (e) {} }, 800);
    }
  }

  killServerSync() {
    this._intentionalStop = true;
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;
    if (proc) {
      try { proc.kill("SIGKILL"); } catch (e) {}
    }
  }

  // ——— 润色（流式）———

  // 对指定引擎润色文本。onDelta(增量) 边收边回调。返回 { success, text?, error? }。
  // 「无兜底」：本方法只负责所选引擎；失败直接返回 error，绝不换引擎/走云端。
  async polish(engine, text, mode = "normal", onDelta = null) {
    if (typeof text !== "string" || !text.trim()) {
      return { success: false, error: "无有效文本" };
    }
    const ensured = await this.ensureEngine(engine);
    if (!ensured.success) {
      return { success: false, error: ensured.error || "本地引擎不可用" };
    }
    return await this._sendPolishCommand(text, mode, onDelta);
  }

  // 串行化命令：单管道单进程，并发会串话/挂起。
  async _sendPolishCommand(text, mode, onDelta) {
    const run = () => this._sendPolishCommandImpl(text, mode, onDelta);
    const p = (this._cmdChain || Promise.resolve()).then(run, run);
    this._cmdChain = p.then(() => undefined, () => undefined);
    return p;
  }

  _sendPolishCommandImpl(text, mode, onDelta) {
    if (!this.serverProcess || !this.serverReady) {
      return Promise.resolve({ success: false, error: "LLM 服务器未就绪" });
    }
    const proc = this.serverProcess;
    this._cmdSeq += 1;
    const cmdId = `${Date.now()}-${this._cmdSeq}`;
    const command = { action: "polish", text, mode, id: cmdId };

    return new Promise((resolve) => {
      let done = false;
      let full = "";
      let buf = "";

      const cleanup = () => {
        try { proc.stdout.removeListener("data", onData); } catch (e) {}
        try { proc.stdin.removeListener("error", onStdinError); } catch (e) {}
        if (this._pendingStdinReject === settleReject) this._pendingStdinReject = null;
      };
      const settle = (result) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(result);
      };
      const settleReject = (err) => settle({ success: false, error: err && err.message ? err.message : String(err) });

      const onData = (data) => {
        if (done) return;
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch (e) { continue; }
          // 关联 id 校验（done/success 帧带 id；增量 d 帧不带 id，属于当前在途命令）
          if (typeof j.d === "string") {
            full += j.d;
            if (typeof onDelta === "function") {
              try { onDelta(j.d); } catch (e) {}
            }
            continue;
          }
          if (j.id !== undefined && j.id !== cmdId) continue; // 迟到/串话
          if (j.done === true) {
            const out = typeof j.text === "string" && j.text ? j.text : full;
            settle({ success: true, text: out });
            return;
          }
          if (j.success === false) {
            const failure = { success: false, error: j.error || "润色失败" };
            // 透传结构化失败原因（如 input_too_long），供上层给出明确提示。
            if (typeof j.reason === "string") failure.reason = j.reason;
            settle(failure);
            return;
          }
        }
      };

      const onStdinError = (error) => settleReject(new Error(`LLM 管道已关闭: ${error && error.message ? error.message : error}`));

      proc.stdout.on("data", onData);
      proc.stdin.on("error", onStdinError);
      this._pendingStdinReject = settleReject;

      try {
        proc.stdin.write(JSON.stringify(command) + "\n");
      } catch (writeErr) {
        settleReject(new Error(`LLM 命令写入失败: ${writeErr.message}`));
      }
    });
  }

  // ——— 下载（带进度、断点续传）———

  // 各引擎的下载状态：{ engine: { ready, downloading, bundled, progress } }。
  getModelsStatus() {
    const out = {};
    for (const key of Object.keys(LOCAL_ENGINES)) {
      out[key] = {
        ready: this.isModelReady(key),
        downloading: this._downloading.has(key),
        bundled: LOCAL_ENGINES[key].bundled,
        expectedSize: LOCAL_ENGINES[key].expectedSize,
        // 平台支持标记：win32+arm64 为 false，设置页据此隐藏「本地模型」选项。
        supported: LOCAL_LLM_SUPPORTED,
      };
    }
    return out;
  }

  // 下载指定引擎模型到用户数据目录（HF 直链，失败回退 ModelScope 镜像）。
  // progressCallback({ engine, downloaded, total, progress })。
  async downloadModel(engine, progressCallback = null) {
    if (!LOCAL_LLM_SUPPORTED) {
      // win32+arm64：不下 2.7GB 模型（推理依赖未打包，下了也用不了）。
      return { success: false, error: "本地模型暂不支持当前设备", code: "platform_unsupported" };
    }
    if (!this.isValidLocalEngine(engine)) {
      return { success: false, error: `无效引擎: ${engine}` };
    }
    const cfg = LOCAL_ENGINES[engine];
    if (cfg.bundled) {
      return { success: true, message: "内置模型无需下载" };
    }
    if (this.isModelReady(engine)) {
      return { success: true, message: "模型已存在" };
    }
    if (this._downloading.has(engine)) {
      return { success: false, error: "该模型正在下载中" };
    }

    this._downloading.add(engine);
    const dir = this.getUserModelsDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this._downloading.delete(engine);
      return { success: false, error: `创建模型目录失败: ${e.message}` };
    }
    const dest = this.getModelPath(engine);
    const tmp = `${dest}.part`;

    // 磁盘空间检查（跨平台，statfsSync 对目录在 mac/win 均可用）：
    // 剩余需下载体量 + 10% 余量不足则直接失败，避免下到一半写满盘。
    // statfs 不可用（老 Node/异常）时跳过检查，不阻断下载。
    try {
      const already = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      const needBytes = Math.max(0, cfg.expectedSize - already) * 1.1;
      const st = fs.statfsSync(dir);
      const freeBytes = st.bavail * st.bsize;
      if (freeBytes < needBytes) {
        this._downloading.delete(engine);
        const needGB = (needBytes / 1024 / 1024 / 1024).toFixed(1);
        const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
        return { success: false, error: `磁盘空间不足：需约 ${needGB}GB，剩余 ${freeGB}GB` };
      }
    } catch (e) {
      this.logger.warn && this.logger.warn("模型下载磁盘检查跳过", e?.message || e);
    }

    // 主通道：国内镜像 hf-mirror.com（resolve/main）
    const hfUrl = `${HF_BASE}/${cfg.repo}/resolve/main/${cfg.fileName}`;
    // ModelScope 镜像路径：models/<repo>/resolve/master/<file>
    const msUrl = `${MODELSCOPE_BASE}/${cfg.repo}/resolve/master/${cfg.fileName}`;

    try {
      await this._downloadWithResume(hfUrl, tmp, cfg.expectedSize, (p) => {
        if (progressCallback) progressCallback({ engine, ...p });
      }).catch(async (hfErr) => {
        this.logger.warn && this.logger.warn("hf-mirror 下载失败，回退 ModelScope", hfErr.message);
        await this._downloadWithResume(msUrl, tmp, cfg.expectedSize, (p) => {
          if (progressCallback) progressCallback({ engine, ...p });
        });
      });

      // 校验大小后原子改名
      const stats = fs.statSync(tmp);
      if (stats.size < cfg.expectedSize * 0.98) {
        throw new Error(`下载不完整: ${stats.size}/${cfg.expectedSize}`);
      }
      fs.renameSync(tmp, dest);
      this._downloading.delete(engine);
      return { success: true, message: "下载完成", path: dest };
    } catch (error) {
      this._downloading.delete(engine);
      this.logger.error && this.logger.error("模型下载失败", error);
      return { success: false, error: error.message };
    }
  }

  // 单文件下载，支持断点续传（Range）与进度回调。
  _downloadWithResume(url, tmpPath, totalHint, onProgress) {
    return new Promise((resolve, reject) => {
      let startAt = 0;
      try {
        startAt = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      } catch (e) {
        startAt = 0;
      }

      const headers = {};
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;

      const req = https.get(url, { headers }, (res) => {
        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return this._downloadWithResume(res.headers.location, tmpPath, totalHint, onProgress)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        // 206 表示续传成功，否则从头写
        const append = res.statusCode === 206 && startAt > 0;
        if (!append) startAt = 0;

        const total = append
          ? startAt + parseInt(res.headers["content-length"] || "0", 10)
          : parseInt(res.headers["content-length"] || String(totalHint), 10) || totalHint;

        const file = fs.createWriteStream(tmpPath, { flags: append ? "a" : "w" });
        let downloaded = startAt;
        let lastEmit = 0;

        res.on("data", (chunk) => {
          downloaded += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastEmit > 300) {
            lastEmit = now;
            const progress = total ? Math.min(100, (downloaded / total) * 100) : 0;
            onProgress({ downloaded, total, progress: Math.round(progress * 10) / 10 });
          }
        });

        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            if (onProgress) {
              const total2 = total || downloaded;
              onProgress({ downloaded, total: total2, progress: 100 });
            }
            resolve();
          });
        });
        file.on("error", (err) => reject(err));
      });
      req.on("error", (err) => reject(err));
    });
  }
}

module.exports = LLMManager;
module.exports.LOCAL_ENGINES = LOCAL_ENGINES;
module.exports.DEFAULT_LOCAL_ENGINE = DEFAULT_LOCAL_ENGINE;
