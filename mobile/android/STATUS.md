# WordTaker Android — Build Status

## Summary

**`./gradlew assembleDebug` SUCCEEDED.** A real debug APK was produced.

- **APK path:** `app/build/outputs/apk/debug/app-debug.apk`
- **Size:** ~6.4 MB
- **Package:** `com.wordtaker.keyboard` (versionCode 1, versionName 1.0)
- **Verified via `aapt dump badging`:** launchable `MainActivity` present; `INTERNET` + `RECORD_AUDIO` permissions present.

Nothing is blocked. The project compiles end-to-end from the command line and also opens cleanly in Android Studio.

---

## What WordTaker (Android) does

Speak Chinese → transcribe → (optionally) polish via the self-hosted relay → insert text.

Desktop WordTaker uses local FunASR for ASR, which cannot run on Android, so this
version uses **Android's built-in `android.speech.SpeechRecognizer`** (configured
for `zh-CN`). The DeepSeek key is never on the client — polishing is delegated to
the existing self-hosted relay, which holds the key server-side.

---

## Architecture

Kotlin + Android Gradle Plugin. Min SDK 26, target/compile SDK 34.

### Source (`app/src/main/java/com/wordtaker/keyboard/`)

| File | Responsibility |
|------|----------------|
| `Prefs.kt` | Persists the "polish on/off" toggle and a stable per-install random `X-Device-Id`. |
| `RelayClient.kt` | OkHttp POST to the relay. Builds JSON body, sets headers, 10s timeouts, length cap, error handling. Returns `RelayResult.Success`/`Failure`. **Only the relay URL + public `X-App-Token` live here — no DeepSeek key.** |
| `SpeechController.kt` | Wraps `SpeechRecognizer` for `zh-CN`. Single-fire `SpeechOutcome` (Recognized / NoSpeech / Error) plus optional partial-results callback. Checks `isRecognitionAvailable`. |
| `WordTakerInputMethodService.kt` | The custom keyboard (IME). Mic button → transcribe → polish (if on) → `currentInputConnection.commitText(...)`. In-keyboard polish toggle, space/backspace/enter keys. **Graceful fallback to raw text if the relay fails** (never loses the user's words). |
| `MainActivity.kt` | Launcher Activity. Enable-keyboard link (system IME settings) + input-method picker; full test flow (record → transcribe → polish → show result + copy to clipboard); runtime `RECORD_AUDIO` permission request; status display. |

### Key resources (`app/src/main/res/`)

- `xml/method.xml` — IME metadata (zh_CN subtype, settings activity = MainActivity).
- `layout/keyboard_view.xml` — keyboard UI: big mic button, polish toggle, space/backspace/enter, status line.
- `layout/activity_main.xml` — setup + test UI with polish `Switch`.
- `mipmap-anydpi-v26/ic_launcher*.xml` + `drawable/ic_launcher_*` — adaptive launcher icon (mic glyph). Min SDK 26 means anydpi-v26 covers every device.
- `values/{strings,colors,themes}.xml` — Material3 DayNight theme.

`AndroidManifest.xml` declares the launcher Activity, the IME `<service>` with
`BIND_INPUT_METHOD`, `INTERNET` + `RECORD_AUDIO` permissions, and a `<queries>`
entry so `SpeechRecognizer` can resolve a recognition service on Android 11+.

### Relay contract (implemented in `RelayClient.kt`)

```
POST https://1311262545-3ihll1gdlf.ap-guangzhou.tencentscf.com
Content-Type: application/json
X-App-Token: 64caa0fbd432f49a65269be31e581b19aceab557205b7b24
X-Device-Id: <persistent random UUID per install>

{ "text": "...", "mode": "copywriting" }
```

Expected response: `{ "success": true, "text": "polished" }`. Non-streaming,
10s timeouts, 4000-char input cap. Any non-2xx / malformed / network error →
`Failure` → caller falls back to the raw transcription.

---

## Toolchain / versions

- JDK 17 (`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`)
- Android Gradle Plugin **8.7.3**, Kotlin **1.9.25**
- Gradle **wrapper 8.11.1** (pinned via the wrapper; do not rely on the host's
  newer Gradle 9.x — AGP 8.7 targets Gradle 8.x).
- Android SDK: `platform-tools`, `platforms;android-34`, `build-tools;34.0.0`
  installed under `~/Library/Android/sdk`.

Dependencies: androidx core-ktx, appcompat, material, constraintlayout,
kotlinx-coroutines-android, okhttp.

---

## Exact build commands

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"

# One-time SDK setup (already done in this environment):
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-34" "build-tools;34.0.0"

cd "mobile/android"
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` already contains `sdk.dir=/Users/Admin/Library/Android/sdk`.
Update that line if the SDK lives elsewhere. Opening `mobile/android` in Android
Studio and pressing Run also works (one click).

---

## Run it on a device

1. Enable USB debugging on an Android phone (API 26+) and connect it.
2. Install:
   ```bash
   "$ANDROID_HOME/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Open the **WordTaker** app.
   - Tap **Enable WordTaker Keyboard** → toggle it on in system settings.
   - Tap **Test: Record → Polish**, grant the mic permission, speak Chinese.
     You'll see the transcription, then the polished result, with a Copy button.
4. To use the keyboard anywhere: tap **Choose Input Method** → pick WordTaker,
   focus any text field, tap the mic, speak. Text is committed into the field.
   Use the in-keyboard **Polish: ON/OFF** key to switch raw vs. polished.

### Notes / caveats (honest)

- `SpeechRecognizer` requires an on-device recognition service (e.g. Google
  app / Google speech services). Most phones have one; bare AOSP emulators may
  not. The code checks `isRecognitionAvailable()` and shows a clear message if
  absent. The launcher Activity's test flow exists precisely so the app stays
  usable even where IME-context mic permissions are awkward.
- Speech recognition itself may use Google's cloud service depending on the
  device; that is the platform recognizer, independent of our relay. The relay
  is only used for the polishing step.
