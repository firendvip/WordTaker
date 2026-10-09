"""Fixed-content model verification and a fail-closed PyTorch load boundary.

This module never deserializes a checkpoint or derives trust from a local cache.
The bundled manifest is the only production authority; fixture injection is for
unit tests. Provider bookkeeping is not part of FunASR's loading inputs.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import threading
import zipfile


class ModelIntegrityError(ValueError):
    """A model cannot cross the deserialization boundary."""


_INSTALL_LOCK = threading.Lock()
_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}$")
_LOADER_SUFFIXES = {".pt", ".pth", ".bin", ".pkl", ".pickle", ".py", ".json", ".yaml", ".yml", ".txt", ".mvn", ".model"}
_LOADER_NAMES = {"seg_dict", "jieba_usr_dict"}
_BOOKKEEPING = {"README.md", ".msc", ".mv", ".mdl"}


def enforce_weights_only_environment(environment):
    environment["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    environment.pop("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", None)


def load_manifest():
    try:
        with Path(__file__).with_name("pytorch-model-manifest.json").open(encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError) as error:
        raise ModelIntegrityError("Trusted model manifest is unavailable") from error


def _relative_path(name):
    if not isinstance(name, str) or not name or "\\" in name:
        raise ModelIntegrityError("Invalid manifest path")
    parts = name.split("/")
    if any(part in {"", ".", ".."} for part in parts) or PurePosixPath(name).is_absolute():
        raise ModelIntegrityError("Manifest path escapes the model directory")
    return Path(*parts)


def _model_record(repository, manifest):
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ModelIntegrityError("Unsupported trusted manifest schema")
    models = manifest.get("models")
    if not isinstance(models, dict) or repository not in models:
        raise ModelIntegrityError("Unknown model repository")
    _relative_path(repository)
    if "/" in repository:
        raise ModelIntegrityError("Model directory must be a repository name")
    record = models[repository]
    if not isinstance(record, dict) or record.get("repository") != f"damo/{repository}":
        raise ModelIntegrityError("Repository identity mismatch")
    if record.get("revision") != "v2.0.4" or not _COMMIT_PATTERN.fullmatch(str(record.get("commit", ""))):
        raise ModelIntegrityError("Model revision is not immutable")
    files = record.get("files")
    if not isinstance(files, dict) or not {"model.pt", "config.yaml"}.issubset(files):
        raise ModelIntegrityError("Trusted loading resources are incomplete")
    for name, pin in files.items():
        _relative_path(name)
        if Path(name).name == "requirements.txt" or Path(name).suffix == ".py":
            raise ModelIntegrityError("Model-supplied code and installers are forbidden")
        if not isinstance(pin, dict) or type(pin.get("size")) is not int or pin["size"] < 0:
            raise ModelIntegrityError("Invalid trusted file size")
        if not _HASH_PATTERN.fullmatch(str(pin.get("sha256", ""))):
            raise ModelIntegrityError("Invalid trusted content digest")
    return record


def _directory(root, repository):
    supplied_root = Path(root).absolute()
    if supplied_root.is_symlink() or not supplied_root.is_dir():
        raise ModelIntegrityError("Model cache root must be a real directory")
    root = supplied_root.resolve(strict=True)
    directory = root / repository
    if directory.is_symlink() or not directory.is_dir():
        raise ModelIntegrityError("Model directory is absent or symlinked")
    if directory.resolve(strict=True).parent != root:
        raise ModelIntegrityError("Model directory escapes the cache root")
    return directory


def _checked_file(directory, name):
    filename = directory / _relative_path(name)
    for parent in filename.parents:
        if parent == directory:
            break
        if parent.is_symlink() or not parent.is_dir():
            raise ModelIntegrityError("Model resource parent is absent or symlinked")
    if filename.is_symlink():
        raise ModelIntegrityError("Symlinked model resources are forbidden")
    try:
        if not stat.S_ISREG(filename.stat().st_mode):
            raise ModelIntegrityError("Model resource is not a regular file")
        filename.resolve(strict=True).relative_to(directory)
    except (OSError, ValueError) as error:
        raise ModelIntegrityError("Model resource is missing or outside its directory") from error
    return filename


def _open_verified(filename, pin):
    source = None
    try:
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        source = os.fdopen(descriptor, "rb")
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != pin["size"]:
            raise ModelIntegrityError("Model resource size or type mismatch")
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ModelIntegrityError("Model resource changed during verification")
        if digest.hexdigest() != pin["sha256"]:
            raise ModelIntegrityError("Model resource content mismatch")
        source.seek(0)
        return source
    except (OSError, ModelIntegrityError) as error:
        if source is not None:
            source.close()
        raise ModelIntegrityError("Model resource failed verification") from error


def verify_model_directory(root, repository, *, manifest=None):
    authority = load_manifest() if manifest is None else manifest
    record = _model_record(repository, authority)
    directory = _directory(root, repository)
    for folder, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            filename = Path(folder) / name
            if filename.is_symlink():
                raise ModelIntegrityError("Symlinks are forbidden inside a model directory")
        for name in files:
            filename = Path(folder) / name
            relative = filename.relative_to(directory).as_posix()
            if name == "requirements.txt" or filename.suffix == ".py":
                raise ModelIntegrityError("Model-supplied code and installers are forbidden")
            if relative not in record["files"] and name not in _BOOKKEEPING and (filename.suffix in _LOADER_SUFFIXES or name in _LOADER_NAMES):
                raise ModelIntegrityError("Unmanifested loading resource")
    for name, pin in record["files"].items():
        with _open_verified(_checked_file(directory, name), pin):
            pass
    return directory


def _reject_torchscript(source):
    if zipfile.is_zipfile(source):
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            if any("code" in PurePosixPath(name).parts or PurePosixPath(name).name == "constants.pkl" for name in archive.namelist()):
                raise ModelIntegrityError("TorchScript archives are forbidden")
    source.seek(0)


def install_restricted_torch_loader(torch_module, root, *, manifest=None):
    """Only authenticated ordinary state dictionaries may reach torch.load.

    Pass the same verified open descriptor to PyTorch, never an unchecked path.
    No unsafe retry, custom pickle module, global allowlist, or JIT load exists.
    Trusted FunASR source may still use torch.jit.script (separate residual risk).
    """
    authority = load_manifest() if manifest is None else manifest
    if not isinstance(authority, dict) or not isinstance(authority.get("models"), dict):
        raise ModelIntegrityError("Trusted model manifest is malformed")
    for repository in authority["models"]:
        _model_record(repository, authority)
    supplied_root = Path(root).absolute()
    if supplied_root.is_symlink() or not supplied_root.is_dir():
        raise ModelIntegrityError("Model cache root must be a real directory")
    cache_root = supplied_root.resolve(strict=True)
    with _INSTALL_LOCK:
        original = getattr(torch_module, "_wordtaker_original_load", torch_module.load)
        torch_module._wordtaker_original_load = original

        def restricted_load(filename, *args, **kwargs):
            if args or not isinstance(filename, (str, os.PathLike)):
                raise ModelIntegrityError("Only a trusted checkpoint path may be loaded")
            if kwargs.get("weights_only") is False or kwargs.get("pickle_module") is not None:
                raise ModelIntegrityError("Unsafe checkpoint deserialization is forbidden")
            if kwargs.get("map_location") not in {None, "cpu"}:
                raise ModelIntegrityError("Only CPU checkpoint loading is allowed")
            candidate = Path(filename).absolute()
            try:
                relative = candidate.relative_to(cache_root)
            except ValueError as error:
                try:
                    # macOS /var resolves to /private/var; both refer to the
                    # supplied real cache. Model/file symlinks are checked below.
                    relative = candidate.relative_to(supplied_root)
                except ValueError:
                    raise ModelIntegrityError("Checkpoint is outside the trusted cache") from error
            if len(relative.parts) != 2 or relative.parts[1] != "model.pt":
                raise ModelIntegrityError("Unknown checkpoint")
            repository = relative.parts[0]
            record = _model_record(repository, authority)
            directory = verify_model_directory(cache_root, repository, manifest=authority)
            with _open_verified(_checked_file(directory, "model.pt"), record["files"]["model.pt"]) as source:
                _reject_torchscript(source)
                torch_module.serialization.clear_safe_globals()
                kwargs["weights_only"] = True
                kwargs["map_location"] = "cpu"
                return original(source, **kwargs)

        def forbidden_jit_load(*_args, **_kwargs):
            raise ModelIntegrityError("TorchScript checkpoint loading is forbidden")

        torch_module.load = restricted_load
        torch_module.jit.load = forbidden_jit_load


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Verify pinned model bytes without importing Torch")
    parser.add_argument("--verify-root", required=True)
    arguments = parser.parse_args()
    manifest = load_manifest()
    details = {}
    for repository in manifest["models"]:
        try:
            directory = verify_model_directory(arguments.verify_root, repository, manifest=manifest)
            details[repository] = {"success": True, "path": str(directory)}
        except (ModelIntegrityError, OSError) as error:
            details[repository] = {"success": False, "error": str(error)}
    print(json.dumps({"success": all(value["success"] for value in details.values()) and bool(details), "details": details}))


if __name__ == "__main__":
    main()
