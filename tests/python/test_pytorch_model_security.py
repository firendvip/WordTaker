"""Harmless fixture/spies only: never load a malicious or real checkpoint."""
import hashlib
import io
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock
import zipfile

import pytorch_model_security as security


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ModelSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = "fixture-model"
        self.folder = self.root / self.repo
        self.folder.mkdir()
        self.files = {"model.pt": b"harmless weights fixture", "config.yaml": b"model: Fixture\n", "tokens.json": b'["fixture"]'}
        for name, content in self.files.items():
            (self.folder / name).write_bytes(content)
        self.manifest = {"schemaVersion": 1, "models": {self.repo: {
            "repository": "damo/fixture-model", "revision": "v2.0.4", "commit": "a" * 40,
            "files": {name: {"size": len(data), "sha256": digest(data)} for name, data in self.files.items()},
        }}}

    def verify(self):
        return security.verify_model_directory(self.root, self.repo, manifest=self.manifest)

    def test_accepts_only_exact_authenticated_bytes(self):
        self.assertEqual(self.verify(), self.folder.resolve())

    def test_same_size_tamper_of_weights_config_and_tokens_is_rejected(self):
        for name, content in self.files.items():
            with self.subTest(name=name):
                (self.folder / name).write_bytes(b"x" * len(content))
                with self.assertRaises(security.ModelIntegrityError):
                    self.verify()
                (self.folder / name).write_bytes(content)

    def test_missing_and_truncated_files_are_rejected(self):
        for name, content in self.files.items():
            with self.subTest(name=name):
                (self.folder / name).unlink()
                with self.assertRaises(security.ModelIntegrityError):
                    self.verify()
                (self.folder / name).write_bytes(content[:-1])
                with self.assertRaises(security.ModelIntegrityError):
                    self.verify()
                (self.folder / name).write_bytes(content)

    def test_unknown_repository_wrong_revision_and_unresolved_commit_are_rejected(self):
        with self.assertRaises(security.ModelIntegrityError):
            security.verify_model_directory(self.root, "other", manifest=self.manifest)
        record = self.manifest["models"][self.repo]
        record["revision"] = "master"
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()
        record["revision"] = "v2.0.4"
        record["commit"] = "v2.0.4"
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()

    def test_invalid_digest_size_and_manifest_schema_fail_closed(self):
        record = self.manifest["models"][self.repo]["files"]["model.pt"]
        for invalid in [True, -1, "20"]:
            record["size"] = invalid
            with self.assertRaises(security.ModelIntegrityError):
                self.verify()
        record["size"] = len(self.files["model.pt"])
        record["sha256"] = "not a hash"
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()
        self.manifest["schemaVersion"] = 2
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()

    def test_absolute_parent_backslash_and_empty_manifest_paths_are_rejected(self):
        files = self.manifest["models"][self.repo]["files"]
        for name in ["../outside", "/outside", "nested/../../outside", "nested\\model.pt", ""]:
            with self.subTest(name=name):
                files[name] = {"size": 1, "sha256": digest(b"x")}
                with self.assertRaises(security.ModelIntegrityError):
                    self.verify()
                files.pop(name)

    def test_symlinked_model_root_and_files_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.folder, target_is_directory=True)
        self.manifest["models"]["alias"] = self.manifest["models"][self.repo]
        with self.assertRaises(security.ModelIntegrityError):
            security.verify_model_directory(self.root, "alias", manifest=self.manifest)
        target = self.root / "outside.pt"
        target.write_bytes(self.files["model.pt"])
        (self.folder / "model.pt").unlink()
        (self.folder / "model.pt").symlink_to(target)
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()

    def test_nested_symlink_and_non_regular_file_are_rejected(self):
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "frontend.mvn").write_bytes(b"frontend")
        (self.folder / "nested").symlink_to(nested, target_is_directory=True)
        self.manifest["models"][self.repo]["files"]["nested/frontend.mvn"] = {"size": 8, "sha256": digest(b"frontend")}
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()
        (self.folder / "nested").unlink()
        self.manifest["models"][self.repo]["files"].pop("nested/frontend.mvn")
        (self.folder / "model.pt").unlink()
        (self.folder / "model.pt").mkdir()
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()

    def test_unmanifested_loader_resources_and_requirement_installers_are_rejected(self):
        for name in ["configuration.json", "extra.pt", "remote.py", "requirements.txt", "am.mvn", "tokens.txt"]:
            with self.subTest(name=name):
                (self.folder / name).write_bytes(b"untrusted")
                with self.assertRaises(security.ModelIntegrityError):
                    self.verify()
                (self.folder / name).unlink()

    def test_hub_bookkeeping_and_readme_are_not_loader_resources(self):
        for name in ["README.md", ".msc", ".mv", ".mdl"]:
            (self.folder / name).write_text("bookkeeping")
        self.assertEqual(self.verify(), self.folder.resolve())

    def test_cache_reuse_rechecks_bytes_instead_of_blessing_a_previous_success(self):
        self.verify()
        (self.folder / "config.yaml").write_bytes(b"x" * len(self.files["config.yaml"]))
        with self.assertRaises(security.ModelIntegrityError):
            self.verify()

    def test_symlinked_cache_root_and_hub_named_loader_dictionary_are_rejected(self):
        alias = self.root.parent / (self.root.name + "-alias")
        alias.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(alias.unlink)
        with self.assertRaises(security.ModelIntegrityError):
            security.verify_model_directory(alias, self.repo, manifest=self.manifest)
        for name in ["seg_dict", "jieba_usr_dict"]:
            (self.folder / name).write_text("untrusted")
            with self.assertRaises(security.ModelIntegrityError):
                self.verify()
            (self.folder / name).unlink()

    def test_requirements_and_remote_code_remain_forbidden_even_with_a_content_pin(self):
        for name in ["requirements.txt", "remote.py"]:
            content = b"harmless fixture"
            (self.folder / name).write_bytes(content)
            self.manifest["models"][self.repo]["files"][name] = {"size": len(content), "sha256": digest(content)}
            with self.assertRaises(security.ModelIntegrityError):
                self.verify()
            self.manifest["models"][self.repo]["files"].pop(name)
            (self.folder / name).unlink()

    def test_forced_safe_environment_overrides_inherited_force_no(self):
        env = {"TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD": "1", "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "0", "unrelated": "keep"}
        security.enforce_weights_only_environment(env)
        self.assertEqual(env, {"TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1", "unrelated": "keep"})

    def test_restricted_load_accepts_only_verified_file_and_forces_safe_cpu_loading(self):
        original = Mock(return_value={"harmless": "state dict"})
        fake_torch = types.SimpleNamespace(load=original, serialization=types.SimpleNamespace(clear_safe_globals=Mock()), jit=types.SimpleNamespace(load=Mock()))
        security.install_restricted_torch_loader(fake_torch, self.root, manifest=self.manifest)
        result = fake_torch.load(self.folder / "model.pt", map_location="cpu")
        self.assertEqual(result, {"harmless": "state dict"})
        self.assertTrue(original.call_args.kwargs["weights_only"])
        self.assertEqual(original.call_args.kwargs["map_location"], "cpu")
        self.assertTrue(hasattr(original.call_args.args[0], "read"))
        fake_torch.serialization.clear_safe_globals.assert_called_once()

    def test_no_unsafe_retry_or_custom_pickle_module_is_allowed(self):
        original = Mock(side_effect=RuntimeError("incompatible safe state dict"))
        fake = types.SimpleNamespace(load=original, serialization=types.SimpleNamespace(clear_safe_globals=Mock()), jit=types.SimpleNamespace(load=Mock()))
        security.install_restricted_torch_loader(fake, self.root, manifest=self.manifest)
        for kwargs in [{"weights_only": False}, {"pickle_module": object()}]:
            with self.assertRaises(security.ModelIntegrityError):
                fake.load(self.folder / "model.pt", **kwargs)
        original.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "incompatible"):
            fake.load(self.folder / "model.pt")
        original.assert_called_once()

    def test_unknown_path_memory_checkpoint_and_torchscript_are_never_dispatched(self):
        original = Mock()
        jit = Mock()
        fake = types.SimpleNamespace(load=original, serialization=types.SimpleNamespace(clear_safe_globals=Mock()), jit=types.SimpleNamespace(load=jit))
        security.install_restricted_torch_loader(fake, self.root, manifest=self.manifest)
        for source in [self.root / "unknown.pt", io.BytesIO(b"fixture")]:
            with self.assertRaises(security.ModelIntegrityError):
                fake.load(source)
        with self.assertRaises(security.ModelIntegrityError):
            fake.jit.load(self.folder / "model.pt")
        original.assert_not_called()
        jit.assert_not_called()
        with zipfile.ZipFile(self.folder / "model.pt", "w") as archive:
            archive.writestr("fixture/code/__torch__.py", "# harmless fixture")
            archive.writestr("fixture/constants.pkl", "not a pickle")
        data = (self.folder / "model.pt").read_bytes()
        self.manifest["models"][self.repo]["files"]["model.pt"] = {"size": len(data), "sha256": digest(data)}
        security.install_restricted_torch_loader(fake, self.root, manifest=self.manifest)
        with self.assertRaises(security.ModelIntegrityError):
            fake.load(self.folder / "model.pt")
        original.assert_not_called()

    def test_weights_changed_after_directory_check_are_rejected_before_deserialization(self):
        self.verify()
        original = Mock()
        fake = types.SimpleNamespace(load=original, serialization=types.SimpleNamespace(clear_safe_globals=Mock()), jit=types.SimpleNamespace(load=Mock()))
        security.install_restricted_torch_loader(fake, self.root, manifest=self.manifest)
        (self.folder / "model.pt").write_bytes(b"x" * len(self.files["model.pt"]))
        with self.assertRaises(security.ModelIntegrityError):
            fake.load(self.folder / "model.pt")
        original.assert_not_called()


if __name__ == "__main__":
    unittest.main()
