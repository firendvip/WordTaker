"""Decode application audio to FunASR's 16 kHz float32 ndarray input.

The renderer already sends PCM WAV. Soundfile also retains its existing AIFF/
FLAC support. Do not peak-normalize or clip: PCM scaling and channel averaging
match the previous file-input loader, without TorchCodec or external FFmpeg.
"""
from math import gcd

import numpy as np
import soundfile as sf


def load_funasr_audio(filename):
    try:
        samples, rate = sf.read(filename, dtype="float32", always_2d=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("音频文件无法解码") from error
    if rate <= 0 or samples.ndim != 2 or samples.shape[0] == 0 or samples.shape[1] == 0:
        raise ValueError("音频为空或采样率/声道无效")
    if not np.isfinite(samples).all():
        raise ValueError("音频包含非有限采样值")
    audio = samples.mean(axis=1, dtype=np.float32)
    if rate != 16000:
        # Existing scientific runtime, no codec stack and no system decoder.
        from scipy.signal import resample_poly
        factor = gcd(int(rate), 16000)
        audio = resample_poly(audio, 16000 // factor, int(rate) // factor)
    return np.ascontiguousarray(audio, dtype=np.float32)
