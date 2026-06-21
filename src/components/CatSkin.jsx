import { useEffect, useRef } from "react";

const K = "#1b1b1f";
const VOICE_THR = 0.06;
const SILENCE_HOLD = 1100;
const ENTER_MS = 1400;
const STAND_MS = 320;
const RETURN_MS = 900;
const WALK_W = 0.022;
const PROC_W = 0.04;

function eye(cx) {
  return `<ellipse cx="${cx}" cy="13" rx="2.6" ry="3.1" fill="#FDE047"/><ellipse cx="${cx + 0.3}" cy="13.5" rx="1" ry="1.9" fill="${K}"/><circle cx="${cx - 0.8}" cy="11.6" r=".7" fill="#fff"/>`;
}
const RUN_SVG = `<svg width="32" height="23" viewBox="0 0 46 32" xmlns="http://www.w3.org/2000/svg" style="display:block"><path class="cs-tail" d="M9 22 C 3 20, 3 11, 7 8" fill="none" stroke="${K}" stroke-width="3.6" stroke-linecap="round"/><rect class="cs-leg cs-lb" x="12" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-la" x="17" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-lb" x="23" y="24" width="3" height="5" rx="1.5" fill="${K}"/><rect class="cs-leg cs-la" x="28" y="24" width="3" height="5" rx="1.5" fill="${K}"/><ellipse cx="20" cy="21" rx="10" ry="7" fill="${K}"/><circle cx="32" cy="13" r="10" fill="${K}"/><path d="M25 6 L27 1 L31 5 Z" fill="${K}"/><path d="M39 6 L37 1 L33 5 Z" fill="${K}"/><g>${eye(28.4)}${eye(35.6)}</g><path d="M31 16 h2 l-1 1.2 z" fill="#F472B6"/></svg>`;
const SLEEP_SVG = `<svg width="36" height="20" viewBox="0 0 44 24" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M38 16 C 42 14, 42 20, 37.5 18.5" fill="none" stroke="${K}" stroke-width="3.6" stroke-linecap="round"/><ellipse cx="24" cy="16" rx="15" ry="7.5" fill="${K}"/><circle cx="11" cy="15" r="7.5" fill="${K}"/><path d="M6 9 L8 4 L12 8 Z" fill="${K}"/><path d="M7.5 14.8 q1.4 1.4 2.8 0" fill="none" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/><path d="M12.5 14.8 q1.3 1.2 2.6 0" fill="none" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/></svg>`;
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

export default function CatSkin({ micState, audioLevel = 0, isBusy = false }) {
  const rootRef = useRef(null);
  const recRef = useRef(false);
  const lvlRef = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => { recRef.current = micState === "recording"; }, [micState]);
  useEffect(() => { lvlRef.current = audioLevel || 0; }, [audioLevel]);
  useEffect(() => { busyRef.current = !!isBusy; }, [isBusy]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // 清空 root，杜绝 StrictMode(dev) 两次执行 effect 残留的第二只猫
    root.innerHTML = "";
    const runner = document.createElement("div"); runner.className = "cs-runner";
    const flip = document.createElement("div"); runner.appendChild(flip);
    const notes = document.createElement("div"); notes.className = "cs-notes";
    notes.innerHTML = '<span class="cs-note" style="color:#7DB4FF">♪</span><span class="cs-note" style="left:6px;color:#F7A8CB;animation-delay:.6s">♫</span>';
    notes.style.display = "none";
    const z1 = document.createElement("span"); z1.className = "cs-zz"; z1.textContent = "z";
    const z2 = document.createElement("span"); z2.className = "cs-zz"; z2.textContent = "z"; z2.style.animationDelay = ".9s";
    root.appendChild(notes); root.appendChild(runner); root.appendChild(z1); root.appendChild(z2);

    const W = root.clientWidth || 180;
    const C = W / 2;
    const AMP = Math.max(28, Math.min(56, W / 2 - 30));
    const ENTER_FROM = Math.max(14, C - AMP - 6);
    z1.style.left = (C + 8) + "px"; z1.style.top = "2px";
    z2.style.left = (C + 14) + "px"; z2.style.top = "0px";

    let pose = "";
    function setPose(p) { if (pose === p) return; pose = p; flip.innerHTML = p === "run" ? RUN_SVG : SLEEP_SVG; }
    function showZ(on) { z1.style.display = on ? "block" : "none"; z2.style.display = on ? "block" : "none"; }
    function showN(on) { notes.style.display = on ? "block" : "none"; }
    setPose("sleep"); showZ(true);

    let x = C, wp = 0, phase = "sleep", t0 = performance.now(), xRet = C, lastVoice = 0, hasEntered = false;
    function render(s, dir) { runner.style.transform = `translateX(${x - 16}px) scale(${s})`; flip.style.transform = `scaleX(${dir})`; }
    function dirTo(target) { return target - x >= 0 ? 1 : -1; }

    let raf, cancelled = false;
    function frame(now) {
      if (cancelled) return;
      const rec = recRef.current, busy = busyRef.current, lvl = lvlRef.current;
      if (lvl > VOICE_THR) lastVoice = now;
      const voice = now - lastVoice < SILENCE_HOLD;
      const active = rec || busy;
      if (!active) {
        if (phase !== "sleep" && phase !== "return") { phase = "return"; t0 = now; xRet = x; setPose("run"); showN(false); }
        if (phase === "return") {
          const tr = Math.min(1, (now - t0) / RETURN_MS), k = easeOut(tr);
          x = xRet + (C - xRet) * k; render(1, dirTo(C));
          if (tr >= 1) { phase = "sleep"; setPose("sleep"); showZ(true); hasEntered = false; }
        } else { x = C; setPose("sleep"); showZ(true); render(1, 1); }
      } else {
        showZ(false);
        if (phase === "sleep") { phase = hasEntered ? "stand" : "enter"; t0 = now; setPose("run"); }
        if (phase === "enter") {
          const te = Math.min(1, (now - t0) / ENTER_MS), k = easeOut(te);
          x = ENTER_FROM + (C - ENTER_FROM) * k; render(0.32 + 0.68 * k, 1);
          if (te >= 1) { hasEntered = true; wp = 0; phase = busy ? "process" : "walk"; }
        } else if (phase === "stand") {
          render(1, 1);
          if (now - t0 > STAND_MS) { wp = 0; phase = busy ? "process" : "walk"; }
        } else if (phase === "walk" || phase === "process") {
          if (busy) { phase = "process"; showN(true); }
          else { showN(false); if (!voice) { phase = "lie"; t0 = now; xRet = x; } }
          const w = phase === "process" ? PROC_W : WALK_W;
          wp += w; x = C + AMP * Math.sin(wp); render(1, Math.cos(wp) >= 0 ? 1 : -1);
          if (phase === "process") notes.style.transform = `translateX(${x - 22}px)`;
        } else if (phase === "lie") {
          if (busy || voice) { phase = "stand"; t0 = now; setPose("run"); }
          else {
            const tr = Math.min(1, (now - t0) / RETURN_MS), k = easeOut(tr);
            x = xRet + (C - xRet) * k; render(1, dirTo(C));
            if (tr >= 1) { phase = "sleep"; setPose("sleep"); }
          }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelled = true; cancelAnimationFrame(raf); root.innerHTML = ""; };
  }, []);

  return <div ref={rootRef} className="cat-skin" aria-hidden="true" />;
}
