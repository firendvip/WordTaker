import Foundation

/// Configuration for the self-hosted polish relay.
///
/// IMPORTANT: This file contains ONLY the public relay URL and the app access
/// token. The real DeepSeek API key lives server-side in the relay and is never
/// shipped to the client. Do NOT add any DeepSeek key here.
enum RelayConfig {
    /// Relay endpoint. Client sends only `{ text, mode }`; the relay adds the
    /// DeepSeek key server-side and returns the polished text.
    static let endpoint: URL = {
        guard let url = URL(string: "https://1311262545-3ihll1gdlf.ap-guangzhou.tencentscf.com") else {
            // 配置错误（如改 URL 时打错字）应在开发期立刻暴露，而不是给每个用户一次启动崩溃
            preconditionFailure("RelayConfig.endpoint 不是合法 URL，请检查配置")
        }
        return url
    }()

    /// Access token used by the relay to gate requests. Rotatable server-side.
    static let appToken = "64caa0fbd432f49a65269be31e581b19aceab557205b7b24"

    /// Polish mode understood by the relay.
    static let mode = "copywriting"

    /// Network timeout for relay calls, in seconds.
    static let requestTimeout: TimeInterval = 10

    /// App Group identifier shared between the host app and the keyboard
    /// extension. Update this in `project.yml` entitlements if you change it.
    static let appGroupIdentifier = "group.com.wordtaker.shared"

    /// Speech recognition locale.
    static let speechLocaleIdentifier = "zh-CN"
}
