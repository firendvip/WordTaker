#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FunASR模型下载脚本
并行下载所有模型文件
"""

import sys
import json
import threading
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.parse
import urllib.request
import uuid

from pytorch_model_security import (
    ModelIntegrityError, _model_record, enforce_weights_only_environment,
    load_manifest, verify_model_directory,
)

enforce_weights_only_environment(os.environ)


class HTTPSRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if urllib.parse.urlparse(new_url).scheme != "https":
            raise ModelIntegrityError("Model download cannot downgrade HTTPS")
        return super().redirect_request(request, response, code, message, headers, new_url)


def download_verified_model(root, repository, *, manifest=None, opener=None, progress_callback=None):
    """Raw immutable bytes only; no FunASR, pickle or checkpoint imports."""
    authority = load_manifest() if manifest is None else manifest
    record = _model_record(repository, authority)
    supplied_root = Path(root).absolute()
    if supplied_root.is_symlink():
        raise ModelIntegrityError("Symlinked cache root is forbidden")
    supplied_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = supplied_root.resolve(strict=True)
    target = root / repository
    retired = root / ".retired"
    if target.is_symlink() or retired.is_symlink():
        raise ModelIntegrityError("Symlinked model or retirement directory is forbidden")
    try:
        return verify_model_directory(root, repository, manifest=authority)
    except ModelIntegrityError:
        pass  # Never trust an existence/size-only cache hit.
    open_request = opener or urllib.request.build_opener(HTTPSRedirectHandler()).open
    total_bytes = sum(pin["size"] for pin in record["files"].values())
    completed_bytes = 0
    with tempfile.TemporaryDirectory(prefix=".wordtaker-download-", dir=root) as temporary:
        staging_root = Path(temporary)
        directory = staging_root / repository
        directory.mkdir(mode=0o700)
        for name, pin in record["files"].items():
            filename = directory / name
            filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            query = urllib.parse.urlencode({"Revision": record["commit"], "FilePath": name})
            url = f"https://www.modelscope.cn/api/v1/models/{record['repository']}/repo?{query}"
            request = urllib.request.Request(url, headers={"User-Agent": "WordTaker-model-verifier/1"})
            size = 0
            digest = hashlib.sha256()
            with open_request(request, timeout=60) as response, filename.open("xb") as output:
                if urllib.parse.urlparse(response.geturl()).scheme != "https":
                    raise ModelIntegrityError("Model download cannot downgrade HTTPS")
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    size += len(block)
                    if size > pin["size"]:
                        raise ModelIntegrityError("Model download exceeded trusted size")
                    output.write(block)
                    digest.update(block)
                    if progress_callback:
                        progress_callback(min(99, 100 * (completed_bytes + size) / max(1, total_bytes)))
            if size != pin["size"] or digest.hexdigest() != pin["sha256"]:
                raise ModelIntegrityError("Model download does not match trusted content")
            completed_bytes += size
        verify_model_directory(staging_root, repository, manifest=authority)
        backup = None
        if target.exists():
            if target.is_symlink() or retired.is_symlink():
                raise ModelIntegrityError("Model cache changed during download")
            retired.mkdir(mode=0o700, exist_ok=True)
            backup = retired / f"{repository}-{uuid.uuid4().hex}"
            target.rename(backup)
        try:
            directory.rename(target)
        except OSError:
            if backup is not None:
                backup.rename(target)
            raise
    return verify_model_directory(root, repository, manifest=authority)

def download_model(model_config, progress_callback=None, *, cache_root=None):
    """下载单个模型"""
    model_name = model_config["name"]
    model_type = model_config["type"]
    
    try:
        if progress_callback:
            progress_callback(model_type, "downloading", 0)
        if not cache_root:
            raise ModelIntegrityError("必须指定可信模型缓存目录")
        download_verified_model(
            cache_root, model_name.split("/", 1)[1],
            progress_callback=(lambda percent: progress_callback(model_type, "downloading", round(percent, 1))) if progress_callback else None,
        )
        
        if progress_callback:
            progress_callback(model_type, "completed", 100)
            
        return {"success": True, "model": model_type}
        
    except Exception as e:
        if progress_callback:
            progress_callback(model_type, "error", 0, str(e))
        return {"success": False, "model": model_type, "error": str(e)}

def main():
    """主函数：并行下载所有模型"""
    
    parser = argparse.ArgumentParser()
    # Electron supplies its private userData explicitly. Standalone legacy
    # preparation commands use a WordTaker-only cache, never the shared hub.
    private_data = Path(os.environ["ELECTRON_USER_DATA"]) if os.environ.get("ELECTRON_USER_DATA") else Path.home() / ".cache" / "wordtaker"
    parser.add_argument("--damo-root", default=str(private_data / "models" / "damo"))
    args = parser.parse_args()

    # 模型配置
    models = [
        {
            "name": "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "type": "asr"
        },
        {
            "name": "damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "type": "vad"
        },
        {
            "name": "damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
            "type": "punc"
        }
    ]
    
    # 进度跟踪
    progress = {"asr": 0, "vad": 0, "punc": 0}
    results = {}
    completed_count = 0
    total_count = len(models)
    progress_lock = threading.Lock()  # 保护 completed_count/progress 的并发更新，避免丢失计数

    def progress_callback(model_type, stage, percent, error=None):
        nonlocal completed_count

        # progress_callback 由多个下载线程并发调用，整体加锁保证计数与进度一致
        with progress_lock:
            if stage == "downloading":
                progress[model_type] = percent
            elif stage == "completed":
                progress[model_type] = 100
                completed_count += 1
            elif stage == "error":
                progress[model_type] = 0
                completed_count += 1

            # 计算总体进度
            overall_progress = sum(progress.values()) / total_count
            completed_snapshot = completed_count
        
            # Keep each JSON line contiguous across the three download threads.
            status = {
                "stage": stage,
                "model": model_type,
                "progress": percent,
                "overall_progress": round(overall_progress, 1),
                "completed": completed_snapshot,
                "total": total_count
            }
            if error:
                status["error"] = error
            print(json.dumps(status, ensure_ascii=False))
            sys.stdout.flush()
    
    # 启动并行下载线程
    threads = []
    for model_config in models:
        thread = threading.Thread(
            target=lambda config=model_config: results.update({
                config["type"]: download_model(config, progress_callback, cache_root=args.damo_root)
            })
        )
        thread.start()
        threads.append(thread)
    
    # 等待所有线程完成
    for thread in threads:
        thread.join()
    
    # 检查结果
    failed_models = [model_type for model_type, result in results.items() if not result["success"]]
    
    if failed_models:
        final_result = {
            "success": False,
            "error": f"以下模型下载失败: {', '.join(failed_models)}",
            "failed_models": failed_models,
            "results": results
        }
    else:
        final_result = {
            "success": True,
            "message": "所有模型下载完成",
            "results": results
        }
    
    print(json.dumps(final_result, ensure_ascii=False))
    sys.stdout.flush()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e)
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)
