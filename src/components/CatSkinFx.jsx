import { useEffect, useRef } from "react";

const K = "#1b1b1f";
const VOICE_THR = 0.35;
const LOUD_THR = 0.7;
const HOLD = 1000;
const HYST = 0.05;
const FX_DWELL = 300;
const ENTER_MS = 1400;
const RETURN_MS = 800;
const WALK_W = 0.022;
const PROC_W = 0.04;
// 效果锚点：贴近头顶斜上方（按运动方向 dir 取左右）
// 原型按 ~2.4x 放大，生产猫宽约 32px：水平小偏移 × dir，垂直略高于头
const FRONT_SIDE_X = 22; // 头部前侧水平偏移（px，× dir）——明显偏到运动方向一侧
const FRONT_UP_Y = -10; // 略高于头（上前方），避开脸部
const NOTE_FRONT_BIAS = 8; // 音符按朝向偏向前侧（px，× lastDir）
// 音符随机发射器
const NOTE_GLYPHS = ["♪", "♫", "♩", "♬"];
const NOTE_COLORS = ["#7DB4FF", "#F7A8CB", "#B197FC", "#5ED0C5", "#FCD34D", "#86E08C", "#FF9F6B", "#F472B6"];
const NOTE_MAX = 8;
const NOTE_SPAWN_NORMAL = 330; // ms between spawns (normal volume)
const NOTE_SPAWN_LOUD = 150; // ms between spawns (loud)
const NOTE_SPREAD = 14; // 起始 X 水平散布半径（px）
const NOTE_SIZE_MIN = 11;
const NOTE_SIZE_MAX = 15;
const NOTE_DX_MAX = 12; // 漂移幅度
const NOTE_DY_MIN = -22; // 上升最小
const NOTE_DY_MAX = -12; // 上升最大
const NOTE_ROT_MAX = 40; // 旋转幅度（deg）
const NOTE_DUR_MIN = 1.0;
const NOTE_DUR_MAX = 1.7;
const NOTE_DELAY_MAX = 0.25;
// 睡眠 Zzz：三个升序 Z，贴头顶
const ZZZ_CLASSES = ["cs-fxzz cs-fxzz-s", "cs-fxzz cs-fxzz-m", "cs-fxzz cs-fxzz-l"];
const ZZZ_DELAYS = ["0s", ".7s", "1.4s"]; // 错峰升起
const ZZZ_BASE_LEFT = 4; // 头顶基础水平偏移（px，× dir 朝外侧）
const ZZZ_STEP = 4; // 每个 Z 之间的水平步进（px）
// 按窗口底部锚定：趴睡猫在 .cs-sleeper{bottom:6px}，原生高 20px，头顶约离底 20px。
// Zzz 基座设到离底 ~22px，正好贴在趴睡猫头上方（之前用 top:4px 是从窗口顶部算，导致离头很远）。
const ZZZ_BOTTOM = 22; // 距窗口底部（px），紧贴趴睡猫头上方
function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

