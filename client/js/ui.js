/* Small helpers every page uses: escaping, toasts, the JSON API, the admin
 * sign-in gate and keeping a phone's screen awake.
 */

import { footer, icon, siteHeader, trophyArt } from "./design.js";

export const $ = id => document.getElementById(id);

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function plural(n, word) {
  return `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
}

let toastTimer = null;
export function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

export function announce(message) {
  let region = $("announcer");
  if (!region) {
    region = document.createElement("div");
    region.id = "announcer";
    region.className = "sr-only";
    region.setAttribute("role", "status");
    document.body.append(region);
  }
  region.textContent = "";
  requestAnimationFrame(() => { region.textContent = message; });
}

/* The JSON API. Throws an Error carrying the server's sentence as its
 * message, plus .status and .code so callers can react to specific refusals. */
export async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, {
      method, headers, cache: "no-store", credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    const err = new Error("No connection. Check the network and try again.");
    err.status = 0;
    err.code = "offline";
    throw err;
  }
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

/* Resolves once the browser holds an admin session, showing a sign-in
 * form in `root` first if it does not. */
export async function adminGate(root, what = "this page") {
  try {
    if ((await api("/api/auth/me")).admin) return;
  } catch {
    // fall through to the form; signing in will report what is wrong
  }
  return new Promise(resolve => {
    root.innerHTML = `
      ${siteHeader(what.includes("host") ? "host" : "admin")}
      <div class="auth-layout">
        <div class="auth-copy"><span class="intro-tag">${icon("spark")} Good games start here</span>
          <h1>Bring your people.<br>We'll bring the fun.</h1>
          <p class="sub">Create something worth playing. Set the stage for a little friendly competition.</p>${trophyArt()}</div>
        <form class="card auth-card" id="signin">
          <span class="panel-icon">${icon("lock")}</span>
          <h2>${what.includes("host") ? "Your host pass" : "Welcome to quiz studio"}</h2>
          <p class="sub">Enter your admin password to open ${escapeHtml(what)}.</p>
          <div class="field">
            <label for="password">Admin password</label>
            <div class="password-wrap"><input id="password" type="password" autocomplete="current-password" required autofocus>
            <button type="button" id="show-password" aria-pressed="false">Show</button></div>
          </div>
          <button type="submit" class="big">Let's get started ${icon("arrow")}</button>
          <p class="err" id="signin-err" role="alert"></p>
          <a class="back-link" href="/">Here to play? Join a game instead</a>
        </form>
      </div>${footer()}`;
    $("show-password").onclick = e => {
      const visible = $("password").type === "password";
      $("password").type = visible ? "text" : "password";
      e.currentTarget.textContent = visible ? "Hide" : "Show";
      e.currentTarget.setAttribute("aria-pressed", String(visible));
    };
    $("signin").onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api("/api/auth/login", { method: "POST", body: { password: $("password").value } });
        resolve();
      } catch (err) {
        $("signin-err").textContent = err.message;
        btn.disabled = false;
      }
    };
  });
}

/* Native dialog gives keyboard focus trapping, Escape, and focus restoration.
 * Ids come from a counter: crypto.randomUUID() is missing on plain-http LAN
 * addresses, which is how phones reach a laptop running the game locally. */
let dialogs = 0;
export function askDialog({ title, message = "", value, confirmLabel = "Continue", danger = false }) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    const id = `dialog-${++dialogs}`;
    dialog.setAttribute("aria-labelledby", id);
    if (message) dialog.setAttribute("aria-describedby", `${id}-message`);
    dialog.innerHTML = `<form method="dialog"><span class="panel-icon">${icon(danger ? "flag" : "spark")}</span>
      <h2 id="${id}">${escapeHtml(title)}</h2><p id="${id}-message">${escapeHtml(message)}</p>
      ${value !== undefined ? `<label for="dialog-value">Quiz title</label><input id="dialog-value" value="${escapeHtml(value)}" maxlength="80" required autocomplete="off">` : ""}
      <div class="dialog-actions"><button type="button" class="quiet" data-dialog-cancel>Cancel</button><button type="submit" class="${danger ? "danger" : ""}" value="confirm">${escapeHtml(confirmLabel)}</button></div></form>`;
    dialog.querySelector("[data-dialog-cancel]").onclick = () => dialog.close("cancel");
    dialog.addEventListener("close", () => {
      const result = dialog.returnValue === "confirm" ? (value !== undefined ? dialog.querySelector("input").value : true) : null;
      dialog.remove();
      resolve(result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    if (value !== undefined) dialog.querySelector("input").select();
    else dialog.querySelector("[data-dialog-cancel]").focus();
  });
}

document.addEventListener("click", e => {
  const toggle = e.target.closest("[data-nav-toggle]");
  if (toggle) {
    const header = toggle.closest(".site-header");
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    header.classList.toggle("nav-open", expanded);
    return;
  }
  if (!e.target.closest("[data-help]")) return;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "help-title");
  dialog.innerHTML = `<span class="panel-icon">${icon("play")}</span><h2 id="help-title">Your next great game</h2>
    <p>One room. One quiz. Everyone in on the fun.</p><ol class="help-steps">
    <li><span class="how-number">01</span><div><b>Find your game</b><p>Scan the host's QR code or enter the six-digit PIN. Pick a nickname and an avatar.</p></div></li>
    <li><span class="how-number">02</span><div><b>Make your move</b><p>Read each question, then tap your answer. You get one choice, so make it count. On a keyboard, use A–F or 1–6.</p></div></li>
    <li><span class="how-number">03</span><div><b>Keep the streak alive</b><p>Correct answers earn points. When enabled by the host, speed and consecutive correct answers earn bonuses. Follow your progress on the leaderboard.</p></div></li></ol>
    <form method="dialog"><button class="big">Got it. Let's play ${icon("arrow")}</button></form>`;
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
});

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
}

