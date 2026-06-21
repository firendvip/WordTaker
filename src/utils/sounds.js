// 语音输入唤起/结束提示音（用 Web Audio 实时合成，无需任何音频文件、无版权问题）。
// 提供多套方案，含"无声"。音量 0~1。

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

// 可爱合成"喵"（小奶猫）：双振荡器(triangle+sawtooth微失谐) + 颤音LFO + 带通共振峰扫频，
// 音高上扬后下滑，约 0.34s。完全 Web Audio 合成，无音频文件、无版权问题。
function meow({ vol = 0.3, when = 0, base = 1, dur = 0.34 } = {}) {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + when;
  const tEnd = t0 + dur;

  // 共振峰带通滤波（formant），频率随时间扫描，制造"喵"的张口/闭口感
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.setValueAtTime(6, t0);
  filter.frequency.setValueAtTime(850 * base, t0);
  filter.frequency.linearRampToValueAtTime(1350 * base, t0 + dur * 0.35);
  filter.frequency.linearRampToValueAtTime(750 * base, tEnd);

  // 主增益（幅度包络）：快速起音 → 柔和衰减到 0
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, tEnd);

  // 颤音 LFO：约 16Hz、深度约 12Hz，作用到两个振荡器的 frequency
  const lfo = ac.createOscillator();
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(16, t0);
  const lfoGain = ac.createGain();
  lfoGain.gain.setValueAtTime(12 * base, t0);
  lfo.connect(lfoGain);

  // 音高轮廓：560 → 820（上扬）→ 430（下滑）
  const f0 = 560 * base;
  const f1 = 820 * base;
  const f2 = 430 * base;

  const oscs = [
    { type: "triangle", detune: 0, mix: 0.9 },
    { type: "sawtooth", detune: 6, mix: 0.45 },
  ].map(({ type, detune, mix }) => {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.detune.setValueAtTime(detune, t0);
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.linearRampToValueAtTime(f1, t0 + dur * 0.28);
    osc.frequency.exponentialRampToValueAtTime(f2, tEnd);
    lfoGain.connect(osc.frequency);
    const mg = ac.createGain();
    mg.gain.setValueAtTime(mix, t0);
    osc.connect(mg);
    mg.connect(filter);
    return { osc, mg };
  });

  filter.connect(g);
  g.connect(ac.destination);

  const startAt = t0;
  const stopAt = tEnd + 0.04;
  lfo.start(startAt);
  oscs.forEach(({ osc }) => osc.start(startAt));
  lfo.stop(stopAt);
  oscs.forEach(({ osc }) => osc.stop(stopAt));

  // 清理：结束后断开所有节点，避免泄漏
  const cleanup = () => {
    try {
      lfo.disconnect();
      lfoGain.disconnect();
      oscs.forEach(({ osc, mg }) => {
        osc.disconnect();
        mg.disconnect();
      });
      filter.disconnect();
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
    // 唤起：单声清亮小奶猫"喵～"
    wake(v) {
      meow({ vol: v, base: 1 });
    },
    // 结束：略低音的轻柔双喵"喵喵"，与唤起区分
    end(v) {
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

// 应用加载即创建/恢复音频上下文，预热掉首次唤起的冷启动延迟
export function warmupAudio() {
  ensureRunning();
}

export async function playWake(scheme, volume) {
  try {
    await ensureRunning();
    (SCHEMES[scheme] || SCHEMES.soft).wake(clampVol(volume));
  } catch (e) {
    // 忽略
  }
}

export async function playEnd(scheme, volume) {
  try {
    await ensureRunning();
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