function eye(cx) {
  return `<ellipse cx="${cx}" cy="13" rx="2.6" ry="3.1" fill="#FDE047"/><ellipse cx="${cx + 0.3}" cy="13.5" rx="1" ry="1.9" fill="${K}"/><circle cx="${cx - 0.8}" cy="11.6" r=".7" fill="#fff"/>`;
}
const RUN_SVG = `<svg width="32" height="23" viewBox="0 0 46 32" xmlns="http://www.w3.org/2000/svg" style="display:block"><path class="cs-tail" d="M9 22 C 3 20, 3 11, 7 8" fill="none" stroke="${K}" stroke-width="3.6" stroke-linecap="round"/><rect class="cs-leg cs-lb" x="12" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-la" x="17" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-lb" x="23" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-la" x="28" y="24" width="3" height="5" rx="1.5" fill="${K}"/><ellipse cx="20" cy="21" rx="10" ry="7" fill="${K}"/><circle cx="32" cy="13" r="10" fill="${K}"/><path d="M25 6 L27 1 L31 5 Z" fill="${K}"/><path d="M39 6 L37 1 L33 5 Z" fill="${K}"/><g>${eye(28.4)}${eye(35.6)}</g><path d="M31 16 h2 l-1 1.2 z" fill="#F472B6"/></svg>`;
const SLEEP_SVG = `<svg width="36" height="20" viewBox="0 0 44 24" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M38 16 C 42 14, 42 20, 37.5 18.5" fill="none" stroke="${K}" stroke-width="3.6" stroke-linecap="round"/><ellipse cx="24" cy="16" rx="15" ry="7.5" fill="${K}"/><circle cx="11" cy="15" r="7.5" fill="${K}"/><path d="M6 9 L8 4 L12 8 Z" fill="${K}"/><path d="M7.5 14.8 q1.4 1.4 2.8 0" fill="none" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/><path d="M12.5 14.8 q1.3 1.2 2.6 0" fill="none" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/></svg>`;
const FX_HTML = {
  bulb: '<span class="cs-fxbulb cs-fx-bob"><svg width="14" height="16" viewBox="0 0 14 16"><circle cx="7" cy="7" r="5.5" fill="#FDE047"/><rect x="4.5" y="12" width="5" height="2.6" rx="1" fill="#9CA3AF"/><line x1="7" y1="0" x2="7" y2="1.6" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/><line x1="0.6" y1="3.2" x2="2" y2="4.2" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/><line x1="13.4" y1="3.2" x2="12" y2="4.2" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/></svg></span>',
  sparkle: '<span class="cs-fxstar cs-fx-tw"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 0 L8.4 5.6 L14 7 L8.4 8.4 L7 14 L5.6 8.4 L0 7 L5.6 5.6 Z" fill="#FCD34D"/></svg></span>',
  sweat: '<span class="cs-fxsweat cs-fx-bob"><svg width="10" height="14" viewBox="0 0 10 14"><path d="M5 0 C 5 4, 9 7, 9 10 A 4 4 0 0 1 1 10 C 1 7, 5 4, 5 0 Z" fill="#60A5FA"/></svg></span>',
};
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

