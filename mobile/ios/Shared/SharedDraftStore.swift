import Foundation

/// Shares the latest dictated/polished text between the host app and the
/// keyboard extension via the App Group. This is the supported way to get mic
/// content into a keyboard, given Apple's restrictions on in-keyboard capture.
struct SharedDraftStore {
    private let draftKey = "wordtaker.shared.draft"
    private let updatedAtKey = "wordtaker.shared.draft.updatedAt"

    private var defaults: UserDefaults {
        UserDefaults(suiteName: RelayConfig.appGroupIdentifier) ?? .standard
    }

    /// The most recently saved draft, or nil if none.
    var latestDraft: String? {
        defaults.string(forKey: draftKey)
    }

    /// When the latest draft was saved.
    var lastUpdated: Date? {
        let interval = defaults.double(forKey: updatedAtKey)
        return interval > 0 ? Date(timeIntervalSince1970: interval) : nil
    }

    /// Persists a new draft for the keyboard to read.
    func save(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        defaults.set(trimmed, forKey: draftKey)
        defaults.set(Date().timeIntervalSince1970, forKey: updatedAtKey)
    }

    /// Clears the stored draft.
    func clear() {
        defaults.removeObject(forKey: draftKey)
        defaults.removeObject(forKey: updatedAtKey)
    }
}
