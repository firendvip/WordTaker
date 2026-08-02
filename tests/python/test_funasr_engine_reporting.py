import os
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
