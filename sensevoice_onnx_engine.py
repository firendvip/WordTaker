# -*- coding: utf-8 -*-
"""
SenseVoice-Small ONNX 推理引擎（纯 numpy 前端）。

仅依赖 numpy + onnxruntime + soundfile。
不依赖 torch / funasr_onnx / kaldi-native-fbank / librosa，
适配 Windows-ARM64（这些库无可用 wheel）的场景。

复刻 funasr_onnx.SenseVoiceSmallONNX 的推理流水线：
  load wav -> kaldi fbank(80 mel) -> LFR(7,6) -> CMVN -> ONNX -> CTC 贪心解码
"""

import os
import re
import sys

import numpy as np
import onnxruntime
import soundfile as sf

# ---- Kaldi fbank 常量（与 funasr 默认一致）----
SAMPLE_RATE = 16000
FRAME_LENGTH_MS = 25.0       # 帧长 25ms -> 400 采样点
FRAME_SHIFT_MS = 10.0        # 帧移 10ms -> 160 采样点
N_MELS = 80
PREEMPH_COEFF = 0.97
LOW_FREQ = 20.0
HIGH_FREQ = 8000.0
WAVEFORM_SCALE = float(1 << 15)  # 32768，Kaldi 把 [-1,1] 波形放大
EPS = np.finfo(np.float32).eps   # log 下限，避免 log(0)


def _next_pow2(n):
    """返回 >= n 的最小 2 的幂。"""
    p = 1
    while p < n:
        p <<= 1
    return p


def _mel_scale(freq):
    """Kaldi mel 刻度：mel(f) = 1127 * ln(1 + f/700)。"""
    return 1127.0 * np.log(1.0 + freq / 700.0)


def _make_mel_filterbank(num_bins, fft_size, sample_rate, low_freq, high_freq):
    """
    构造 Kaldi 风格三角 mel 滤波器组。
    返回 shape (num_bins, num_fft_bins) 的权重矩阵，num_fft_bins = fft_size//2 + 1。
    """
    num_fft_bins = fft_size // 2 + 1
    nyquist = sample_rate / 2.0
    if high_freq <= 0.0:
        high_freq = nyquist
    fft_bin_width = sample_rate / fft_size

    mel_low = _mel_scale(low_freq)
    mel_high = _mel_scale(high_freq)
    # num_bins + 2 个等间距 mel 点，构成 num_bins 个三角形
    mel_points = np.linspace(mel_low, mel_high, num_bins + 2)

    fb = np.zeros((num_bins, num_fft_bins), dtype=np.float64)
    # 每个 fft bin 的中心频率 -> mel
    bin_freqs = fft_bin_width * np.arange(num_fft_bins)
    bin_mels = _mel_scale(bin_freqs)

    for m in range(num_bins):
        left, center, right = mel_points[m], mel_points[m + 1], mel_points[m + 2]
        for k in range(num_fft_bins):
            mel = bin_mels[k]
            if mel <= left or mel >= right:
                continue
            if mel <= center:
                fb[m, k] = (mel - left) / (center - left)
            else:
                fb[m, k] = (right - mel) / (right - center)
    return fb


