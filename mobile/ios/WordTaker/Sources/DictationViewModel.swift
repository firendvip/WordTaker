import Foundation
import SwiftUI

/// High-level phases of the dictation flow, used to drive UI state.
enum DictationPhase: Equatable {
    case idle
    case requestingPermission
    case recording
    case polishing
    case done
    case failed(message: String)
}

/// Orchestrates the full flow: permissions → record + transcribe (zh-CN) →
/// polish via relay → present result. Falls back to the raw transcript when the
/// relay call fails so the user never loses their text.
@MainActor
final class DictationViewModel: ObservableObject {
    @Published private(set) var phase: DictationPhase = .idle
    /// The latest raw transcript from speech recognition.
    @Published private(set) var rawText: String = ""
    /// The polished result from the relay (empty until polishing completes).
    @Published private(set) var polishedText: String = ""
    /// Whether polishing is enabled. When off, raw text is shown/used directly.
    @Published var isPolishEnabled: Bool = true
    /// Set when polish failed and we fell back to raw, for a non-blocking note.
    @Published private(set) var fallbackNotice: String?

    let recognizer: SpeechRecognizer
    private let polishService: PolishService
    private let draftStore: SharedDraftStore

    init(recognizer: SpeechRecognizer = SpeechRecognizer(),
         polishService: PolishService = PolishService(),
         draftStore: SharedDraftStore = SharedDraftStore()) {
        self.recognizer = recognizer
        self.polishService = polishService
        self.draftStore = draftStore
    }

    /// The text the user should see / copy, respecting the polish toggle.
    var displayText: String {
        if isPolishEnabled, !polishedText.isEmpty {
            return polishedText
        }
        return rawText
    }

    var isRecording: Bool { recognizer.isRecording }

    /// Toggles recording. Requests permissions on first record.
    func toggleRecording() async {
        if recognizer.isRecording {
            await finishRecording()
        } else {
            await beginRecording()
        }
    }

    private func beginRecording() async {
        fallbackNotice = nil
        polishedText = ""
        rawText = ""
        phase = .requestingPermission

        do {
            try await recognizer.requestAuthorization()
            try recognizer.startRecording()
            phase = .recording
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    private func finishRecording() async {
        recognizer.stopRecording()
        rawText = recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !rawText.isEmpty else {
            phase = .failed(message: "没有识别到内容，请重试")
            return
        }

        guard isPolishEnabled else {
            draftStore.save(rawText)
            phase = .done
            return
        }

        await polishCurrentText()
    }

    /// Polishes the current raw text, falling back to raw on failure.
    func polishCurrentText() async {
        guard !rawText.isEmpty else { return }
        phase = .polishing
        do {
            polishedText = try await polishService.polish(rawText)
            fallbackNotice = nil
            draftStore.save(polishedText)
            phase = .done
        } catch {
            // Graceful fallback: keep the raw transcript, surface a soft notice.
            polishedText = ""
            fallbackNotice = "润色失败，已显示原始文本：\(error.localizedDescription)"
            draftStore.save(rawText)
            phase = .done
        }
    }

    /// Keeps the live transcript in sync while recording.
    func syncLiveTranscript() {
        rawText = recognizer.transcript
    }
}
