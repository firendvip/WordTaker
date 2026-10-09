import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.request

import download_models
from pytorch_model_security import ModelIntegrityError, verify_model_directory


class Response(io.BytesIO):
    def __init__(self, data, url):
        super().__init__(data)
        self.url = url
    def geturl(self):
        return self.url


class ModelDownloadSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.contents = {"model.pt": b"harmless fixture", "config.yaml": b"model: Fixture\n"}
        self.manifest = {"schemaVersion": 1, "models": {"fixture": {"repository": "damo/fixture", "revision": "v2.0.4", "commit": "a" * 40, "files": {name: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in self.contents.items()}}}}

    def response(self, request, **_kwargs):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(request.full_url).query)
        self.assertEqual(params["Revision"], ["a" * 40])
        return Response(self.contents[params["FilePath"][0]], request.full_url)

    def download(self, opener=None):
        return download_models.download_verified_model(self.root, "fixture", manifest=self.manifest, opener=opener or self.response)

    def test_downloads_raw_fixed_revision_bytes_before_any_model_import(self):
        with mock.patch.dict("sys.modules", {"funasr": None, "torch": None}):
            actual = self.download()
        self.assertEqual(actual, (self.root / "fixture").resolve())
        verify_model_directory(self.root, "fixture", manifest=self.manifest)

    def test_verified_offline_cache_reuse_never_contacts_provider(self):
        self.download()
        self.download(mock.Mock(side_effect=AssertionError("No network")))

    def test_tampered_cache_is_replaced_only_after_verified_download_and_preserved(self):
        self.download()
        (self.root / "fixture/model.pt").write_bytes(b"x" * len(self.contents["model.pt"]))
        self.download()
        self.assertEqual((self.root / "fixture/model.pt").read_bytes(), self.contents["model.pt"])
        backups = list((self.root / ".retired").glob("fixture-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "model.pt").read_bytes(), b"x" * len(self.contents["model.pt"]))

    def test_bad_digest_short_and_oversized_downloads_are_not_published(self):
        for content in [b"wrong hash bytes!", b"short", b"x" * 100]:
            with self.subTest(length=len(content)):
                with self.assertRaises(ModelIntegrityError):
                    self.download(lambda request, **_kw: Response(content, request.full_url))
                self.assertFalse((self.root / "fixture").exists())

    def test_failed_repair_preserves_existing_cache(self):
        self.download()
        (self.root / "fixture/model.pt").write_bytes(b"old bytes")
        with self.assertRaises(ModelIntegrityError):
            self.download(lambda request, **_kw: Response(b"bad", request.full_url))
        self.assertEqual((self.root / "fixture/model.pt").read_bytes(), b"old bytes")

    def test_symlinked_cache_model_or_retirement_directory_is_never_written(self):
        outside = self.root / "outside"
        outside.mkdir()
        for name in ["fixture", ".retired"]:
            target = self.root / name
            target.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ModelIntegrityError):
                self.download()
            self.assertEqual(list(outside.iterdir()), [])
            target.unlink()

    def test_https_downgrade_or_network_failure_never_publishes_model(self):
        for opener in [lambda _request, **_kw: Response(b"", "http://example.invalid"), mock.Mock(side_effect=OSError("offline"))]:
            with self.assertRaises((ModelIntegrityError, OSError)):
                self.download(opener)
            self.assertFalse((self.root / "fixture").exists())

    def test_unknown_repository_is_rejected_before_network(self):
        opener = mock.Mock(side_effect=AssertionError("No network"))
        with self.assertRaises(ModelIntegrityError):
            download_models.download_verified_model(self.root, "unknown", manifest=self.manifest, opener=opener)
        opener.assert_not_called()

    def test_progress_wrapper_reports_success_and_failure_without_loading_models(self):
        callback = mock.Mock()
        config = {"name": "damo/fixture", "type": "asr"}
        with mock.patch.object(download_models, "download_verified_model") as download:
            download.side_effect = lambda *_args, **kwargs: kwargs["progress_callback"](50)
            result = download_models.download_model(config, callback, cache_root=self.root)
        self.assertTrue(result["success"])
        self.assertEqual(callback.call_args_list, [mock.call("asr", "downloading", 0), mock.call("asr", "downloading", 50), mock.call("asr", "completed", 100)])
        callback.reset_mock()
        with mock.patch.object(download_models, "download_verified_model", side_effect=ModelIntegrityError("bad bytes")):
            self.assertFalse(download_models.download_model(config, callback, cache_root=self.root)["success"])
        self.assertEqual(callback.call_args.args[:3], ("asr", "error", 0))
        self.assertFalse(download_models.download_model(config, cache_root=None)["success"])

    def test_parallel_cli_emits_framed_json_and_never_reports_partial_download_as_success(self):
        for fail in [False, True]:
            output = io.StringIO()
            def fake_download(root, repository, **kwargs):
                self.assertEqual(root, str(self.root))
                kwargs["progress_callback"](51)
                if fail and "vad" in repository:
                    raise ModelIntegrityError("fixture rejection")
            with mock.patch("sys.argv", ["download_models.py", "--damo-root", str(self.root)]), mock.patch.object(download_models, "download_verified_model", side_effect=fake_download), mock.patch("sys.stdout", output):
                download_models.main()
            messages = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(messages[-1]["success"], not fail)
            self.assertEqual(set(messages[-1]["results"]), {"asr", "vad", "punc"})
            self.assertEqual(max(message.get("completed", 0) for message in messages), 3)

    def test_legacy_cli_defaults_to_private_cache_not_shared_modelscope_cache(self):
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"ELECTRON_USER_DATA": str(self.root)}), mock.patch("sys.argv", ["download_models.py"]), mock.patch.object(download_models, "download_verified_model") as download, mock.patch("sys.stdout", output):
            download_models.main()
        self.assertEqual(download.call_count, 3)
        for call in download.call_args_list:
            self.assertEqual(Path(call.args[0]), self.root / "models/damo")

    def test_redirect_handler_rejects_http_and_retains_https(self):
        handler = download_models.HTTPSRedirectHandler()
        request = urllib.request.Request("https://example.invalid/model")
        with self.assertRaises(ModelIntegrityError):
            handler.redirect_request(request, None, 302, "redirect", {}, "http://example.invalid/model")
        redirected = handler.redirect_request(request, None, 302, "redirect", {}, "https://other.invalid/model")
        self.assertEqual(redirected.full_url, "https://other.invalid/model")

    def test_failed_atomic_publish_restores_old_cache(self):
        self.download()
        (self.root / "fixture/model.pt").write_bytes(b"old bytes")
        original = Path.rename
        def rename(source, target):
            if source.parent.name.startswith(".wordtaker-download-"):
                raise OSError("fixture publish failure")
            return original(source, target)
        with mock.patch.object(Path, "rename", rename), self.assertRaises(OSError):
            self.download()
        self.assertEqual((self.root / "fixture/model.pt").read_bytes(), b"old bytes")


if __name__ == "__main__":
    unittest.main()
