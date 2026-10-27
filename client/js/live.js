/* Keeping a screen live. The server pushes each change of a game down one
 * long response the moment it happens (live); where a network holds such a
 * response back, the screen asks for the state about once a second (poll).
 * The server stamps what it sends with its own time, which tells each device
 * how far its clock is off, so a countdown reads the same on every phone and
 * on the projector.
 */

import { netStatus } from "./ui.js";

const FIRST_MS = 5000;     // a stream that opens but says nothing this long is being held back on the way
const QUIET_MS = 15_000;   // the server pings every 10 s: this long without a word means the line is dead

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
  if (!res.ok) throw await refusal(res);
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  const cached = /HIT|STALE/i.test(res.headers.get("x-vercel-cache") || "") || Number(res.headers.get("age")) > 0;
  if (!cached) clock.sample(data?.now, sentAt, receivedAt);
  return data;
}

/* The error for a response that is not ok, carrying the server's sentence,
 * its status and its code. */
async function refusal(res) {
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json().catch(() => null) : null;
  const err = new Error(data?.error || `Request failed (${res.status})`);
  err.status = res.status;
  err.code = data?.code;
  return err;
}

/* Follows the shared state at `path` (/api/games/PIN): opens `${path}/live`
 * and calls onState with every state the server sends down it, opening the
 * next stream as soon as one ends. A dropped connection shows the
 * reconnecting strip and is retried; a refusal such as a game that no longer
 * exists goes to onError. Where a stream opens but nothing comes through, the
 * screen polls `path` instead. */
export function live(path, onState, { onError } = {}) {
  let stopped = false;
  let stream = null;   // the open stream's AbortController
  let rest = null;     // ends a wait between attempts early
  let fallback = null;

  const deliver = state => {
    try {
      onState(state);
    } catch (err) {
      console.error(err);
    }
  };

  async function run() {
    let failures = 0;
    while (!stopped && !fallback) {
      const ctl = new AbortController();
      stream = ctl;
      const sentAt = Date.now();
      let opened = false;
      let heard = false;
      let timer = null;
      const expect = ms => {
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(), ms);
      };
      expect(QUIET_MS);
      try {
        const res = await fetch(`${path}/live`, { cache: "no-store", credentials: "same-origin", signal: ctl.signal });
        if (!res.ok) throw await refusal(res);
        opened = true;
        expect(FIRST_MS);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const message = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            expect(QUIET_MS);
            if (!message.startsWith("data: ")) continue;   // a ping
            const state = JSON.parse(message.slice(6));
            if (!heard) clock.sample(state.now, sentAt, Date.now());
            heard = true;
            failures = 0;
            netStatus(true);
            deliver(state);
          }
        }
      } catch (err) {
        if (stopped) return;
        if (err.status >= 400 && err.status < 500) {
          netStatus(true);
          return onError?.(err);
        }
      } finally {
        clearTimeout(timer);
      }
      if (heard || ctl.signal.reason === "wake") continue;   // it ended, or the screen came back: open the next
      if (opened) {
        fallback = poll(async () => deliver(await getState(path)), 1000, { onError });
        return;
      }
      // No stream: the state comes by a plain request meanwhile, then the
      // stream is tried again.
      failures += 1;
      try {
        deliver(await getState(path));
        netStatus(true);
      } catch (err) {
        if (stopped) return;
        if (err.status >= 400 && err.status < 500) return onError?.(err);
        netStatus(false);
      }
      await new Promise(resolve => {
        rest = resolve;
        setTimeout(resolve, Math.min(2000, 500 * failures));
      });
    }
  }

  // Back from a locked screen or a lost network, the old stream may be dead:
  // open a fresh one, which starts with the state as it is now.
  const wake = () => {
    if (document.visibilityState !== "visible" || stopped || fallback) return;
    rest?.();
    stream?.abort("wake");
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  run();

  return {
    stop() {
      stopped = true;
      stream?.abort();
      rest?.();
      fallback?.stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    }
  };
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
