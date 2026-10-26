/* Keeping a screen live without a socket. Vercel cannot hold a connection
 * open, so every screen asks for the game's state about once a second. The
 * server stamps its responses with its own time, which tells each device
 * how far its clock is off, so a countdown reads the same on every phone
 * and on the projector.
 */

import { netStatus } from "./ui.js";

/* The server's time as this device best knows it. */
export const clock = {
  offset: 0,
  bestRtt: Infinity,
  samples: 0,
  now() {
    return Date.now() + this.offset;
  },
  /* Short round trips bound the error best, so they win; the bar creeps up
   * slowly so a network that got slower still gets measured. */
  sample(serverNow, sentAt, receivedAt) {
    if (typeof serverNow !== "number") return;
    const rtt = receivedAt - sentAt;
    this.samples += 1;
    if (this.samples > 1 && rtt > this.bestRtt * 1.5 + 20) {
      this.bestRtt += 5;
      return;
    }
    this.bestRtt = Math.min(this.bestRtt, rtt);
    this.offset = serverNow + rtt / 2 - receivedAt;
  }
};

/* GET a JSON state and feed the clock, unless a cache answered: a cached
 * response carries an old timestamp. */
export async function getState(path, { token } = {}) {
  const sentAt = Date.now();
  let res;
  try {
    res = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
  } catch {
    const err = new Error("offline");
    err.status = 0;
    throw err;
  }
  const receivedAt = Date.now();
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  const cached = /HIT|STALE/i.test(res.headers.get("x-vercel-cache") || "") || Number(res.headers.get("age")) > 0;
  if (!cached) clock.sample(data?.now, sentAt, receivedAt);
  return data;
}

/* Calls fn every intervalMs, never overlapping, and at once when the page
 * comes back into view or the network returns. A dropped connection or a
 * server hiccup shows the reconnecting strip and is simply retried; any
 * other refusal (the game is gone, the player was removed) goes to onError. */
export function poll(fn, intervalMs, { onError } = {}) {
  let timer = null;
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    try {
      await fn();
      netStatus(true);
    } catch (err) {
      // Only a failed fetch (status 0) or a 5xx is the network's fault.
      const transient = err.status === 0 || err.status >= 500;
      netStatus(!transient);
      if (err.status === undefined) console.error(err);
      else if (!transient) onError?.(err);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, document.visibilityState === "hidden" ? intervalMs * 3 : intervalMs);
    }
  }

  const wake = () => {
    if (document.visibilityState === "visible") tick();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  tick();

  return {
    now: tick,
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    }
  };
}
