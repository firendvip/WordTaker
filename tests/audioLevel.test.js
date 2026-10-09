import { describe, expect, it } from 'vitest';
import { audioLevelFromSamples } from '../src/utils/audioLevel.js';

describe('microphone time-domain level', () => {
  it('returns zero for silence and an empty buffer', () => {
    expect(audioLevelFromSamples(new Float32Array(512))).toBe(0);
    expect(audioLevelFromSamples(new Float32Array())).toBe(0);
  });
  it('ignores the low background noise floor', () => {
    expect(audioLevelFromSamples(new Float32Array(512).fill(0.001))).toBe(0);
  });
  it('makes quiet speech visible rather than averaging it away across frequency bins', () => {
    const speech = Float32Array.from({ length: 512 }, (_, i) => 0.018 * Math.sin(i / 4));
    expect(audioLevelFromSamples(speech)).toBeGreaterThan(0.35);
  });
  it('increases with volume and clamps loud input', () => {
    const quiet = audioLevelFromSamples(new Float32Array(512).fill(0.01));
    const normal = audioLevelFromSamples(new Float32Array(512).fill(0.03));
    expect(normal).toBeGreaterThan(quiet);
    expect(audioLevelFromSamples(new Float32Array(512).fill(1))).toBe(1);
  });
  it('measures negative samples equally and fails safely on invalid samples', () => {
    expect(audioLevelFromSamples(new Float32Array([0.03, -0.03]))).toBeCloseTo(audioLevelFromSamples(new Float32Array([0.03, 0.03])));
    expect(audioLevelFromSamples(new Float32Array([NaN, Infinity]))).toBe(0);
  });
});
