"""Real temporary audio fixtures, without FFmpeg or TorchCodec."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

from funasr_audio import load_funasr_audio


class FunASRAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def audio(self, data, rate=16000, suffix=".wav", subtype="PCM_16"):
        path = self.root / ("fixture" + suffix)
        sf.write(path, data, rate, subtype=subtype)
        return path

    def test_real_mono_pcm_wav_retains_samples_rate_and_normalization(self):
        samples = np.sin(np.arange(1600, dtype=np.float32) * np.float32(.08)) * np.float32(.25)
        path = self.audio(samples)
        actual = load_funasr_audio(path)
        self.assertEqual(actual.dtype, np.dtype("float32"))
        self.assertEqual(actual.shape, (1600,))
        np.testing.assert_allclose(actual, samples, atol=1 / 32768)
        self.assertTrue(actual.flags.c_contiguous)

    def test_stereo_uses_channel_mean_not_peak_normalization(self):
        data = np.column_stack([np.full(800, .5), np.full(800, -.25)])
        actual = load_funasr_audio(self.audio(data))
        np.testing.assert_allclose(actual, .125, atol=1 / 32768)

    def test_non_16k_rates_preserve_duration_and_audible_frequency(self):
        for rate in [8000, 44100, 48000]:
            with self.subTest(rate=rate):
                data = np.sin(np.arange(rate, dtype=np.float32) * np.float32(2 * np.pi * 400 / rate)) * .3
                actual = load_funasr_audio(self.audio(data, rate))
                self.assertEqual(len(actual), 16000)
                peak = np.argmax(np.abs(np.fft.rfft(actual)))
                self.assertEqual(peak, 400)
                self.assertLess(np.max(np.abs(actual)), .32)

    def test_silent_short_and_long_wav_need_no_external_decoder(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("No FFmpeg")), mock.patch("subprocess.Popen", side_effect=AssertionError("No FFmpeg")):
            for length in [1, 1600, 16000 * 61]:
                actual = load_funasr_audio(self.audio(np.zeros(length, dtype=np.float32)))
                self.assertEqual(len(actual), length)
                self.assertFalse(np.any(actual))

    def test_existing_soundfile_formats_remain_supported(self):
        for suffix in [".aiff", ".flac"]:
            with self.subTest(suffix=suffix):
                actual = load_funasr_audio(self.audio(np.full(1600, .2), suffix=suffix))
                np.testing.assert_allclose(actual, .2, atol=1 / 32768)

    def test_empty_corrupt_missing_and_nonfinite_audio_fail_before_model_dispatch(self):
        for source in [self.audio(np.empty(0, dtype=np.float32)), self.root / "missing.wav"]:
            with self.assertRaises(ValueError):
                load_funasr_audio(source)
        corrupt = self.root / "corrupt.wav"
        corrupt.write_bytes(b"harmless non-audio bytes")
        with self.assertRaises(ValueError):
            load_funasr_audio(corrupt)
        for value in [np.nan, np.inf]:
            path = self.audio(np.array([value, .2], dtype=np.float32), subtype="FLOAT")
            with self.assertRaises(ValueError):
                load_funasr_audio(path)

    def test_invalid_sample_rate_and_channels_fail_closed(self):
        for data, rate in [(np.zeros((1, 1), dtype=np.float32), 0), (np.zeros((1, 0), dtype=np.float32), 16000)]:
            with mock.patch("soundfile.read", return_value=(data, rate)):
                with self.assertRaises(ValueError):
                    load_funasr_audio("fixture.wav")


if __name__ == "__main__":
    unittest.main()
