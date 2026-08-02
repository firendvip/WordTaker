import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

from funasr_server import FunASRServer


class FakeParaformer:
    def generate(self, **_kwargs):
        return [{"text": "测试文本"}]


class FunASREngineReportingTests(unittest.TestCase):
    def make_server(self):
        server = FunASRServer.__new__(FunASRServer)
        server.initialized = True
        server.onnx_only = False
        server.sensevoice_model = None
        server.sensevoice_tokens = None
        server.sensevoice_unavailable_reason = "SenseVoice 模型文件缺失: model_quant.onnx"
        server.asr_model = FakeParaformer()
        server.vad_model = None
        server.punc_model = None
        server.transcription_count = 0
        server.total_audio_duration = 0.0
        server._get_audio_duration = lambda _path: 1.0
        return server

    def test_requested_sensevoice_reports_paraformer_fallback(self):
        server = self.make_server()
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            result = server.transcribe_audio(audio.name, {"engine": "sensevoice"})

        self.assertTrue(result["success"])
        self.assertEqual(result["requested_engine"], "sensevoice")
        self.assertEqual(result["actual_engine"], "paraformer")
        self.assertEqual(
            result["fallback_reason"],
            "SenseVoice 模型文件缺失: model_quant.onnx",
        )
        self.assertEqual(result["model_type"], "paraformer-pytorch")

    def test_requested_paraformer_has_no_false_fallback(self):
        server = self.make_server()
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            result = server.transcribe_audio(audio.name, {"engine": "paraformer"})

        self.assertEqual(result["requested_engine"], "paraformer")
        self.assertEqual(result["actual_engine"], "paraformer")
        self.assertIsNone(result["fallback_reason"])

    def test_missing_sensevoice_does_not_make_full_runtime_unavailable(self):
        server = self.make_server()
        server.initialized = False
        server._load_asr_model = lambda: True
        server._load_vad_model = lambda: True
        server._load_punc_model = lambda: True

        def fail_sensevoice():
            server.sensevoice_unavailable_reason = "SenseVoice 模型文件缺失: model_quant.onnx"
            return False

        server._load_sensevoice = fail_sensevoice
        server._warmup = lambda: None

        result = server._initialize_locked()

        self.assertTrue(result["success"])
        self.assertTrue(server.initialized)
        self.assertEqual(result["engine_status"]["available_engines"], ["paraformer"])
        self.assertFalse(result["engine_status"]["sensevoice_available"])
        self.assertEqual(
            result["engine_status"]["sensevoice_unavailable_reason"],
            "SenseVoice 模型文件缺失: model_quant.onnx",
        )

    def test_full_macos_runtime_uses_bundled_numpy_engine_without_bpe_file(self):
        class FakeNumpyEngine:
            def __init__(self, model_dir, **_kwargs):
                self.model_dir = model_dir

        fake_module = types.SimpleNamespace(SenseVoiceOnnxEngine=FakeNumpyEngine)
        server = FunASRServer.__new__(FunASRServer)
        server.onnx_only = False
        server.sensevoice_model = None
        server.sensevoice_tokens = None
        server.sensevoice_unavailable_reason = None

        with tempfile.TemporaryDirectory() as root:
            model_dir = os.path.join(root, "models", "sensevoice")
            os.makedirs(model_dir)
            for name in ("model_quant.onnx", "config.yaml", "am.mvn"):
                with open(os.path.join(model_dir, name), "wb") as handle:
                    handle.write(b"fixture")
            with open(os.path.join(model_dir, "tokens.json"), "w", encoding="utf-8") as handle:
                json.dump([], handle)

            with mock.patch("funasr_server.__file__", os.path.join(root, "funasr_server.py")):
                with mock.patch.dict(sys.modules, {"sensevoice_onnx_engine": fake_module}):
                    loaded = server._load_sensevoice()

        self.assertTrue(loaded)
        self.assertIsInstance(server.sensevoice_model, FakeNumpyEngine)
        self.assertIsNone(server.sensevoice_unavailable_reason)


if __name__ == "__main__":
    unittest.main()
