// 语音输入唤起/结束提示音（用 Web Audio 实时合成，无需任何音频文件、无版权问题）。
// 提供多套方案，含"无声"。音量 0~1。
//
// 例外：「喵」方案改用真实免版权猫叫样本（OpenGameArt "Meow" by IgnasD，
// 许可 CC0 公共领域，可商用、无需署名；来源 https://opengameart.org/content/meow）。
// 由 Vite 打包静态资源，解码一次并缓存 AudioBuffer；解码/播放失败则回退到原合成喵。

import meowUrl from "../assets/meow.mp3";

let _ctx = null;

function ctx() {
  if (!_ctx) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      _ctx = Ctor ? new Ctor() : null;
    } catch (e) {
      _ctx = null;
    }
  }
  return _ctx;
}

function clampVol(v) {
  v = Number(v);
  if (!isFinite(v)) v = 0.3;
  return Math.max(0, Math.min(1, v));
}

// 单个短音：带快速起音 + 指数衰减，听感干净不刺耳
function tone({ freq = 660, dur = 0.12, type = "sine", vol = 0.3, when = 0 }) {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + when;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// 可爱合成"喵"（小奶猫）：源-共振峰(formant)元音合成。
// 锯齿波声源 + 颤音LFO 作为"声带"，经 3 个并联带通"共振峰"滤波器塑形，
// 三个共振峰中心频率随时间在元音 mi(ee) → a → ow 之间滑动，模拟猫张口/闭口的"喵～"。
// 音高先升后降，约 0.4s。完全 Web Audio 合成，无音频文件、无版权问题。
function meow({ vol = 0.3, when = 0, base = 1, dur = 0.4 } = {}) {
  const ac = ctx();
  if (!ac) return;
  // 整体上移 ~7% 增加奶猫感
  const kitten = 1.07;
  const t0 = ac.currentTime + when;
  const tMid = t0 + dur * 0.4; // 元音 a 的时刻
  const tEnd = t0 + dur;

  // --- 声源：锯齿波 + 微失谐第二振荡器，音高 600→760→400（先升后降）---
  const pSrc = (f) => f * base * kitten;
  const p0 = pSrc(600);
  const p1 = pSrc(760);
  const p2 = pSrc(400);

  // 颤音 LFO：~14Hz、深度 ~10Hz，作用到声源 frequency
  const lfo = ac.createOscillator();
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(14, t0);
  const lfoGain = ac.createGain();
  lfoGain.gain.setValueAtTime(10 * base * kitten, t0);
  lfo.connect(lfoGain);

  const oscs = [
    { detune: 0, mix: 1.0 },
    { detune: 7, mix: 0.45 }, // +7 cents 微失谐
  ].map(({ detune, mix }) => {
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.detune.setValueAtTime(detune, t0);
    osc.frequency.setValueAtTime(p0, t0);
    osc.frequency.linearRampToValueAtTime(p1, t0 + dur * 0.3);
    osc.frequency.linearRampToValueAtTime(p2, tEnd);
    lfoGain.connect(osc.frequency);
    const mg = ac.createGain();
    mg.gain.setValueAtTime(mix, t0);
    osc.connect(mg);
    return { osc, mg };
  });

  // 声源汇总节点（喂给 3 个并联共振峰）
  const srcBus = ac.createGain();
  srcBus.gain.setValueAtTime(1, t0);
  oscs.forEach(({ mg }) => mg.connect(srcBus));

  // --- 三个并联带通"共振峰"，中心频率滑过元音 mi→a→ow ---
  // F1 最响、F2 中等、F3 最轻
  const FORMANTS = [
    { Q: 8, gain: 1.0, start: 320, mid: 720, end: 380 }, // F1
    { Q: 9, gain: 0.5, start: 2300, mid: 1200, end: 800 }, // F2
    { Q: 10, gain: 0.28, start: 3000, mid: 2600, end: 2400 }, // F3
  ].map(({ Q, gain, start, mid, end }) => {
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.setValueAtTime(Q, t0);
    bp.frequency.setValueAtTime(start * base * kitten, t0);
    bp.frequency.linearRampToValueAtTime(mid * base * kitten, tMid);
    bp.frequency.linearRampToValueAtTime(end * base * kitten, tEnd);
    const fg = ac.createGain();
    fg.gain.setValueAtTime(gain, t0);
    srcBus.connect(bp);
    bp.connect(fg);
    return { bp, fg };
  });

  // --- 起音"m"辅音：短暂低通收口，~30ms 内打开 ---
  const onset = ac.createBiquadFilter();
  onset.type = "lowpass";
  onset.Q.setValueAtTime(0.7, t0);
  onset.frequency.setValueAtTime(500 * base * kitten, t0);
  onset.frequency.linearRampToValueAtTime(6000 * base * kitten, t0 + 0.03);
  FORMANTS.forEach(({ fg }) => fg.connect(onset));

  // --- 幅度包络：快起音 ~15ms 到峰值，短保持，~0.42s 平滑衰减到 0 ---
  const g = ac.createGain();
  const peak = vol * 0.9;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.015);
  g.gain.setValueAtTime(peak, t0 + 0.1); // 短保持
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, 0.42) + 0.02);
  onset.connect(g);
  g.connect(ac.destination);

  const startAt = t0;
  const stopAt = t0 + Math.max(dur, 0.42) + 0.06;
  lfo.start(startAt);
  oscs.forEach(({ osc }) => osc.start(startAt));
  lfo.stop(stopAt);
  oscs.forEach(({ osc }) => osc.stop(stopAt));

  // 清理：结束后停止/断开所有节点，避免泄漏
  const cleanup = () => {
    try {
      lfo.disconnect();
      lfoGain.disconnect();
      oscs.forEach(({ osc, mg }) => {
        osc.disconnect();
        mg.disconnect();
      });
      srcBus.disconnect();
      FORMANTS.forEach(({ bp, fg }) => {
        bp.disconnect();
        fg.disconnect();
      });
      onset.disconnect();
      g.disconnect();
    } catch (e) {
      // 忽略
    }
  };
  oscs[0].osc.onended = cleanup;
}

