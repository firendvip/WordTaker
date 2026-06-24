package com.wordtaker.ime

import android.Manifest
import android.content.pm.PackageManager
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.core.content.ContextCompat
import com.wordtaker.ime.databinding.KeyboardViewBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * WordTaker voice keyboard.
 *
 * Flow: tap mic -> record 16kHz mono PCM -> tap again to stop -> sherpa-onnx SenseVoice
 * (on-device, offline) -> commitText into the focused field.
 *
 * Model is fetched on first use (ModelManager). Recognizer is lazily created and reused.
 */
class WordTakerImeService : InputMethodService() {

    companion object {
        /** Optional DeepSeek polish via relay. Off by default — core works without network. */
        private const val POLISH_ENABLED = false
    }

    private var binding: KeyboardViewBinding? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val main = Handler(Looper.getMainLooper())

    private val recorder = AudioRecorder()
    @Volatile private var recognizer: SpeechRecognizer? = null
    @Volatile private var busy = false

    override fun onCreateInputView(): View {
        val b = KeyboardViewBinding.inflate(layoutInflater)
        binding = b

        b.micButton.setOnClickListener { onMicTapped() }
        b.switchImeButton.setOnClickListener {
            // System input-method picker (lets user switch keyboards).
            val imm = getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.showInputMethodPicker()
        }

        refreshIdleStatus()
        // Warm up model + recognizer in the background so first tap is fast.
        ensureRecognizerAsync()
        return b.root
    }

    private fun refreshIdleStatus() {
        val b = binding ?: return
        when {
            !hasMicPermission() -> setStatus(getString(R.string.status_no_mic))
            !ModelManager.isReady(this) -> setStatus(getString(R.string.status_model_missing))
            recognizer == null -> setStatus(getString(R.string.status_loading_model))
            else -> setStatus(getString(R.string.status_model_ready))
        }
    }

    private fun onMicTapped() {
        if (busy) return
        if (!hasMicPermission()) {
            setStatus(getString(R.string.status_no_mic))
            return
        }
        if (recorder.isRecording()) {
            stopAndRecognize()
        } else {
            startRecording()
        }
    }

    private fun startRecording() {
        val b = binding ?: return
        if (!ModelManager.isReady(this)) {
            // Kick off model download, then user can tap again once ready.
            downloadModelAsync()
            return
        }
        val ok = recorder.start()
        if (!ok) {
            setStatus(getString(R.string.status_error, "无法启动录音"))
            return
        }
        b.micButton.isActivated = true
        setStatus(getString(R.string.status_listening))
    }

    private fun stopAndRecognize() {
        val b = binding ?: return
        b.micButton.isActivated = false
        setStatus(getString(R.string.status_recognizing))
        val samples = recorder.stop()
        busy = true

        scope.launch {
            try {
                val rec = recognizer ?: withContext(Dispatchers.IO) { SpeechRecognizer.create(this@WordTakerImeService) }
                recognizer = rec
                var text = withContext(Dispatchers.IO) { rec.recognize(samples) }
                if (POLISH_ENABLED && text.isNotBlank()) {
                    text = withContext(Dispatchers.IO) { PolishClient.polish(text) }
                }
                if (text.isNotBlank()) {
                    currentInputConnection?.commitText(text, 1)
                }
                refreshIdleStatus()
            } catch (e: Exception) {
                setStatus(getString(R.string.status_error, e.message ?: "识别失败"))
            } finally {
                busy = false
            }
        }
    }

    private fun ensureRecognizerAsync() {
        if (recognizer != null || !ModelManager.isReady(this)) return
        scope.launch {
            try {
                val rec = withContext(Dispatchers.IO) { SpeechRecognizer.create(this@WordTakerImeService) }
                recognizer = rec
                refreshIdleStatus()
            } catch (e: Exception) {
                setStatus(getString(R.string.status_error, e.message ?: "加载模型失败"))
            }
        }
    }

    private fun downloadModelAsync() {
        if (busy) return
        busy = true
        val b = binding ?: return
        b.progressBar.visibility = View.VISIBLE
        b.progressBar.progress = 0
        setStatus(getString(R.string.status_downloading, 0))

        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    ModelManager.ensureModel(this@WordTakerImeService, object : ModelManager.ProgressListener {
                        override fun onDownloadProgress(percent: Int) {
                            main.post {
                                binding?.progressBar?.progress = percent
                                setStatus(getString(R.string.status_downloading, percent))
                            }
                        }
                        override fun onExtracting() {
                            main.post { setStatus(getString(R.string.status_extracting)) }
                        }
                    })
                    recognizer = SpeechRecognizer.create(this@WordTakerImeService)
                }
                b.progressBar.visibility = View.GONE
                refreshIdleStatus()
            } catch (e: Exception) {
                b.progressBar.visibility = View.GONE
                setStatus(getString(R.string.status_error, e.message ?: "下载失败"))
            } finally {
                busy = false
            }
        }
    }

    private fun setStatus(text: String) {
        main.post { binding?.statusText?.text = text }
    }

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
        recognizer?.release()
        recognizer = null
        binding = null
    }
}
