import { useEffect, useRef } from "react";

const K = "#1b1b1f";
const VOICE_THR = 0.07;
const HOLD = 1200;
const ENTER_MS = 1400;
const RETURN_MS = 800;
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
    root.innerHTML = "";
    const sleepWrap = document.createElement("div"); sleepWrap.className = "cs-sleeper"; sleepWrap.innerHTML = SLEEP_SVG;
    const runWrap = document.createElement("div"); runWrap.className = "cs-runner";
    const flip = document.createElement("div"); flip.innerHTML = RUN_SVG; runWrap.appendChild(flip); runWrap.style.display = "none";
    const notes = document.createElement("div"); notes.className = "cs-notes"; notes.innerHTML = '<span class="cs-note" style="color:#7DB4FF">♪</span><span class="cs-note" style="left:6px;color:#F7A8CB;animation-delay:.6s">♫</span>'; notes.style.display = "none";
    const z1 = document.createElement("span"); z1.className = "cs-zz"; z1.textContent = "z";
    const z2 = document.createElement("span"); z2.className = "cs-zz"; z2.textContent = "z"; z2.style.animationDelay = ".9s";
    root.appendChild(sleepWrap); root.appendChild(runWrap); root.appendChild(notes); root.appendChild(z1); root.appendChild(z2);

    const W = root.clientWidth || 180;
    const C = W / 2;
    const AMP = Math.max(28, Math.min(56, W / 2 - 30));
    const ENTER_FROM = Math.max(14, C - AMP - 6);
    sleepWrap.style.left = (C - 18) + "px";
    z1.style.left = (C + 8) + "px"; z1.style.top = "2px";
    z2.style.left = (C + 14) + "px"; z2.style.top = "0px";

    let mode = "sleep", x = C, wp = 0, t0 = performance.now(), xRet = C, lastVoice = 0, hasEntered = false, showingRun = null;
    function showRun(on) { if (showingRun === on) return; showingRun = on; runWrap.style.display = on ? "block" : "none"; sleepWrap.style.display = on ? "none" : "block"; }
    function showZ(on) { z1.style.display = on ? "block" : "none"; z2.style.display = on ? "block" : "none"; }
    function showN(on) { notes.style.display = on ? "block" : "none"; }
    function renderRun(s, dir) { runWrap.style.transform = `translateX(${x - 16}px) scale(${s})`; flip.style.transform = `scaleX(${dir})`; }
    showRun(false); showZ(true);

    let raf, cancelled = false;
    function frame(now) {
      if (cancelled) return;
      const rec = recRef.current, busy = busyRef.current, lvl = lvlRef.current;
      if (lvl > VOICE_THR) lastVoice = now;
      const voice = now - lastVoice < HOLD;
      const active = rec || busy;
      const want = busy ? "process" : (active && voice ? "walk" : "sleep");

      if (mode === "sleep") {
        x = C; showZ(true); showN(false);
        if (!active) hasEntered = false;
        if (want !== "sleep") { mode = hasEntered ? want : "enter"; wp = 0; t0 = now; showRun(true); showZ(false); }
      } else if (mode === "enter") {
        const te = Math.min(1, (now - t0) / ENTER_MS), k = easeOut(te);
        x = ENTER_FROM + (C - ENTER_FROM) * k; renderRun(0.32 + 0.68 * k, 1);
        if (te >= 1) { hasEntered = true; wp = 0; mode = (want === "sleep") ? "settle" : want; t0 = now; xRet = x; }
      } else if (mode === "walk" || mode === "process") {
        if (want === "sleep") { mode = "settle"; t0 = now; xRet = x; showN(false); }
        else {
          mode = want; showN(mode === "process");
          wp += mode === "process" ? PROC_W : WALK_W;
          x = C + AMP * Math.sin(wp); renderRun(1, Math.cos(wp) >= 0 ? 1 : -1);
          if (mode === "process") notes.style.transform = `translateX(${x - 22}px)`;
        }
      } else if (mode === "settle") {
        if (want !== "sleep") { mode = want; wp = 0; }
        else {
          const tr = Math.min(1, (now - t0) / RETURN_MS), k = easeOut(tr);
          x = xRet + (C - xRet) * k; renderRun(1, (C - x) >= 0 ? 1 : -1);
          if (tr >= 1) { mode = "sleep"; showRun(false); showZ(true); x = C; }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelled = true; cancelAnimationFrame(raf); root.innerHTML = ""; };
  }, []);

  return <div ref={rootRef} className="cat-skin" aria-hidden="true" />;
}
