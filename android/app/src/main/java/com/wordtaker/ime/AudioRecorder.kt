package com.wordtaker.ime

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.max

/**
 * Captures 16 kHz mono PCM from the mic into a growing FloatArray (normalized [-1, 1]),
 * which is the exact input shape sherpa-onnx OfflineStream.acceptWaveform expects.
 *
 * Caller is responsible for holding RECORD_AUDIO permission (granted via SetupActivity).
 */
class AudioRecorder {

    companion object {
        const val SAMPLE_RATE = 16_000
        private const val MAX_SECONDS = 60 // hard cap to avoid unbounded memory
    }

    @Volatile private var recording = false
    private var thread: Thread? = null
    private val samples = ArrayList<Float>(SAMPLE_RATE * 5)

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (recording) return true
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) return false
        val bufSize = max(minBuf, SAMPLE_RATE * 2) // ~1s headroom

        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufSize
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return false
        }

        synchronized(samples) { samples.clear() }
        recording = true
        recorder.startRecording()

        thread = Thread {
            val buf = ShortArray(bufSize / 2)
            val maxSamples = SAMPLE_RATE * MAX_SECONDS
            while (recording) {
                val n = recorder.read(buf, 0, buf.size)
                if (n > 0) {
                    synchronized(samples) {
                        var i = 0
                        while (i < n && samples.size < maxSamples) {
                            samples.add(buf[i] / 32768.0f)
                            i++
                        }
                        if (samples.size >= maxSamples) recording = false
                    }
                }
            }
            recorder.stop()
            recorder.release()
        }.also { it.start() }
        return true
    }

    /** Stops capture and returns the recorded samples (16 kHz mono float). */
    fun stop(): FloatArray {
        recording = false
        thread?.join(2_000)
        thread = null
        return synchronized(samples) { samples.toFloatArray() }
    }

    fun isRecording(): Boolean = recording
}
