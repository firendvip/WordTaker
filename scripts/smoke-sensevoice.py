#!/usr/bin/env python3
"""Load the packaged SenseVoice engine and run repeatable local inference smoke."""

import argparse
import json
import os
import sys
import time


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from sensevoice_onnx_engine import SenseVoiceOnnxEngine  # noqa: E402


def decode(token_ids, tokens):
    pieces = []
    for token_id in token_ids:
        if 0 <= token_id < len(tokens):
            token = tokens[token_id]
            if token.startswith("<") and token.endswith(">"):
                continue
            pieces.append(token)
    return "".join(pieces).replace("▁", " ").strip().rstrip("。.")


def run_smoke(audio_path, model_dir, iterations):
    started = time.perf_counter()
    engine = SenseVoiceOnnxEngine(
        model_dir,
        quantize=True,
        device_id="-1",
    )
    load_seconds = time.perf_counter() - started

    with open(os.path.join(model_dir, "tokens.json"), "r", encoding="utf-8") as handle:
        tokens = json.load(handle)

    inference_seconds = []
    texts = []
    for _ in range(iterations):
        started = time.perf_counter()
        results = engine([audio_path], language=[0], textnorm=[14])
        inference_seconds.append(round(time.perf_counter() - started, 3))
        token_ids = results[0] if results else []
        texts.append(decode(token_ids, tokens))

    if not all(text.strip() for text in texts):
        raise RuntimeError("SenseVoice smoke 未识别出非空文本")
    if len(set(texts)) != 1:
        raise RuntimeError(f"SenseVoice 连续推理结果不稳定: {texts}")

    return {
        "success": True,
        "actual_engine": "sensevoice",
        "model_type": "sensevoice-onnx-numpy",
        "providers": engine.session.get_providers(),
        "load_seconds": round(load_seconds, 3),
        "inference_seconds": inference_seconds,
        "text": texts[0],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="本地 WAV/AIFF/FLAC 测试音频")
    parser.add_argument(
        "--model-dir",
        default=os.path.join(PROJECT_ROOT, "models", "sensevoice"),
    )
    parser.add_argument("--iterations", type=int, default=3)
    args = parser.parse_args()

    if args.iterations < 1:
        parser.error("--iterations 必须至少为 1")
    if not os.path.isfile(args.audio_path):
        parser.error(f"音频不存在: {args.audio_path}")

    print(json.dumps(
        run_smoke(args.audio_path, args.model_dir, args.iterations),
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
