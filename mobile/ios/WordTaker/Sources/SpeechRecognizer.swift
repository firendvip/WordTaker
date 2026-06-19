import Foundation
import Speech
import AVFoundation

/// Errors surfaced by ``SpeechRecognizer``.
enum SpeechRecognizerError: LocalizedError {
    case notAuthorized
    case micNotAuthorized
    case recognizerUnavailable
    case audioEngineFailure(underlying: Error)
    case requestCreationFailed

    var errorDescription: String? {
        switch self {
        case .notAuthorized:
            return "未获得语音识别权限，请在系统设置中开启"
        case .micNotAuthorized:
            return "未获得麦克风权限，请在系统设置中开启"
        case .recognizerUnavailable:
            return "当前设备暂不支持中文语音识别"
        case let .audioEngineFailure(underlying):
            return "录音启动失败：\(underlying.localizedDescription)"
        case .requestCreationFailed:
            return "无法创建语音识别请求"
        }
    }
}

/// Wraps Apple's on-device Speech framework for zh-CN dictation.
///
/// On-device ASR replaces the desktop's local FunASR, which cannot run on iOS.
/// Publishes a live partial transcript and reports the final transcript when
/// recording stops.
@MainActor
final class SpeechRecognizer: NSObject, ObservableObject {
    /// Live transcript updated as the user speaks.
    @Published private(set) var transcript: String = ""
    /// Whether audio capture is currently active.
    @Published private(set) var isRecording: Bool = false

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// 跟踪输入节点 tap 是否已安装：未配对的 installTap/removeTap 会触发
    /// AVAudioNodeTapNotEmpty 崩溃，必须独立于 engine.isRunning 精确管理。
    private var isTapInstalled = false

    override init() {
        let locale = Locale(identifier: RelayConfig.speechLocaleIdentifier)
        self.recognizer = SFSpeechRecognizer(locale: locale)
        super.init()
    }

    /// Requests speech + microphone permissions. Throws if either is denied.
    func requestAuthorization() async throws {
        let speechStatus = await Self.requestSpeechAuthorization()
        guard speechStatus == .authorized else { throw SpeechRecognizerError.notAuthorized }

        let micGranted = await Self.requestMicrophoneAuthorization()
        guard micGranted else { throw SpeechRecognizerError.micNotAuthorized }
    }

    /// Starts capturing audio and producing a live transcript.
    func startRecording() throws {
        guard let recognizer, recognizer.isAvailable else {
            throw SpeechRecognizerError.recognizerUnavailable
        }

        // Reset any prior session before starting a new one.
        reset()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Prefer on-device recognition when the device supports it.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        do {
            try configureAudioSession()
        } catch {
            throw SpeechRecognizerError.audioEngineFailure(underlying: error)
        }

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        isTapInstalled = true

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            removeTapIfNeeded()
            deactivateAudioSession() // 失败也要释放音频会话，否则会一直压低其它 App 的声音
            throw SpeechRecognizerError.audioEngineFailure(underlying: error)
        }

        isRecording = true
        transcript = ""

        // 识别回调在后台线程触发；self 是 @MainActor 隔离对象，所有对它的读写
        // 都必须在主 actor 内进行，故先 hop 到主 actor 再 guard self，避免数据竞争。
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self.stopRecording()
                }
            }
        }
    }

    /// Stops capture and finalizes the transcript.
    func stopRecording() {
        // 即使 isRecording 已为 false，只要 tap 还在就必须清理，避免 tap 泄漏后再次
        // installTap 崩溃。
        guard isRecording || audioEngine.isRunning || isTapInstalled else { return }
        if audioEngine.isRunning { audioEngine.stop() }
        removeTapIfNeeded()
        request?.endAudio()
        task?.finish()
        isRecording = false
        deactivateAudioSession()
    }

    // MARK: - Private

    private func removeTapIfNeeded() {
        guard isTapInstalled else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        isTapInstalled = false
    }

    private func reset() {
        task?.cancel()
        task = nil
        request = nil
        if audioEngine.isRunning { audioEngine.stop() }
        removeTapIfNeeded()
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private static func requestMicrophoneAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }
}
