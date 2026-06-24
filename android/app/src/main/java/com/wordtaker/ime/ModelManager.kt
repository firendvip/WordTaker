package com.wordtaker.ime

import android.content.Context
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Resolves, downloads (first run) and extracts the SenseVoice model into the app files dir.
 *
 * Model: sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 (~226MB download).
 * Source: github.com/k2-fsa/sherpa-onnx releases (asr-models tag).
 *
 * To BUNDLE the model later instead of downloading: drop model.int8.onnx + tokens.txt into
 * app/src/main/assets/<MODEL_DIR_NAME>/ and have the recognizer read from assets. The code here
 * is structured so swapping the source is a one-spot change (modelDir()).
 */
object ModelManager {

    private const val MODEL_DIR_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    const val MODEL_URL =
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" +
            "$MODEL_DIR_NAME.tar.bz2"

    const val MODEL_FILE = "model.int8.onnx"
    const val TOKENS_FILE = "tokens.txt"

    /** Directory where the extracted model lives. */
    fun modelDir(context: Context): File = File(context.filesDir, MODEL_DIR_NAME)

    fun modelPath(context: Context): String = File(modelDir(context), MODEL_FILE).absolutePath
    fun tokensPath(context: Context): String = File(modelDir(context), TOKENS_FILE).absolutePath

    fun isReady(context: Context): Boolean {
        val dir = modelDir(context)
        return File(dir, MODEL_FILE).exists() && File(dir, TOKENS_FILE).exists()
    }

    /** Progress callback for download (0..100) and a separate extracting flag. */
    interface ProgressListener {
        fun onDownloadProgress(percent: Int)
        fun onExtracting()
    }

    /**
     * Blocking download + extract. Run off the main thread. Throws on failure so the caller can
     * surface a real error instead of silently degrading.
     */
    @Throws(Exception::class)
    fun ensureModel(context: Context, listener: ProgressListener) {
        if (isReady(context)) return

        val archive = File(context.cacheDir, "$MODEL_DIR_NAME.tar.bz2")
        download(MODEL_URL, archive, listener)

        listener.onExtracting()
        extractTarBz2(archive, context.filesDir)
        archive.delete()

        if (!isReady(context)) {
            throw IllegalStateException("解压后未找到模型文件，请清缓存重试")
        }
    }

    private fun download(urlStr: String, dest: File, listener: ProgressListener) {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        conn.connect()
        if (conn.responseCode !in 200..299) {
            throw IllegalStateException("下载失败 HTTP ${conn.responseCode}")
        }
        val total = conn.contentLengthLong
        conn.inputStream.use { input ->
            FileOutputStream(dest).use { out ->
                val buf = ByteArray(64 * 1024)
                var read: Int
                var done = 0L
                var lastPct = -1
                while (input.read(buf).also { read = it } != -1) {
                    out.write(buf, 0, read)
                    done += read
                    if (total > 0) {
                        val pct = ((done * 100) / total).toInt()
                        if (pct != lastPct) {
                            lastPct = pct
                            listener.onDownloadProgress(pct)
                        }
                    }
                }
            }
        }
        conn.disconnect()
    }

    private fun extractTarBz2(archive: File, outDir: File) {
        TarArchiveInputStream(BZip2CompressorInputStream(archive.inputStream().buffered())).use { tar ->
            var entry = tar.nextTarEntry
            while (entry != null) {
                val outFile = File(outDir, entry.name)
                // Path traversal guard
                if (!outFile.canonicalPath.startsWith(outDir.canonicalPath + File.separator)) {
                    throw SecurityException("非法归档路径: ${entry.name}")
                }
                if (entry.isDirectory) {
                    outFile.mkdirs()
                } else {
                    outFile.parentFile?.mkdirs()
                    FileOutputStream(outFile).use { tar.copyTo(it, 64 * 1024) }
                }
                entry = tar.nextTarEntry
            }
        }
    }
}
