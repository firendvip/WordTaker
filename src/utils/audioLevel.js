// 电平使用时域 RMS；频谱分段均值用于画声波，不适合作为“是否说话”的音量。
// 约 -50 dB 以下视为底噪，较轻的语音也有可见反馈；不改变录音数据或输入设备。
export function audioLevelFromSamples(samples) {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) {
    if (Number.isFinite(sample)) energy += sample * sample;
  }
  const rms = Math.sqrt(energy / samples.length);
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.003) / 0.06));
}