// 方案：每套含 wake（唤起，上行）与 end（结束，下行/确认）
const SCHEMES = {
  none: { wake() {}, end() {} },
  soft: {
    wake(v) {
      tone({ freq: 523.25, dur: 0.12, type: "sine", vol: v });
      tone({ freq: 783.99, dur: 0.14, type: "sine", vol: v, when: 0.07 });
    },
    end(v) {
      tone({ freq: 783.99, dur: 0.1, type: "sine", vol: v });
      tone({ freq: 523.25, dur: 0.14, type: "sine", vol: v, when: 0.06 });
    },
  },
  crisp: {
    wake(v) {
      tone({ freq: 880, dur: 0.07, type: "triangle", vol: v });
    },
    end(v) {
      tone({ freq: 660, dur: 0.07, type: "triangle", vol: v });
      tone({ freq: 440, dur: 0.09, type: "triangle", vol: v, when: 0.055 });
    },
  },
  marimba: {
    wake(v) {
      tone({ freq: 587.33, dur: 0.18, type: "sine", vol: v });
      tone({ freq: 880, dur: 0.2, type: "sine", vol: v * 0.7, when: 0.02 });
    },
    end(v) {
      tone({ freq: 880, dur: 0.18, type: "sine", vol: v });
      tone({ freq: 587.33, dur: 0.2, type: "sine", vol: v * 0.7, when: 0.02 });
    },
  },
  meow: {
    // 唤起：真实 CC0 猫叫样本（解码失败时回退合成喵）
    wake(v) {
      if (playMeowSample(v)) return;
      meow({ vol: v, base: 1 });
    },
    // 结束：同一样本、略降音量（解码失败时回退合成双喵）
    end(v) {
      if (playMeowSample(v * 0.85)) return;
      meow({ vol: v * 0.95, base: 0.88, dur: 0.26 });
      meow({ vol: v * 0.8, base: 0.8, dur: 0.24, when: 0.2 });
    },
  },
};

