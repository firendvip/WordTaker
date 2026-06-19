import XCTest
@testable import WordTaker

/// Stub URLProtocol that returns a canned response/body for any request.
final class StubURLProtocol: URLProtocol {
    /// Handler returns (statusCode, body) for a given request, or throws.
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class PolishServiceTests: XCTestCase {
    private func makeService() -> PolishService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return PolishService(session: URLSession(configuration: config))
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testReturnsPolishedTextOnSuccess() async throws {
        // Arrange
        StubURLProtocol.handler = { _ in
            let body = #"{"success":true,"text":"润色后的文本"}"#.data(using: .utf8)!
            return (200, body)
        }
        let service = makeService()

        // Act
        let result = try await service.polish("原始文本")

        // Assert
        XCTAssertEqual(result, "润色后的文本")
    }

    func testThrowsEmptyInputForBlankText() async {
        // Arrange
        let service = makeService()

        // Act / Assert
        do {
            _ = try await service.polish("   ")
            XCTFail("Expected emptyInput error")
        } catch let error as PolishError {
            guard case .emptyInput = error else {
                return XCTFail("Expected emptyInput, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testThrowsServerErrorOnNon2xx() async {
        // Arrange
        StubURLProtocol.handler = { _ in
            let body = #"{"success":false,"error":"Unauthorized"}"#.data(using: .utf8)!
            return (401, body)
        }
        let service = makeService()

        // Act / Assert
        do {
            _ = try await service.polish("文本")
            XCTFail("Expected server error")
        } catch let error as PolishError {
            guard case let .server(status, message) = error else {
                return XCTFail("Expected server error, got \(error)")
            }
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "Unauthorized")
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testThrowsRelayFailureWhenSuccessFalseWith200() async {
        // Arrange
        StubURLProtocol.handler = { _ in
            let body = #"{"success":false,"error":"Empty completion"}"#.data(using: .utf8)!
            return (200, body)
        }
        let service = makeService()

        // Act / Assert
        do {
            _ = try await service.polish("文本")
            XCTFail("Expected relayReportedFailure")
        } catch let error as PolishError {
            guard case let .relayReportedFailure(message) = error else {
                return XCTFail("Expected relayReportedFailure, got \(error)")
            }
            XCTAssertEqual(message, "Empty completion")
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testThrowsInvalidResponseOnMalformedJSON() async {
        // Arrange
        StubURLProtocol.handler = { _ in (200, Data("not json".utf8)) }
        let service = makeService()

        // Act / Assert
        do {
            _ = try await service.polish("文本")
            XCTFail("Expected invalidResponse")
        } catch let error as PolishError {
            guard case .invalidResponse = error else {
                return XCTFail("Expected invalidResponse, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testSendsRequiredHeadersAndBody() async throws {
        // Arrange
        nonisolated(unsafe) var captured: URLRequest?
        StubURLProtocol.handler = { request in
            captured = request
            let body = #"{"success":true,"text":"ok"}"#.data(using: .utf8)!
            return (200, body)
        }
        let service = makeService()

        // Act
        _ = try await service.polish("你好")

        // Assert
        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-App-Token"), RelayConfig.appToken)
        XCTAssertFalse(
            (request.value(forHTTPHeaderField: "X-Device-Id") ?? "").isEmpty,
            "X-Device-Id header must be present"
        )
    }
}
