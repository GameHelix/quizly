/* The celebrations: confetti, a handful of synthesized sounds, a buzz on
 * phones that can, and numbers that count up. All of it is decoration —
 * it respects reduced-motion settings and fails silently.
 */

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function confetti(ms = 3000, amount = 180) {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = innerWidth * dpr);
  const h = (canvas.height = innerHeight * dpr);
  const colors = ["#cc4b41", "#3a78bd", "#d99a2b", "#3f8a58", "#8160bf", "#23867a", "#17191e"];
  const pieces = Array.from({ length: amount }, () => ({
    x: Math.random() * w,
    y: -Math.random() * h * 0.6,
    size: (5 + Math.random() * 7) * dpr,
    vx: (Math.random() - 0.5) * 4 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)]
  }));
  const end = performance.now() + ms;
  const frame = t => {
    ctx.clearRect(0, 0, w, h);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04 * dpr;
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < end) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/* ---------- sound: oscillators, so there is nothing to download ---------- */

let audio = null;
const SOUND_KEY = "quizly:sound";

export const sound = {
  get on() {
    try {
      return localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
      return true;
    }
  },
  toggle() {
    const next = !this.on;
    try {
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      // remembered for this page only
    }
    if (next) this.unlock();
    return next;
  },
  /* Browsers only allow audio after a click; call this from one. */
  unlock() {
    try {
      audio ??= new AudioContext();
      if (audio.state === "suspended") audio.resume();
    } catch {
      audio = null;
    }
  },
  tick() { play([[880, 0, 0.06]], "square", 0.05); },
  go() { play([[523, 0, 0.12], [784, 0.1, 0.18]], "triangle"); },
  join() { play([[660, 0, 0.08], [990, 0.06, 0.1]], "sine", 0.08); },
  timeUp() { play([[330, 0, 0.25], [247, 0.18, 0.35]], "sawtooth", 0.06); },
  reveal() { play([[523, 0, 0.15], [659, 0.12, 0.15], [784, 0.24, 0.3]], "triangle"); },
  fanfare() {
    play([[523, 0, 0.18], [659, 0.18, 0.18], [784, 0.36, 0.18], [1047, 0.54, 0.6], [784, 0.54, 0.6]], "triangle", 0.14);
  }
};

function play(notes, type = "sine", gain = 0.12) {
  if (!sound.on || !audio || audio.state !== "running") return;
  const t0 = audio.currentTime;
  for (const [freq, at, dur] of notes) {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(gain, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(g).connect(audio.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}

/* ---------- touch and numbers ---------- */

export function buzz(pattern) {
  try {
    if (reducedMotion() || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
    navigator.vibrate?.(pattern);
  } catch {
    // not a phone, or not allowed
  }
}

/* Gives el a quick swell — a number that just went up. */
export function bump(el) {
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth;   // restart the animation
  el.classList.add("bump");
}

/* Counts el's number from `from` up to `to`. */
export function countUp(el, from, to, ms = 900) {
  if (!el) return;
  const show = n => { el.textContent = Math.round(n).toLocaleString("en-US"); };
  if (reducedMotion() || from === to) return show(to);
  const start = performance.now();
  const step = t => {
    const k = Math.min(1, (t - start) / ms);
    show(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