// 触发动作来自全局快捷键（非页面内用户手势），AudioContext 可能处于 suspended。
// 必须 await resume() 后再排程音符，否则首个提示音会被丢弃 —— 这是"没声音"的根因。
async function ensureRunning() {
  const ac = ctx();
  if (!ac) return null;
  if (ac.state !== "running") {
    try {
      await ac.resume();
    } catch (e) {
      // 忽略
    }
  }
  return ac;
}

// --- 真实猫叫样本（CC0）：解码一次并缓存 AudioBuffer ---
let _meowBuf = null; // 解码后的 AudioBuffer
let _meowPromise = null; // 解码进行中的 Promise，避免重复请求
let _meowFailed = false; // 解码/加载失败标记，失败后直接回退合成喵

async function loadMeowBuffer() {
  if (_meowBuf) return _meowBuf;
  if (_meowFailed) return null;
  const ac = ctx();
  if (!ac) return null;
  if (!_meowPromise) {
    _meowPromise = (async () => {
      const res = await fetch(meowUrl);
      if (!res.ok) throw new Error(`meow fetch ${res.status}`);
      const arr = await res.arrayBuffer();
      // decodeAudioData 在部分浏览器仅支持回调式，做兼容包装
      const buf = await new Promise((resolve, reject) => {
        try {
          const p = ac.decodeAudioData(arr, resolve, reject);
          if (p && typeof p.then === "function") p.then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
      _meowBuf = buf;
      return buf;
    })().catch((e) => {
      _meowFailed = true;
      _meowPromise = null;
      return null;
    });
  }
  return _meowPromise;
}

// 预热：尽早解码样本，避免首次播放卡顿
export function warmupMeow() {
  loadMeowBuffer();
}

// 播放真实猫叫样本；返回 true 表示已成功排程，false 表示需回退合成喵
function playMeowSample(vol, when = 0) {
  const ac = ctx();
  if (!ac || !_meowBuf) return false;
  try {
    const src = ac.createBufferSource();
    src.buffer = _meowBuf;
    const g = ac.createGain();
    g.gain.setValueAtTime(clampVol(vol), ac.currentTime + when);
    src.connect(g);
    g.connect(ac.destination);
    src.start(ac.currentTime + when);
    src.onended = () => {
      try {
        src.disconnect();
        g.disconnect();
      } catch (e) {
        // 忽略
      }
    };
    return true;
  } catch (e) {
    return false;
  }
}

// 应用加载即创建/恢复音频上下文，预热掉首次唤起的冷启动延迟
export function warmupAudio() {
  ensureRunning();
  warmupMeow();
}

export async function playWake(scheme, volume) {
  try {
    await ensureRunning();
    if (scheme === "meow") await loadMeowBuffer();
    (SCHEMES[scheme] || SCHEMES.soft).wake(clampVol(volume));
  } catch (e) {
    // 忽略
  }
}

export async function playEnd(scheme, volume) {
  try {
    await ensureRunning();
    if (scheme === "meow") await loadMeowBuffer();
    (SCHEMES[scheme] || SCHEMES.soft).end(clampVol(volume));
  } catch (e) {
    // 忽略
  }
}

// 供设置页"试听"
export function previewSound(scheme, volume) {
  playWake(scheme, volume);
  setTimeout(() => playEnd(scheme, volume), 320);
}

export const SOUND_SCHEMES = [
  { value: "soft", label: "柔和" },
  { value: "crisp", label: "清脆" },
  { value: "marimba", label: "马林巴" },
  { value: "meow", label: "喵" },
  { value: "none", label: "无声" },
];
