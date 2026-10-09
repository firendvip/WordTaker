"""The ASR worker must load the same local files that the desktop verified."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location('worker_under_test', ROOT / 'funasr_server.py')
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)

REPOS = {
    'asr': 'speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    'vad': 'speech_fsmn_vad_zh-cn-16k-common-pytorch',
    'punc': 'punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
}


class LocalModelsTest(unittest.TestCase):
    def test_all_loaders_use_verified_local_directories_without_network(self):
        with tempfile.TemporaryDirectory() as root:
            for kind, repo in REPOS.items():
                with self.subTest(kind=kind):
                    folder = Path(root) / repo
                    folder.mkdir()
                    (folder / 'config.yaml').write_text('model: test')
                    (folder / 'model.pt').write_bytes(b'model fixture')
                    auto_model = Mock()
                    fake = types.SimpleNamespace(AutoModel=auto_model)
                    with patch.dict(sys.modules, {'funasr': fake, 'torch': types.SimpleNamespace()}):
                        with patch.object(WORKER, 'verify_model_directory', return_value=folder) as verify, patch.object(WORKER, 'install_restricted_torch_loader') as restrict:
                            server = WORKER.FunASRServer(damo_root=root)
                            self.assertTrue(getattr(server, f'_load_{kind}_model')())
                            verify.assert_called_once_with(root, repo)
                            restrict.assert_called_once()
                    self.assertEqual(auto_model.call_args.kwargs['model'], str(folder))
                    self.assertFalse(auto_model.call_args.kwargs.get('check_latest', True))
                    self.assertFalse(auto_model.call_args.kwargs.get('trust_remote_code', True))

    def test_missing_local_files_fail_without_attempting_remote_download(self):
        with tempfile.TemporaryDirectory() as root:
            for kind in REPOS:
                with self.subTest(kind=kind):
                    auto_model = Mock()
                    with patch.dict(sys.modules, {'funasr': types.SimpleNamespace(AutoModel=auto_model)}):
                        server = WORKER.FunASRServer(damo_root=root)
                        self.assertFalse(getattr(server, f'_load_{kind}_model')())
                    auto_model.assert_not_called()


if __name__ == '__main__':
    unittest.main()
