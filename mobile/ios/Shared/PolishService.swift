import Foundation

/// Errors surfaced by ``PolishService``. UI layers map these to user-facing
/// messages and fall back to raw transcription text when polish fails.
enum PolishError: LocalizedError {
    case emptyInput
    case invalidResponse
    case server(status: Int, message: String?)
    case relayReportedFailure(message: String?)
    case timedOut
    case transport(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .emptyInput:
            return "没有可润色的文本"
        case .invalidResponse:
            return "服务器返回了无法解析的内容"
        case let .server(status, message):
            return message ?? "服务器错误 (\(status))"
        case let .relayReportedFailure(message):
            return message ?? "润色服务返回失败"
        case .timedOut:
            return "请求超时，请检查网络后重试"
        case let .transport(underlying):
            return underlying.localizedDescription
        }
    }
}

/// Request body sent to the relay. Only `text` and `mode` are transmitted.
private struct PolishRequest: Encodable {
    let text: String
    let mode: String
}

/// Relay response envelope: `{ "success": true, "text": "..." }` or
/// `{ "success": false, "error": "..." }`.
private struct PolishResponse: Decodable {
    let success: Bool
    let text: String?
    let error: String?
}

/// Calls the self-hosted relay to polish Chinese text via DeepSeek.
///
/// The relay holds the DeepSeek key server-side; the client only ever sends the
/// text to polish. Uses async/await with a 10s timeout and explicit error
/// handling so callers can gracefully fall back to the raw transcription.
struct PolishService {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = RelayConfig.requestTimeout
            configuration.timeoutIntervalForResource = RelayConfig.requestTimeout
            configuration.waitsForConnectivity = false
            self.session = URLSession(configuration: configuration)
        }
    }

    /// Polishes the given text. Returns the polished string on success.
    /// Throws ``PolishError`` on any failure so the caller can fall back to raw.
    func polish(_ rawText: String) async throws -> String {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw PolishError.emptyInput }

        let request = try makeRequest(text: trimmed)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw PolishError.timedOut
        } catch {
            throw PolishError.transport(underlying: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw PolishError.invalidResponse
        }

        let decoded = try decode(data)

        guard (200...299).contains(http.statusCode) else {
            throw PolishError.server(status: http.statusCode, message: decoded.error)
        }

        guard decoded.success, let polished = decoded.text, !polished.isEmpty else {
            throw PolishError.relayReportedFailure(message: decoded.error)
        }

        return polished
    }

    // MARK: - Helpers

    private func makeRequest(text: String) throws -> URLRequest {
        var request = URLRequest(url: RelayConfig.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = RelayConfig.requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(RelayConfig.appToken, forHTTPHeaderField: "X-App-Token")
        request.setValue(DeviceIdentity.current, forHTTPHeaderField: "X-Device-Id")
        request.httpBody = try JSONEncoder().encode(
            PolishRequest(text: text, mode: RelayConfig.mode)
        )
        return request
    }

    private func decode(_ data: Data) throws -> PolishResponse {
        do {
            return try JSONDecoder().decode(PolishResponse.self, from: data)
        } catch {
            throw PolishError.invalidResponse
        }
    }
}
