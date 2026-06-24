package com.wordtaker.ime

import android.content.Context
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.getFeatureConfig

/**
 * Thin wrapper over the sherpa-onnx offline recognizer configured for SenseVoice.
 *
 * API verified against the bundled AAR (v1.13.3, package com.k2fsa.sherpa.onnx):
 *   OfflineRecognizer(assetManager, config) — pass null assetManager when using absolute file paths.
 *   recognizer.createStream() -> OfflineStream
 *   stream.acceptWaveform(FloatArray, sampleRate)
 *   recognizer.decode(stream)
 *   recognizer.getResult(stream).text
 */
class SpeechRecognizer private constructor(private val recognizer: OfflineRecognizer) {

    /** Run recognition on a 16 kHz mono float buffer. Returns recognized text (may be empty). */
    fun recognize(samples: FloatArray, sampleRate: Int = AudioRecorder.SAMPLE_RATE): String {
        if (samples.isEmpty()) return ""
        val stream = recognizer.createStream()
        return try {
            stream.acceptWaveform(samples, sampleRate)
            recognizer.decode(stream)
            recognizer.getResult(stream).text.trim()
        } finally {
            stream.release()
        }
    }

    fun release() = recognizer.release()

    companion object {
        /**
         * Build a recognizer from the extracted model files. Heavy (loads the ONNX model into
         * memory) — call off the main thread. Throws if model files are missing/invalid.
         */
        @Throws(Exception::class)
        fun create(context: Context): SpeechRecognizer {
            val senseVoice = OfflineSenseVoiceModelConfig(
                model = ModelManager.modelPath(context),
                language = "",                       // auto-detect (zh/en/ja/ko/yue)
                useInverseTextNormalization = true,
            )
            val modelConfig = OfflineModelConfig(
                senseVoice = senseVoice,
                tokens = ModelManager.tokensPath(context),
                numThreads = 2,
                debug = false,
                provider = "cpu",
            )
            val config = OfflineRecognizerConfig(
                featConfig = getFeatureConfig(sampleRate = AudioRecorder.SAMPLE_RATE, featureDim = 80),
                modelConfig = modelConfig,
            )
            // assetManager = null because we pass absolute paths in app filesDir.
            val recognizer = OfflineRecognizer(assetManager = null, config = config)
            return SpeechRecognizer(recognizer)
        }
    }
}