export async function copyText(value, message = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    toast("Copy isn't available here. Use the game PIN to join.");
  }
}

/* Keeps the screen on while a game is playing, where the browser allows it. */
let wakeLock = null;
export async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  const grab = async () => {
    try {
      if (document.visibilityState === "visible" && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch {
      // the browser said no; the game still works
    }
  };
  if (!keepAwake.wired) {
    keepAwake.wired = true;
    document.addEventListener("visibilitychange", grab);
  }
  await grab();
}

/* Lowers a presenter screen's --k (see styles.css) until its content fits the
 * window without scrolling: a projector cannot scroll, and a long question on
 * a 720p screen would otherwise push its answers off the bottom. Narrow
 * windows — someone's phone — are left to scroll as usual.
 *
 * A full screen first sheds its decoration (.tight), then a crowded lobby
 * shrinks its names (--ck) before the QR code shrinks with everything else:
 * sixty names must not leave the latecomers a QR code too small to scan. */
export function fitToScreen() {
  const stage = document.querySelector(".stage");
  if (!stage) return;
  stage.classList.remove("tight");
  stage.style.setProperty("--k", 1);
  stage.style.setProperty("--ck", 1);
  if (innerWidth < 700) return;
  // Measure layout, excluding entrance transforms and decorative overflow.
  // The lobby's grid stretches to the window, so it counts as tall as the
  // columns inside it, side by side or stacked.
  const contentHeight = () => {
    const style = getComputedStyle(stage);
    const blocks = [...stage.children].filter(el => getComputedStyle(el).display !== "none");
    const heights = blocks.map(el => {
      if (!el.classList.contains("lobby")) return el.offsetHeight;
      const top = el.getBoundingClientRect().top;
      return Math.max(0, ...[...el.children].map(child => child.getBoundingClientRect().bottom - top));
    });
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
      (parseFloat(style.rowGap) || 0) * Math.max(0, blocks.length - 1) +
      heights.reduce((sum, height) => sum + height, 0);
  };
  const fits = () => contentHeight() <= innerHeight + 1;
  const shrink = (name, floor) => {
    let v = Number(stage.style.getPropertyValue(name));
    while (v > floor && !fits()) {
      v = Math.round((v - 0.05) * 100) / 100;
      stage.style.setProperty(name, v);
    }
  };
  shrink("--k", 0.85);
  if (fits()) return;
  stage.classList.add("tight");
  stage.style.setProperty("--k", 1);
  shrink("--k", 0.85);
  if (stage.querySelector(".chips > *")) shrink("--ck", 0.6);
  shrink("--k", 0.5);
}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const header = document.querySelector(".site-header.nav-open");
  if (!header) return;
  header.classList.remove("nav-open");
  const toggle = header.querySelector("[data-nav-toggle]");
  toggle.setAttribute("aria-expanded", "false");
  toggle.focus();
});

/* Fits again whenever the window changes size or the web fonts arrive. */
export function keepFitting() {
  let timer = null;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(fitToScreen, 120);
  });
  document.fonts?.ready.then(fitToScreen);
  // a name in, say, Azerbaijani letters loads the extended font later on
  document.fonts?.addEventListener?.("loadingdone", () => fitToScreen());
}

/* The red "reconnecting" strip, shown while requests are failing. */
export function netStatus(ok) {
  let bar = $("net");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "net";
    bar.className = "netbar hidden";
    bar.setAttribute("role", "status");
    bar.textContent = "Connection lost — reconnecting…";
    document.body.prepend(bar);
  }
  bar.classList.toggle("hidden", ok);
}
