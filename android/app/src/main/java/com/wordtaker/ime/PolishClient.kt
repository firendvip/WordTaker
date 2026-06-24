package com.wordtaker.ime

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Optional: POST recognized text to the existing WordTaker relay (Tencent SCF) which proxies
 * DeepSeek and keeps the API key server-side. Mirrors the Electron client request shape:
 *   POST {RELAY_URL}  body {"text","mode"}  header X-App-Token.
 *
 * DISABLED by default (see WordTakerImeService.POLISH_ENABLED). Core recognize+commit must work
 * without this. The relay token below is the same low-privilege relay token used by the desktop
 * app; rotate it if this repo is published.
 *
 * TODO: make relay URL / token / enable-toggle user-configurable in SetupActivity, and add
 *       streaming support (the relay accepts {"stream": true}).
 */
object PolishClient {

    private const val RELAY_URL =
        "https://1311262545-3ihll1gdlf.ap-guangzhou.tencentscf.com"
    private const val RELAY_TOKEN =
        "64caa0fbd432f49a65269be31e581b19aceab557205b7b24"

    /** Returns polished text, or the original on any failure (never throws to the caller). */
    fun polish(text: String, mode: String = "copywriting"): String {
        if (text.isBlank()) return text
        return try {
            val conn = (URL(RELAY_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-App-Token", RELAY_TOKEN)
            }
            val body = JSONObject().put("text", text).put("mode", mode).toString()
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode !in 200..299) return text
            val resp = conn.inputStream.bufferedReader().use { it.readText() }
            // Relay returns the polished string; tolerate either raw text or a JSON envelope.
            parsePolished(resp) ?: text
        } catch (e: Exception) {
            text
        }
    }

    private fun parsePolished(resp: String): String? {
        val trimmed = resp.trim()
        if (!trimmed.startsWith("{")) return trimmed.ifBlank { null }
        return try {
            val obj = JSONObject(trimmed)
            (obj.optString("text").ifBlank { obj.optString("result") }).ifBlank { null }
        } catch (e: Exception) {
            trimmed
        }
    }
}
