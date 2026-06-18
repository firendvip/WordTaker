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
  { value: "none", label: "无声" },
];