class SenseVoiceOnnxEngine:
    """SenseVoice-Small ONNX 推理引擎。"""

    def __init__(self, model_dir, quantize=True, device_id="-1", intra_op_num_threads=4):
        model_name = "model_quant.onnx" if quantize else "model.onnx"
        model_file = os.path.join(model_dir, model_name)
        if not os.path.exists(model_file):
            raise FileNotFoundError("模型文件不存在: %s" % model_file)

        # CMVN（倒谱均值方差归一化参数）
        cmvn_file = os.path.join(model_dir, "am.mvn")
        self.cmvn = self.load_cmvn(cmvn_file)

        # LFR 参数：从 config.yaml 解析（无 PyYAML，简单行扫描）
        self.lfr_m, self.lfr_n = self._read_lfr(os.path.join(model_dir, "config.yaml"))

        # fbank 派生参数
        self.frame_length = int(SAMPLE_RATE * FRAME_LENGTH_MS / 1000.0)  # 400
        self.frame_shift = int(SAMPLE_RATE * FRAME_SHIFT_MS / 1000.0)    # 160
        self.fft_size = _next_pow2(self.frame_length)                    # 512
        self.window = np.hamming(self.frame_length).astype(np.float64)
        self.mel_fb = _make_mel_filterbank(
            N_MELS, self.fft_size, SAMPLE_RATE, LOW_FREQ, HIGH_FREQ
        )

        # 创建 onnxruntime 会话（CPU）
        sess_opts = onnxruntime.SessionOptions()
        sess_opts.intra_op_num_threads = int(intra_op_num_threads)
        self.session = onnxruntime.InferenceSession(
            model_file,
            sess_options=sess_opts,
            providers=["CPUExecutionProvider"],
        )
        self.input_names = [inp.name for inp in self.session.get_inputs()]
        self.blank_id = 0

    # ---------------- 配置解析 ----------------
    @staticmethod
    def _read_lfr(config_file):
        """从 config.yaml 行扫描 lfr_m / lfr_n，找不到则默认 7 / 6。"""
        lfr_m, lfr_n = 7, 6
        if not os.path.exists(config_file):
            return lfr_m, lfr_n
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                text = f.read()
            m = re.search(r"lfr_m\s*:\s*(\d+)", text)
            n = re.search(r"lfr_n\s*:\s*(\d+)", text)
            if m:
                lfr_m = int(m.group(1))
            if n:
                lfr_n = int(n.group(1))
        except Exception:
            pass
        return lfr_m, lfr_n

    # ---------------- 提供方指定的纯 numpy 函数（逐字使用）----------------
    @staticmethod
    def apply_lfr(inputs, lfr_m, lfr_n):
        LFR_inputs = []
        T = inputs.shape[0]
        T_lfr = int(np.ceil(T / lfr_n))
        left_padding = np.tile(inputs[0], ((lfr_m - 1) // 2, 1))
        inputs = np.vstack((left_padding, inputs))
        T = T + (lfr_m - 1) // 2
        for i in range(T_lfr):
            if lfr_m <= T - i * lfr_n:
                LFR_inputs.append((inputs[i * lfr_n : i * lfr_n + lfr_m]).reshape(1, -1))
            else:
                num_padding = lfr_m - (T - i * lfr_n)
                frame = inputs[i * lfr_n :].reshape(-1)
                for _ in range(num_padding):
                    frame = np.hstack((frame, inputs[-1]))
                LFR_inputs.append(frame)
        return np.vstack(LFR_inputs).astype(np.float32)

    @staticmethod
    def apply_cmvn(inputs, cmvn):  # cmvn shape (2, dim): row0=means, row1=vars
        frame, dim = inputs.shape
        means = np.tile(cmvn[0:1, :dim], (frame, 1))
        vars = np.tile(cmvn[1:2, :dim], (frame, 1))
        return (inputs + means) * vars

    @staticmethod
    def load_cmvn(cmvn_file):  # 解析 am.mvn
        with open(cmvn_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        means_list = []
        vars_list = []
        for i in range(len(lines)):
            line_item = lines[i].split()
            if not line_item:  # 跳过空行
                continue
            if line_item[0] == "<AddShift>":
                line_item = lines[i + 1].split()
                if line_item and line_item[0] == "<LearnRateCoef>":
                    means_list = list(line_item[3 : (len(line_item) - 1)])
                    continue
            elif line_item[0] == "<Rescale>":
                line_item = lines[i + 1].split()
                if line_item and line_item[0] == "<LearnRateCoef>":
                    vars_list = list(line_item[3 : (len(line_item) - 1)])
                    continue
        means = np.array(means_list).astype(np.float64)
        vars = np.array(vars_list).astype(np.float64)
        return np.array([means, vars])

    # ---------------- Kaldi fbank（纯 numpy）----------------
    def compute_fbank(self, waveform):
        """
        计算 Kaldi 风格 fbank 特征。
        waveform: float32 [-1,1] 的单通道波形。
        返回 (num_frames, N_MELS) 的 log-mel 能量。
        """
        wav = waveform.astype(np.float64) * WAVEFORM_SCALE
        num_samples = wav.shape[0]
        flen = self.frame_length
        fshift = self.frame_shift

        # snip_edges=True 的帧数公式
        if num_samples < flen:
            return np.zeros((0, N_MELS), dtype=np.float32)
        num_frames = 1 + (num_samples - flen) // fshift

        # 切帧：shape (num_frames, flen)
        idx = np.arange(num_frames)[:, None] * fshift + np.arange(flen)[None, :]
        frames = wav[idx]

        # 1) dither: 0.0，跳过
        # 2) remove_dc_offset: 每帧减去均值
        frames = frames - frames.mean(axis=1, keepdims=True)
        # 3) preemphasis 0.97（Kaldi 对首样本做填充）
        pre = np.empty_like(frames)
        pre[:, 0] = frames[:, 0] - PREEMPH_COEFF * frames[:, 0]
        pre[:, 1:] = frames[:, 1:] - PREEMPH_COEFF * frames[:, :-1]
        frames = pre
        # 4) 加 hamming 窗
        frames = frames * self.window[None, :]

        # 功率谱：|rfft|^2，FFT 大小 512
        spectrum = np.fft.rfft(frames, n=self.fft_size, axis=1)
        power = (spectrum.real ** 2) + (spectrum.imag ** 2)

        # mel 滤波 + log（带能量下限）
        mel_energy = power @ self.mel_fb.T  # (num_frames, N_MELS)
        mel_energy = np.maximum(mel_energy, EPS)
        log_mel = np.log(mel_energy)
        return log_mel.astype(np.float32)

    # ---------------- 音频加载 ----------------
    @staticmethod
    def _load_wav(path):
        """soundfile 读取 -> 单通道 float32 [-1,1] -> 重采样到 16k。"""
        data, sr = sf.read(path, dtype="float32", always_2d=False)
        if data.ndim > 1:  # 立体声取第 0 声道
            data = data[:, 0]
        data = data.astype(np.float32)
        if sr != SAMPLE_RATE:  # np.interp 线性重采样
            duration = data.shape[0] / float(sr)
            new_len = int(round(duration * SAMPLE_RATE))
            if new_len <= 0:
                return np.zeros((0,), dtype=np.float32)
            old_t = np.linspace(0.0, duration, num=data.shape[0], endpoint=False)
            new_t = np.linspace(0.0, duration, num=new_len, endpoint=False)
            data = np.interp(new_t, old_t, data).astype(np.float32)
        return data

    # ---------------- 特征提取（单条）----------------
    def extract_feat(self, waveform):
        """fbank -> LFR -> CMVN，返回 (T_lfr, 560) float32。"""
        fbank = self.compute_fbank(waveform)
        feat = self.apply_lfr(fbank, self.lfr_m, self.lfr_n)
        feat = self.apply_cmvn(feat, self.cmvn)
        return feat.astype(np.float32)

    # ---------------- CTC 贪心解码 ----------------
    @staticmethod
    def _ctc_greedy_decode(logits, valid_len, blank_id):
        """
        logits: (T, vocab)；valid_len: 有效帧数。
        argmax -> 折叠连续重复 -> 去除 blank。返回 token id 列表。
        """
        seq = logits[:valid_len, :]
        ids = np.argmax(seq, axis=-1)
        if ids.shape[0] == 0:
            return []
        # numpy 实现 unique_consecutive（折叠相邻重复）
        keep = np.concatenate(([True], ids[1:] != ids[:-1]))
        ids = ids[keep]
        ids = ids[ids != blank_id]
        return [int(x) for x in ids.tolist()]

    # ---------------- ONNX 输入绑定 ----------------
    def _build_feed(self, feats, feats_len, language, textnorm):
        """
        按输入「语义名」绑定，避免按位置喂入在模型重新导出、输入顺序变化时静默错配。
        SenseVoice-Small 量化模型的输入名为：speech / speech_lengths / language / textnorm。
        对未知命名做关键字匹配；都匹配不到时回退到按位置顺序（与历史行为一致）。
        """
        ordered = [feats, feats_len, language, textnorm]
        names = self.input_names

        # 关键字 -> 对应张量；按名字里的语义子串匹配。
        def pick(name):
            n = name.lower()
            if "length" in n or "len" in n:
                return feats_len
            if "speech" in n or "feat" in n or "input" in n:
                return feats
            if "lang" in n:
                return language
            if "textnorm" in n or "norm" in n or "text" in n:
                return textnorm
            return None

        feed = {}
        matched_all = True
        for i, name in enumerate(names):
            val = pick(name)
            if val is None:
                matched_all = False
                break
            feed[name] = val

        if not matched_all or len(feed) != len(names):
            # 回退：按位置顺序绑定（与 funasr_onnx 一致：feats, feats_len, language, textnorm）
            feed = {name: ordered[i] for i, name in enumerate(names)}
        return feed

    # ---------------- 推理入口 ----------------
    def __call__(self, wav_paths, language, textnorm):
        """
        wav_paths: list[str]
        language / textnorm: int 列表（如 [0] / [14]）
        返回：每条音频的 token-id 列表（list[list[int]]）。
        """
        if isinstance(wav_paths, str):
            wav_paths = [wav_paths]

        results = []
        for path in wav_paths:
            waveform = self._load_wav(path)
            feat = self.extract_feat(waveform)  # (T_lfr, 560)

            feats = feat[None, :, :].astype(np.float32)              # [1, T, 560]
            feats_len = np.array([feat.shape[0]], dtype=np.int32)     # [1]
            lang = np.array(language, dtype=np.int32)                 # [B]
            tnorm = np.array(textnorm, dtype=np.int32)                # [B]

            feed = self._build_feed(feats, feats_len, lang, tnorm)
            outputs = self.session.run(None, feed)
            ctc_logits = outputs[0]          # [B, T, vocab]
            encoder_out_lens = outputs[1]    # [B]

            valid_len = int(np.asarray(encoder_out_lens).reshape(-1)[0])
            tokens = self._ctc_greedy_decode(ctc_logits[0], valid_len, self.blank_id)
            results.append(tokens)
        return results


# ---------------- 自测入口 ----------------
if __name__ == "__main__":
    # 用法: python sensevoice_onnx_engine.py <wav_path> <model_dir>
    if len(sys.argv) < 3:
        print("用法: python sensevoice_onnx_engine.py <wav_path> <model_dir>")
        sys.exit(0)
    wav_path = sys.argv[1]
    model_dir = sys.argv[2]
    engine = SenseVoiceOnnxEngine(model_dir, quantize=True)
    out = engine(wav_path, language=[0], textnorm=[14])
    print("token ids:", out)
