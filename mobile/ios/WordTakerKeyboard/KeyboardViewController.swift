import UIKit

/// Custom keyboard for WordTaker.
///
/// Inserts transcribed + polished text into the focused field via
/// `textDocumentProxy.insertText(...)`.
///
/// MICROPHONE LIMITATION (documented in STATUS.md):
/// Apple heavily restricts microphone capture and networking inside keyboard
/// extensions. Reliable live mic capture in a keyboard is not supported and may
/// be rejected by App Review. The supported, robust path is:
///   1. Capture + transcribe + polish in the HOST APP.
///   2. Share the result via the App Group (see ``SharedDraftStore``).
///   3. The keyboard reads the latest shared draft and inserts it.
/// This controller implements that App-Group handoff. The in-keyboard mic
/// button attempts a best-effort capture only when Full Access is granted;
/// otherwise it routes the user to the host app.
final class KeyboardViewController: UIInputViewController {

    private let draftStore = SharedDraftStore()
    private var statusLabel: UILabel!
    private var insertButton: UIButton!
    private var draftPreview: UILabel!

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        refreshDraft()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshDraft()
    }

    // MARK: - UI

    private func buildUI() {
        view.backgroundColor = UIColor.secondarySystemBackground

        let title = UILabel()
        title.text = "WordTaker 键盘"
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = .label

        draftPreview = UILabel()
        draftPreview.numberOfLines = 2
        draftPreview.font = .systemFont(ofSize: 14)
        draftPreview.textColor = .secondaryLabel
        draftPreview.text = "暂无可插入的文本"

        insertButton = makeButton(title: "插入最新文本", action: #selector(insertLatestDraft))
        let micButton = makeButton(title: "录音（打开主 App）", action: #selector(handleMicTapped))
        let refreshButton = makeButton(title: "刷新", action: #selector(refreshDraft))
        let nextKeyboard = makeButton(title: "🌐", action: #selector(advanceToNextInputMode))

        statusLabel = UILabel()
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .tertiaryLabel
        statusLabel.numberOfLines = 2
        statusLabel.text = hasFullAccess
            ? "已开启完全访问权限"
            : "提示：开启「允许完全访问」后才能联网与读取共享草稿"

        let actionRow = UIStackView(arrangedSubviews: [insertButton, refreshButton])
        actionRow.axis = .horizontal
        actionRow.spacing = 8
        actionRow.distribution = .fillEqually

        let bottomRow = UIStackView(arrangedSubviews: [nextKeyboard, micButton])
        bottomRow.axis = .horizontal
        bottomRow.spacing = 8

        let stack = UIStackView(arrangedSubviews: [title, draftPreview, actionRow, bottomRow, statusLabel])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -10)
        ])
    }

    private func makeButton(title: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        button.backgroundColor = UIColor.systemBackground
        button.layer.cornerRadius = 10
        button.contentEdgeInsets = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    // MARK: - Actions

    /// Inserts the most recent shared draft into the focused field.
    @objc private func insertLatestDraft() {
        guard hasFullAccess else {
            statusLabel.text = "需要「允许完全访问」才能读取共享草稿"
            return
        }
        guard let draft = draftStore.latestDraft, !draft.isEmpty else {
            statusLabel.text = "没有可插入的文本，请先在主 App 录音"
            return
        }
        textDocumentProxy.insertText(draft)
        statusLabel.text = "已插入文本"
    }

    // Note: `hasFullAccess` is inherited from `UIInputViewController` and
    // reflects whether the user enabled "Allow Full Access". It is required for
    // networking and reading the App Group container from the keyboard.

    /// In-keyboard mic is restricted by Apple. Direct the user to the host app
    /// where capture is reliable, then return and insert the shared draft.
    @objc private func handleMicTapped() {
        statusLabel.text = "键盘内麦克风受 Apple 限制，请在主 App 录音后返回点「插入最新文本」"
    }

    @objc private func refreshDraft() {
        guard hasFullAccess else {
            draftPreview.text = "需开启完全访问后才能读取共享草稿"
            return
        }
        let draft = draftStore.latestDraft
        draftPreview.text = (draft?.isEmpty == false) ? draft : "暂无可插入的文本"
        insertButton.isEnabled = (draft?.isEmpty == false)
    }
}
