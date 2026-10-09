"""Literal text boundary; exercise the installed FunASR dispatch functions offline."""
import ast
import builtins
import contextlib
import os
from pathlib import Path
import random
import string
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

import funasr_server


def installed_function(relative, name, namespace):
    filename = Path(sys.prefix) / "lib/python3.11/site-packages/funasr" / relative
    tree = ast.parse(filename.read_text(encoding="utf-8"))
    node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(filename), "exec"), namespace)
    return namespace[name]


class CTTransformer:
    __module__ = "funasr.models.ct_transformer.model"

    def eval(self):
        return self


class LiteralPunctuationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "literal.txt"
        self.path.write_text("not the user text", encoding="utf-8")
        self.audio = self.root / "audio.wav"
        sf.write(self.audio, np.zeros(1600, dtype=np.float32), 16000)
        self.download = mock.Mock(return_value="downloaded instead of literal text")
        self.opens = mock.Mock(wraps=builtins.open)
        self.exists = mock.Mock(wraps=os.path.exists)
        namespace = {
            "os": types.SimpleNamespace(path=types.SimpleNamespace(exists=self.exists, splitext=os.path.splitext)),
            "download_from_url": self.download, "open": self.opens,
            "string": string, "random": random, "json": __import__("json"), "np": np,
            "misc": types.SimpleNamespace(extract_filename_without_extension=lambda value: Path(value).stem),
        }
        loader = installed_function("utils/load_utils.py", "load_audio_text_image_video", namespace)
        prepare = installed_function("auto/auto_model.py", "prepare_data_iterator", namespace)
        inference_globals = {"load_audio_text_image_video": loader, "split_words": lambda value, **_kwargs: [value], "torch": types.SimpleNamespace(no_grad=contextlib.nullcontext)}
        exec("def inference(self, data_in, key=None, **kwargs):\n    text = load_audio_text_image_video(data_in, data_type='text')[0]\n    split_words(text)\n    self.seen.append(text)\n    if self.fail: raise RuntimeError('fixture inference failure')\n    return [{'text': text + '。'}], {}\n", inference_globals)
        inference_globals["inference"].__module__ = CTTransformer.__module__
        CTTransformer.inference = inference_globals["inference"]
        self.model = CTTransformer()
        self.model.seen = []
        self.model.fail = False
        self.auto = types.SimpleNamespace(model=self.model, kwargs={"device": "cpu"})

        def vulnerable_generate(input):
            keys, data = prepare(input, data_type="text")
            return self.model.inference(data_in=data, key=keys)[0]

        self.auto.generate = mock.Mock(side_effect=vulnerable_generate)

    def server(self, text):
        server = funasr_server.FunASRServer.__new__(funasr_server.FunASRServer)
        server.initialized = True
        server.onnx_only = False
        server.sensevoice_model = None
        server.sensevoice_tokens = None
        server.sensevoice_unavailable_reason = "fixture unavailable"
        server.asr_model = mock.Mock()
        server.asr_model.generate.return_value = [{"text": text}]
        server.vad_model = None
        server.punc_model = self.auto
        server.transcription_count = 0
        server.total_audio_duration = 0
        server._get_audio_duration = lambda _path: 1
        return server

    def inputs(self):
        return ["http://example.invalid/A?q=中文", "https://example.invalid/Case#片段", str(self.path),
                "./ordinary.txt", r"C:\\user\\notes.txt", "中文测试", "中文 mixed TEXT", "短", "长内容" * 150, "", "   "]

    def reset_spies(self):
        self.download.reset_mock()
        self.opens.reset_mock()
        self.exists.reset_mock()
        self.auto.generate.reset_mock()
        self.model.seen.clear()

    def assert_no_dispatch(self):
        self.download.assert_not_called()
        self.opens.assert_not_called()
        self.exists.assert_not_called()
        self.auto.generate.assert_not_called()

    def test_adapter_preserves_literal_input_without_url_or_path_dispatch(self):
        from funasr_punctuation import generate_punctuation
        for text in self.inputs():
            with self.subTest(text=text[:80]):
                self.reset_spies()
                result = generate_punctuation(self.auto, text)
                self.assertEqual(result[0]["text"], text + "。" if text.strip() else text)
                self.assertEqual(self.model.seen, [text] if text.strip() else [])
                self.assert_no_dispatch()

    def test_whole_and_segmented_paths_preserve_raw_text_and_engine_fields(self):
        for segmented in (False, True):
            for text in self.inputs():
                with self.subTest(segmented=segmented, text=text[:80]):
                    self.reset_spies()
                    server = self.server(text)
                    if segmented:
                        server.vad_model = mock.Mock()
                        server._get_audio_duration = lambda _path: 65
                        server._vad_segments = lambda _path: [[0, 100]]
                    with mock.patch("tempfile.gettempdir", return_value=str(self.root)):
                        result = server.transcribe_audio(str(self.audio), {"engine": "sensevoice", "use_punc": True})
                    self.assertTrue(result["success"], result)
                    self.assertEqual(result["raw_text"], text)
                    self.assertEqual("segmented" in result["model_type"], segmented)
                    self.assertEqual(result["requested_engine"], "sensevoice")
                    self.assertEqual(result["actual_engine"], "paraformer")
                    self.assertEqual(result["fallback_reason"], "fixture unavailable")
                    self.assertEqual(self.model.seen, [result["raw_text"]] if text.strip() else [])
                    self.assert_no_dispatch()

    def test_warmup_uses_same_literal_boundary(self):
        with mock.patch("tempfile.gettempdir", return_value=str(self.root)):
            self.server("fixture")._warmup()
        self.assertEqual(self.model.seen, ["你好"])
        self.assert_no_dispatch()

    def test_inference_failure_returns_original_text_in_both_paths(self):
        self.model.fail = True
        for segmented in (False, True):
            self.reset_spies()
            text = "https://example.invalid/Original"
            server = self.server(text)
            if segmented:
                server.vad_model = mock.Mock()
                server._get_audio_duration = lambda _path: 65
                server._vad_segments = lambda _path: [[0, 100]]
            with mock.patch("tempfile.gettempdir", return_value=str(self.root)):
                result = server.transcribe_audio(str(self.audio), {"engine": "paraformer"})
            self.assertTrue(result["success"], result)
            self.assertEqual(result["text"], text)
            self.assertEqual(result["raw_text"], text)
            self.assert_no_dispatch()

    def test_adapter_does_not_mutate_model_globals_or_kwargs(self):
        from funasr_punctuation import generate_punctuation
        original = self.model.inference.__func__.__globals__["load_audio_text_image_video"]
        self.auto.kwargs["cache"] = {"untouched": True}
        generate_punctuation(self.auto, "你好")
        self.assertIs(self.model.inference.__func__.__globals__["load_audio_text_image_video"], original)
        self.assertEqual(self.auto.kwargs["cache"], {"untouched": True})

    def test_unsupported_model_or_non_text_fails_closed(self):
        from funasr_punctuation import generate_punctuation
        for value in (None, b"text", ["https://example.invalid"], 123):
            with self.assertRaises(TypeError):
                generate_punctuation(self.auto, value)
        for model in (None, object(), types.SimpleNamespace(model=object(), kwargs={})):
            with self.assertRaises((TypeError, ValueError)):
                generate_punctuation(model, "你好")
        self.assert_no_dispatch()

    def test_changed_inference_contract_fails_closed(self):
        from funasr_punctuation import generate_punctuation
        self.model.inference = types.MethodType(lambda _self, **_kwargs: [], self.model)
        with self.assertRaisesRegex(ValueError, "literal boundary needs review"):
            generate_punctuation(self.auto, "https://example.invalid")
        self.assert_no_dispatch()

    def test_private_loader_rejects_ambiguous_or_non_text_batches(self):
        from funasr_punctuation import _literal_text
        for value in (None, "text", (), [], ["one", "two"], [None], [b"text"]):
            with self.assertRaises(TypeError):
                _literal_text(value)

    def test_url_and_path_words_keep_exact_case_without_changing_ordinary_words(self):
        from funasr_punctuation import _literal_words
        words = ["https://example.invalid/Case", "http://example.invalid/UPPER", "/User/Notes.txt", "./Notes.txt", "../Notes.txt", r"C:\\User\\Notes.txt", "ordinary", "中文"]
        original = mock.Mock(return_value=words)
        adapted = _literal_words(original, "literal input", jieba_usr_dict=None)
        self.assertEqual([word.capitalize() for word in adapted[:-2]], words[:-2])
        self.assertEqual(adapted[-2].capitalize(), "Ordinary")
        self.assertEqual(words[-2], "ordinary")
        original.assert_called_once_with("literal input", jieba_usr_dict=None)


if __name__ == "__main__":
    unittest.main()
