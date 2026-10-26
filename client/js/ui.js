/* Small helpers every page uses: escaping, toasts, the JSON API, the admin
 * sign-in gate and keeping a phone's screen awake.
 */

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
      <div class="wrap narrow">
        <p class="eyebrow">Quizly</p>
        <h1>Sign in</h1>
        <p class="sub">The admin password opens ${escapeHtml(what)}.</p>
        <form class="card" id="signin">
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" autocomplete="current-password" required autofocus>
          </div>
          <button type="submit" class="big">Sign in</button>
          <p class="err" id="signin-err" role="alert"></p>
        </form>
      </div>`;
    $("signin").onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
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

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
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
