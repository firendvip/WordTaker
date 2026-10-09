import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

import funasr_server
from pytorch_model_security import ModelIntegrityError


class FunASRSafeInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def server(self):
        server = funasr_server.FunASRServer.__new__(funasr_server.FunASRServer)
        server.damo_root = str(self.root)
        server.initialized = True
        server.onnx_only = False
        server.asr_model = mock.Mock()
        server.asr_model.generate.return_value = [{"text": "测试文本"}]
        server.vad_model = mock.Mock()
        server.vad_model.generate.return_value = [{"value": [[0, 40000], [45000, 65000]]}]
        server.punc_model = None
        server.sensevoice_model = None
        server.sensevoice_tokens = None
        server.sensevoice_unavailable_reason = "SenseVoice 未就绪"
        server.transcription_count = 0
        server.total_audio_duration = 0
        server._get_audio_duration = lambda _path: 1
        return server

    def audio(self, seconds=1):
        filename = self.root / "audio.wav"
        sf.write(filename, np.zeros(int(seconds * 16000), dtype=np.float32), 16000)
        return str(filename)

    def assert_audio_inputs(self, model):
        for call in model.generate.call_args_list:
            audio = call.kwargs["input"]
            self.assertIsInstance(audio, np.ndarray)
            self.assertEqual(audio.dtype, np.dtype("float32"))
            self.assertEqual(audio.ndim, 1)

    def test_unverified_complete_looking_models_never_reach_auto_model(self):
        auto = mock.Mock()
        with mock.patch.dict(sys.modules, {"funasr": types.SimpleNamespace(AutoModel=auto)}):
            for repository, kind in [
                ("speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "asr"),
                ("speech_fsmn_vad_zh-cn-16k-common-pytorch", "vad"),
                ("punc_ct-transformer_zh-cn-common-vocab272727-pytorch", "punc"),
            ]:
                directory = self.root / repository
                directory.mkdir()
                (directory / "config.yaml").write_text("model: Fixture\n")
                (directory / "model.pt").write_bytes(b"harmless fixture")
                self.assertFalse(getattr(self.server(), f"_load_{kind}_model")())
        auto.assert_not_called()

    def test_weights_only_policy_is_armed_before_verified_model_construction(self):
        order = []
        fake_torch = types.SimpleNamespace()
        auto = mock.Mock(side_effect=lambda **_kwargs: order.append("construct"))
        def verified(*_args, **_kwargs):
            order.append("verify")
            return self.root
        def restricted(*_args, **_kwargs):
            order.append("restrict")
        with mock.patch.dict(sys.modules, {"torch": fake_torch, "funasr": types.SimpleNamespace(AutoModel=auto)}):
            with mock.patch("funasr_server.verify_model_directory", side_effect=verified), mock.patch("funasr_server.install_restricted_torch_loader", side_effect=restricted):
                self.assertTrue(self.server()._load_asr_model())
        self.assertLess(order.index("verify"), order.index("construct"))
        self.assertLess(order.index("restrict"), order.index("construct"))
        self.assertFalse(auto.call_args.kwargs["trust_remote_code"])

    def test_whole_audio_and_explicit_vad_receive_ndarrays(self):
        server = self.server()
        result = server.transcribe_audio(self.audio(), {"engine": "paraformer", "use_vad": True, "use_punc": False})
        self.assertTrue(result["success"])
        self.assert_audio_inputs(server.asr_model)
        self.assert_audio_inputs(server.vad_model)

    def test_warmup_and_segment_call_do_not_enter_codec_loader(self):
        server = self.server()
        with mock.patch("tempfile.gettempdir", return_value=str(self.root)):
            server._warmup()
        server._transcribe_segment_text(self.audio(), "paraformer", {"batch_size_s": 60, "hotword": ""})
        self.assert_audio_inputs(server.asr_model)

    def test_true_long_wav_uses_vad_and_segment_arrays_preserving_fallback_fields(self):
        server = self.server()
        server._get_audio_duration = lambda _path: 65
        with mock.patch("tempfile.gettempdir", return_value=str(self.root)):
            result = server.transcribe_audio(self.audio(65), {"engine": "sensevoice", "use_punc": False})
        self.assertTrue(result["success"])
        self.assertEqual(result["actual_engine"], "paraformer")
        self.assertEqual(result["requested_engine"], "sensevoice")
        self.assertEqual(result["fallback_reason"], "SenseVoice 未就绪")
        self.assertEqual(server.asr_model.generate.call_count, 2)
        self.assert_audio_inputs(server.asr_model)
        self.assert_audio_inputs(server.vad_model)
        self.assertEqual(list(self.root.glob("wordtaker_seg_*.wav")), [])

    def test_empty_wav_returns_error_without_model_dispatch(self):
        server = self.server()
        result = server.transcribe_audio(self.audio(0), {"engine": "paraformer"})
        self.assertFalse(result["success"])
        server.asr_model.generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
