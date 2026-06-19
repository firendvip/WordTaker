import SwiftUI

/// Main dictation screen: a large record button, live/result text, a copy
/// action, and a polish on/off toggle.
struct ContentView: View {
    @StateObject private var viewModel = DictationViewModel()
    @State private var didCopy = false

    var body: some View {
        ZStack {
            backgroundGradient.ignoresSafeArea()

            VStack(spacing: 28) {
                header
                resultCard
                Spacer(minLength: 0)
                statusLine
                RecordButton(isRecording: viewModel.isRecording) {
                    Task { await viewModel.toggleRecording() }
                }
                .padding(.bottom, 8)
            }
            .padding(24)
        }
        .onReceive(viewModel.recognizer.$transcript) { _ in
            viewModel.syncLiveTranscript()
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: 6) {
            Text("WordTaker")
                .font(.system(size: 34, weight: .bold, design: .rounded))
            Text("说中文 · 实时转写 · 智能润色")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var resultCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Toggle(isOn: $viewModel.isPolishEnabled) {
                Label("智能润色", systemImage: "wand.and.stars")
                    .font(.callout.weight(.medium))
            }
            .tint(.accentColor)
            // 部署目标是 iOS 16，必须用单参数 onChange（双参数为 iOS 17+ API）。
            .onChange(of: viewModel.isPolishEnabled) { enabled in
                if enabled, viewModel.polishedText.isEmpty, !viewModel.rawText.isEmpty {
                    Task { await viewModel.polishCurrentText() }
                }
            }

            Divider()

            ScrollView {
                Text(displayedText)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(viewModel.displayText.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
            }
            .frame(minHeight: 140, maxHeight: 220)

            if let notice = viewModel.fallbackNotice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            copyButton
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(.white.opacity(0.08))
        )
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = viewModel.displayText
            didCopy = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { didCopy = false }
        } label: {
            Label(didCopy ? "已复制" : "复制",
                  systemImage: didCopy ? "checkmark.circle.fill" : "doc.on.doc")
                .font(.callout.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
        .buttonStyle(.bordered)
        .tint(didCopy ? .green : .accentColor)
        .disabled(viewModel.displayText.isEmpty)
    }

    private var statusLine: some View {
        Text(statusText)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(height: 18)
            .multilineTextAlignment(.center)
    }

    // MARK: - Derived UI

    private var displayedText: String {
        viewModel.displayText.isEmpty ? "点按下方按钮开始说话…" : viewModel.displayText
    }

    private var statusText: String {
        switch viewModel.phase {
        case .idle: return "准备就绪"
        case .requestingPermission: return "正在请求权限…"
        case .recording: return "正在聆听…再次点按结束"
        case .polishing: return "正在润色…"
        case .done: return "完成"
        case let .failed(message): return message
        }
    }

    private var backgroundGradient: LinearGradient {
        LinearGradient(
            colors: [Color(red: 0.06, green: 0.07, blue: 0.12),
                     Color(red: 0.10, green: 0.12, blue: 0.20)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

/// Big circular record button with an animated recording state.
private struct RecordButton: View {
    let isRecording: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(isRecording ? Color.red.opacity(0.9) : Color.accentColor)
                    .frame(width: 96, height: 96)
                    .shadow(color: (isRecording ? Color.red : Color.accentColor).opacity(0.5),
                            radius: 24, y: 8)

                Image(systemName: isRecording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isRecording ? "停止录音" : "开始录音")
    }
}

#Preview {
    ContentView()
}