export default function CatSkinFx({ micState, audioLevel = 0, isBusy = false, hasError = false }) {
  const rootRef = useRef(null);
  const recRef = useRef(false);
  const lvlRef = useRef(0);
  const busyRef = useRef(false);
  const errRef = useRef(false);
  useEffect(() => { recRef.current = micState === "recording"; }, [micState]);
  useEffect(() => { lvlRef.current = audioLevel || 0; }, [audioLevel]);
  useEffect(() => { busyRef.current = !!isBusy; }, [isBusy]);
  useEffect(() => { errRef.current = !!hasError; }, [hasError]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = "";
    const sleepWrap = document.createElement("div"); sleepWrap.className = "cs-sleeper"; sleepWrap.innerHTML = SLEEP_SVG; sleepWrap.style.display = "none";
    const runWrap = document.createElement("div"); runWrap.className = "cs-runner"; const flip = document.createElement("div"); flip.innerHTML = RUN_SVG; runWrap.appendChild(flip); runWrap.style.display = "none";
    const fx = document.createElement("div"); fx.className = "cs-fx"; fx.style.display = "none";
    // 睡眠 Zzz：三个升序 Z，贴在卧睡精灵头顶（仅 sleep 视图显示）
    const zzz = ZZZ_CLASSES.map((cls, i) => {
      const z = document.createElement("span");
      z.className = cls; z.textContent = "Z";
      z.style.animationDelay = ZZZ_DELAYS[i];
      z.style.display = "none";
      return z;
    });
    root.appendChild(sleepWrap); root.appendChild(runWrap); root.appendChild(fx);
    zzz.forEach((z) => root.appendChild(z));

    const W = root.clientWidth || 180;
    const C = W / 2;
    const AMP = Math.max(28, Math.min(56, W / 2 - 30));
    const ENTER_FROM = Math.max(14, C - AMP - 6);
    sleepWrap.style.left = (C - 18) + "px";
    // 卧睡精灵头部在左侧（约 sprite 左缘 + 9px）；Zzz 按当前朝向 lastDir 落到头部前侧上方
    const HEAD_X = C - 18 + 9;
    function positionZzz(dir) {
      zzz.forEach((z, i) => {
        z.style.left = (HEAD_X + dir * (ZZZ_BASE_LEFT + i * ZZZ_STEP)) + "px";
        z.style.top = "auto";
        z.style.bottom = (ZZZ_BOTTOM + i * 3) + "px";
        z.style.setProperty("--zdir", String(dir));
      });
    }

    let mode = "idle", x = C, wp = 0, t0 = performance.now(), xRet = C, lastVoice = 0, view = "";
    let prevBusy = false, prevErr = false, successUntil = 0, errorUntil = 0, loudState = false;
    let fxShownType = null, fxShownAt = 0, lastDir = 1, zzzPlaced = false;
    // 音符发射器状态
    let noteCount = 0, lastSpawn = 0;
    function clearNotes() {
      const kids = fx.querySelectorAll(".cs-fxnt");
      for (let i = 0; i < kids.length; i++) kids[i].remove();
      noteCount = 0;
    }
    function spawnNote(now) {
      if (noteCount >= NOTE_MAX) return;
      const el = document.createElement("span");
      el.className = "cs-fxnt";
      el.textContent = pick(NOTE_GLYPHS);
      el.style.color = pick(NOTE_COLORS);
      el.style.fontSize = rand(NOTE_SIZE_MIN, NOTE_SIZE_MAX).toFixed(1) + "px";
      // 随机起始 X：在锚点附近水平散布并按朝向偏向前侧，避免聚成一点
      el.style.left = (lastDir * NOTE_FRONT_BIAS + rand(-NOTE_SPREAD, NOTE_SPREAD)).toFixed(1) + "px";
      el.style.setProperty("--dx", rand(-NOTE_DX_MAX, NOTE_DX_MAX).toFixed(1) + "px");
      el.style.setProperty("--dy", rand(NOTE_DY_MIN, NOTE_DY_MAX).toFixed(1) + "px");
      el.style.setProperty("--rot", rand(-NOTE_ROT_MAX, NOTE_ROT_MAX).toFixed(0) + "deg");
      el.style.setProperty("--dur", rand(NOTE_DUR_MIN, NOTE_DUR_MAX).toFixed(2) + "s");
      el.style.animationDelay = rand(0, NOTE_DELAY_MAX).toFixed(2) + "s";
      el.addEventListener("animationend", () => { el.remove(); noteCount--; }, { once: true });
      fx.appendChild(el); noteCount++;
      lastSpawn = now;
    }
    function setView(v) {
      if (view === v) return; view = v;
      runWrap.style.display = v === "run" ? "block" : "none";
      sleepWrap.style.display = v === "sleep" ? "block" : "none";
      const zd = v === "sleep" ? "block" : "none";
      zzz.forEach((z) => { z.style.display = zd; });
    }
    function setFx(type) {
      if (fxShownType === type) return;
      fxShownType = type;
      clearNotes();
      if (!type) { fx.style.display = "none"; fx.innerHTML = ""; return; }
      if (type === "notes") { fx.innerHTML = ""; fx.style.display = "block"; return; }
      fx.innerHTML = FX_HTML[type] || "";
      fx.style.display = "block";
    }
    function positionFx(dir) { lastDir = dir; fx.style.transform = `translate(${x + dir * FRONT_SIDE_X}px, ${FRONT_UP_Y}px)`; }
    function renderRun(s, dir) { runWrap.style.transform = `translateX(${x - 16}px) scale(${s})`; flip.style.transform = `scaleX(${dir})`; }
    setView("none"); setFx(null);

    let raf, cancelled = false;
    function frame(now) {
      if (cancelled) return;
      const rec = recRef.current, busy = busyRef.current, lvl = lvlRef.current, err = errRef.current;
      if (busy === false && prevBusy === true) successUntil = now + 1200;
      prevBusy = busy;
      if (err === true && prevErr === false) errorUntil = now + 1500;
      prevErr = err;
      if (lvl > VOICE_THR) lastVoice = now;
      const voice = now - lastVoice < HOLD;
      const active = rec || busy;
      if (loudState) { if (lvl < LOUD_THR - HYST) loudState = false; }
      else if (lvl > LOUD_THR + HYST) loudState = true;

      // effect selection (priority order)
      let fxType = null;
      if (now < successUntil) fxType = "sparkle";
      else if (now < errorUntil) fxType = "sweat";
      else if (busy) fxType = "bulb";
      else if (rec && voice) fxType = "notes";

      // dwell gating: priority events + hide are immediate
      const priority = fxType === "sparkle" || fxType === "sweat" || fxType === null;
      if (priority || fxShownType === null || now - fxShownAt >= FX_DWELL) {
        if (fxType !== fxShownType) { setFx(fxType); fxShownAt = now; }
      }

      // 音符随机发射：单一计时由 rAF 时钟驱动，按音量调节速率
      if (fxShownType === "notes") {
        const interval = loudState ? NOTE_SPAWN_LOUD : NOTE_SPAWN_NORMAL;
        if (now - lastSpawn >= interval) spawnNote(now);
      }

      const want = (busy || (active && voice)) ? "walk" : "rest";

      if (mode === "idle") {
        setView("none"); setFx(null); x = C;
        if (active) { mode = "enter"; t0 = now; setView("run"); }
      } else if (mode === "enter") {
        const te = Math.min(1, (now - t0) / ENTER_MS), k = easeOut(te);
        x = ENTER_FROM + (C - ENTER_FROM) * k; renderRun(0.32 + 0.68 * k, 1); positionFx(1);
        if (te >= 1) { wp = 0; if (!active) { mode = "idle"; } else { mode = want === "rest" ? "settle" : "walk"; t0 = now; xRet = x; } }
      } else if (mode === "walk") {
        if (!active || want === "rest") { mode = "settle"; t0 = now; xRet = x; }
        else { wp += (busy || loudState) ? PROC_W : WALK_W; x = C + AMP * Math.sin(wp); const dir = Math.cos(wp) >= 0 ? 1 : -1; renderRun(1, dir); positionFx(dir); }
      } else if (mode === "settle") {
        if (active && want !== "rest") { mode = "walk"; wp = 0; setView("run"); }
        else {
          const tr = Math.min(1, (now - t0) / RETURN_MS), k = easeOut(tr);
          x = xRet + (C - xRet) * k; const dir = (C - x) >= 0 ? 1 : -1; renderRun(1, dir); positionFx(dir);
          if (tr >= 1) { if (active) { mode = "sleep"; setView("sleep"); x = C; } else { mode = "idle"; setView("none"); } }
        }
      } else if (mode === "sleep") {
        x = C; setView("sleep"); setFx(null);
        // 进入睡眠时按最后朝向定位一次 Zzz（每帧只跑一次，靠 zzzPlaced 守卫）
        if (!zzzPlaced) { positionZzz(lastDir); zzzPlaced = true; }
        if (!active) { mode = "idle"; zzzPlaced = false; }
        else if (want !== "rest") { mode = "walk"; setView("run"); wp = 0; zzzPlaced = false; }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelled = true; cancelAnimationFrame(raf); clearNotes(); root.innerHTML = ""; };
  }, []);

  return <div ref={rootRef} className="cat-skin" aria-hidden="true" />;
}
