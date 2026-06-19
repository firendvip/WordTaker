import Foundation

/// Provides a persistent, random device identifier sent to the relay as
/// `X-Device-Id`. The id is generated once and stored in the shared App Group
/// defaults so the host app and keyboard extension report the same value.
enum DeviceIdentity {
    private static let storageKey = "wordtaker.device.id"

    /// Shared defaults backed by the App Group, falling back to standard
    /// defaults if the App Group is not configured (e.g. during early dev).
    private static var defaults: UserDefaults {
        UserDefaults(suiteName: RelayConfig.appGroupIdentifier) ?? .standard
    }

    /// A stable random identifier for this install. Created on first access.
    /// `static let` 闭包由 Swift 运行时加锁保证每进程只执行一次，消除进程内并发
    /// 同时生成两个 id 的竞态（跨 App Group 进程的竞态对限流用途可接受）。
    static let current: String = {
        if let existing = defaults.string(forKey: storageKey), !existing.isEmpty {
            return existing
        }
        let generated = UUID().uuidString
        defaults.set(generated, forKey: storageKey)
        return generated
    }()
}
