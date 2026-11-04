/* One load-generating process of `npm run stress-test` (scripts/stress-test.js).
 *
 * It plays its share of the games: a host per game and that game's phones.
 * Every screen follows its game the way client/js/live.js does — one long
 * stream at a time, the next opened as soon as one ends, and polling once a
 * second for good when a stream opens but says nothing for five seconds.
 * Every phone fetches its own view on each new screen, as client/js/player.js
 * does, and answers at a human moment. What a person in the room would notice
 * is measured here and sent to the parent process, which merges the numbers
 * of every process.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { Hist } from "./hist.js";

const FIRST_MS = 5000;      // client/js/live.js: an open stream silent this long is being held back
const QUIET_MS = 15_000;    // client/js/live.js: this long without a word means the line is dead
const GRACE_MS = 1500;      // server/play.js: a question closes this long after its clock runs out
const SHARED_IP = "203.0.113.7";

let cfg = null;
let cookie = "";
const hists = {};
const counters = {};
const screens = new Set();   // every host and phone screen following a game right now

const hist = name => (hists[name] ??= new Hist());
const count = (key, n = 1) => {
  counters[key] = (counters[key] ?? 0) + n;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const jitter = (ms, spread = 0.3) => ms * (1 - spread + Math.random() * spread * 2);
const pick = list => list[Math.floor(Math.random() * list.length)];
const keyOf = s => `${s.status}:${s.phase}:${s.index}`;
const hostIp = () => `198.51.100.${cfg.worker + 1}`;

/* ---------- requests ---------- */

/* Where a screen's next request goes: spread over the instances at random,
 * as a load balancer spreads requests, or through the slow line for a phone on one. */
function base(s) {
  return s?.base ?? pick(s?.mobile ? cfg.mobileBases : cfg.bases);
}

async function call(label, method, url, { body, token, ip, timeoutMs = 30_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie && label.startsWith("host")) headers.cookie = cookie;
  if (ip) headers["x-forwarded-for"] = ip;
  const t0 = performance.now();
  let res;
  let data = null;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
  } catch (err) {
    count(`${label}: no response (${reason(err)})`);
    return { status: 0, data: null };
  }
  hist(label).add(performance.now() - t0);
  if (!res.ok) count(`${label}: ${res.status}${data?.code ? " " + data.code : ""}`);
  return { status: res.status, data };
}

function reason(err) {
  return err?.cause?.code || err?.code || err?.name || "error";
}

/* ---------- following a game: client/js/live.js ---------- */

/* The server's time as a screen best knows it. On this machine the clocks
 * are the same one, so there is nothing to learn. */
function makeClock() {
  return {
    offset: 0,
    bestRtt: Infinity,
    samples: 0,
    now() {
      return Date.now() + this.offset;
    },
    sample(serverNow, sentAt, receivedAt) {
      if (cfg.sameClock || typeof serverNow !== "number") return;
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
}

function screen(game, { ip, mobile = false, slow = false, phone = false, onState }) {
  return {
    game, ip, mobile, slow, phone, onState,
    query: phone ? "?phone=1" : "",   // client/js/player.js asks for the state without the names
    base: cfg.route === "sticky" ? pick(mobile ? cfg.mobileBases : cfg.bases) : undefined,
    clock: makeClock(),
    stream: null,
    polling: false,
    done: false,
    awayUntil: 0,
    stormAt: 0
  };
}

/* live() for one screen: calls deliver() with every state, `fresh` for the
 * first one after a stream opened — a screen arriving, not a live change. */
async function follow(s) {
  screens.add(s);
  let failures = 0;
  while (!s.done && !s.polling) {
    if (s.awayUntil) await away(s);
    if (s.done) break;
    const ctl = new AbortController();
    s.stream = ctl;
    const sentAt = Date.now();
    let opened = false;
    let heard = false;
    let timer = null;
    const expect = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort("quiet"), ms);
    };
    expect(QUIET_MS);
    count("streams opened");
    try {
      const res = await fetch(`${base(s)}/api/games/${s.game.pin}/live${s.query}`, {
        headers: s.ip ? { "x-forwarded-for": s.ip } : {},
        signal: ctl.signal
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        count(`live: ${res.status}`);
        if (res.status >= 400 && res.status < 500) s.done = true;   // the game is gone
      }
      const reader = res.ok ? res.body.getReader() : null;
      if (reader) {
        opened = true;
        expect(FIRST_MS);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        if (s.slow && heard) await pause(jitter(2000, 0.5));   // a poor line: everything after the first word arrives late
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          expect(QUIET_MS);
          if (!message.startsWith("data: ")) continue;   // a ping
          const state = JSON.parse(message.slice(6));
          const at = Date.now();
          if (heard && !s.slow) hist("push delay").add(at + s.clock.offset - state.now);
          else {
            hist("stream open → first state").add(at - sentAt);
            s.clock.sample(state.now, sentAt, at);
          }
          const fresh = !heard;
          heard = true;
          failures = 0;
          deliver(s, state, fresh, at);
        }
      }
    } catch (err) {
      if (!ctl.signal.aborted && !s.done) count(`live: dropped (${reason(err)})`);
    } finally {
      clearTimeout(timer);
    }
    if (s.done) break;
    const why = ctl.signal.reason;
    if (heard || why === "wake" || why === "away") continue;
    if (opened) {
      s.polling = true;
      count("screens that fell back to polling");
      return poll(s);
    }
    // No stream: the state comes by a plain request meanwhile, then the stream is tried again.
    failures += 1;
    const state = await getState(s);
    if (state) deliver(s, state, true, Date.now());
    await pause(Math.min(2000, 500 * failures) * (0.5 + Math.random()));
  }
  screens.delete(s);
}

/* poll(): the shared state once a second, for the rest of the game. */
async function poll(s) {
  while (!s.done) {
    if (s.awayUntil) await away(s);
    const state = await getState(s);
    if (state) deliver(s, state, false, Date.now());
    if (!s.done) await pause(1000);
  }
  screens.delete(s);
}

async function getState(s) {
  const r = await call("poll", "GET", `${base(s)}/api/games/${s.game.pin}${s.query}`, { ip: s.ip });
  if (r.status === 200) return r.data;
  if (r.status === 404) s.done = true;
  return null;
}

/* A locked screen: nothing happens until it is back. Half the people come
 * back with a reload, which fetches everything again. */
async function away(s) {
  await pause(s.awayUntil - Date.now());
  s.awayUntil = 0;
  if (s.reload) s.key = "";
  if (s.stormAt) s.stormAt = Date.now();   // a storm while the screen was locked: its person sees it only from now
}

function deliver(s, state, fresh, at) {
  if (s.stormAt && (fresh || s.polling)) {
    hist("back after the storm").add(at - s.stormAt);
    s.stormAt = 0;
  }
  s.onState(state, { fresh, at });
}

/* ---------- a phone: client/js/player.js ---------- */

function makePhone(g, i) {
  const p = screen(g, {
    ip: cfg.ips === "shared" ? SHARED_IP : `10.${g.slot % 256}.${Math.floor(i / 256)}.${i % 256}`,
    mobile: Math.random() < cfg.mobile,
    slow: Math.random() < cfg.slow,
    phone: true,
    onState: (state, info) => phoneState(p, state, info)
  });
  return Object.assign(p, {
    nickname: `Bot ${String(i + 1).padStart(3, "0")}`,
    flaky: Math.random() < cfg.away,
    key: "",
    playerId: null,
    token: null,
    answering: new Set(),   // question indexes this phone has an answer planned for
    sent: new Map(),        // question index → the elapsed time the phone reported
    earned: new Map(),      // question index → the points its reveal reported
    answered: 0,
    final: null
  });
}

async function phone(p, joinBy) {
  await pause(Math.random() * (joinBy - Date.now()));   // people scan the QR code over a while
  if (await join(p)) await follow(p);
  p.done = true;
}

async function join(p) {
  count("joins tried");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await call("join", "POST", `${base(p)}/api/games/${p.game.pin}/players`, { body: { nickname: p.nickname }, ip: p.ip });
    if (r.status === 201) {
      p.playerId = r.data.playerId;
      p.token = r.data.token;
      count("joins ok");
      return true;
    }
    if (r.status && r.status < 500) return false;   // a rule said no, and the phone says why
    await pause(1000 * (attempt + 1));               // no answer: the person taps again
  }
  return false;
}

function phoneState(p, state, { fresh, at }) {
  const g = p.game;
  if (state.phase === "question" && state.question) g.deadlines.set(state.index, state.question.deadline);
  const key = keyOf(state);
  if (key !== p.key) {
    p.key = key;
    if (!fresh) (g.seen.get(key) ?? g.seen.set(key, []).get(key)).push([at, p.slow ? "slow line" : p.mobile ? "4G" : ""]);
    loadMe(p, key);
  }
  if (state.phase === "question") planAnswer(p, state);
  if (p.flaky && !p.dropped && p.answered >= 2 && Math.random() < 0.3) {
    p.dropped = true;
    p.awayUntil = Date.now() + jitter(8000);
    p.reload = Math.random() < 0.5;
    count("phones that locked their screen");
    p.stream?.abort("away");
  }
}

/* loadMe(): the phone's own view, for every new screen. */
async function loadMe(p, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await call("me", "GET", `${base(p)}/api/games/${p.game.pin}/players/${p.playerId}`, { token: p.token, ip: p.ip });
    if (key !== p.key) return;   // the game moved on while this was on its way
    if (r.status === 200) return mine(p, r.data);
    if (r.status === 401 || r.status === 404) return;
    await pause(400 * (attempt + 1));
  }
  count("screens a phone never got its own view of");
}

function mine(p, me) {
  if (me.phase === "reveal" && me.result) {
    p.earned.set(me.index, me.result.points);
    const sent = p.sent.get(me.index);
    // fairElapsed believes a phone by up to 0.6 s; beyond that, time the server spent counts against it
    if (me.result.ms != null && sent != null) hist("answer time charged beyond the phone's own").add(Math.max(0, me.result.ms - sent));
  }
  if (me.final) {
    p.final = me;
    p.done = true;
    p.stream?.abort("done");
  }
}

function planAnswer(p, state) {
  const q = state.question;
  if (!q || p.answering.has(state.index)) return;
  p.answering.add(state.index);
  const at = q.opensAt + think(q.limitMs);   // on the server's clock
  setTimeout(() => answer(p, state.index, q), at - p.clock.now());
}

/* How long a person takes. "human" is scripts/load-test.js; "burst" is an
 * easy question, most of the room tapping within two seconds; "late" a hard
 * one, half the room waiting for the last seconds. */
function think(limitMs) {
  const spread = () => 600 + Math.random() * Math.min(9000, limitMs * 0.6);
  if (cfg.answers === "burst") return Math.random() < 0.7 ? 300 + Math.random() * 1700 : spread();
  if (cfg.answers === "late") return Math.random() < 0.5 ? limitMs - 3000 + Math.random() * 2600 : spread();
  return spread();
}

async function answer(p, index, q) {
  if (p.done || p.key !== `running:question:${index}`) return;   // the screen moved on first
  if (p.awayUntil) {
    p.answering.delete(index);   // the screen is locked: no tap, maybe later
    return;
  }
  const elapsedMs = Math.round(p.clock.now() - q.opensAt);
  if (elapsedMs > q.limitMs) {
    count("answers not sent: the phone's clock had run out");
    return;
  }
  count("answers sent");
  p.sent.set(index, elapsedMs);
  const body = { playerId: p.playerId, index, choice: Math.floor(Math.random() * q.options.length), elapsedMs };
  // client/js/player.js's sendAnswer(): a tap lost on the way goes again until the question closes
  for (let attempt = 0; ; attempt++) {
    const r = await call("answer", "POST", `${base(p)}/api/games/${p.game.pin}/answers`, { token: p.token, ip: p.ip, body });
    if (r.status === 200 || (attempt > 0 && r.data?.code === "already_answered")) {
      count("answers accepted");
      p.answered += 1;
      return;
    }
    if ((r.status !== 0 && r.status < 500) || p.clock.now() > q.deadline + GRACE_MS) return;
    await pause(Math.min(2000, 300 * 2 ** attempt));
  }
}

/* ---------- a host and a game ---------- */

async function press(g, action, from) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = Date.now();
    const r = await call(`host ${action}`, "POST", `${base()}/api/host/games/${g.pin}/${action}`, { body: { from }, ip: hostIp() });
    if (r.status === 200) {
      g.marks.set(keyOf(r.data), t);
      return r.data;
    }
    if (r.status && r.status < 500) return null;
    await pause(1000);   // the presenter presses again; `from` makes a repeat harmless
  }
  return null;
}

/* Resolves with the host screen's state once ok(state), or null by `by`. */
async function until(g, ok, by) {
  while (Date.now() < by) {
    if (g.state && ok(g.state)) return g.state;
    await pause(50);
  }
  return null;
}

async function runGame(slot) {
  const created = await call("host create", "POST", `${base()}/api/host/games`, { body: { quizId: cfg.quizId }, ip: hostIp() });
  if (created.status !== 201) {
    count("games that could not be created");
    return;
  }
  const g = { slot, pin: created.data.pin, deadlines: new Map(), seen: new Map(), marks: new Map(), state: null, revealed: new Set() };
  g.host = screen(g, { ip: hostIp(), onState: state => { g.state = state; } });
  follow(g.host);
  const joinBy = Date.now() + cfg.joinWindowMs;
  g.phones = Array.from({ length: cfg.players }, (_, i) => makePhone(g, i));
  const playing = g.phones.map(p => phone(p, joinBy).catch(err => count(`phone crashed: ${err.message}`)));

  // The presenter waits for the room, then steps through the game.
  await until(g, s => s.players >= Math.floor(cfg.players * 0.98), joinBy + 10_000);
  let state = await press(g, "next", { phase: "lobby", index: -1 });
  while (state && state.status !== "finished" && state.phase !== "final") {
    if (state.phase === "question") {
      const index = state.index;
      process.send({ type: "question", index });
      const shown = await until(g, s => s.index > index || s.phase === "final" || (s.index === index && s.phase !== "question"),
        state.question.deadline + GRACE_MS + 10_000);
      if (!shown) {
        count("questions the host screen never saw close");
        state = (await call("host look", "GET", `${base()}/api/host/games/${g.pin}`, { ip: hostIp() })).data;
        continue;
      }
      state = shown;
    }
    if (state.phase === "reveal") g.revealed.add(state.index);
    // The presenter talks for a moment — never exactly as long, or every press
    // would land at the same point of the server's 250 ms look for changes.
    await pause(jitter(state.phase === "reveal" ? 2500 : 1500));
    const last = state.phase === "reveal" && state.index + 1 >= cfg.questions;
    state = await press(g, last ? "end" : "next", { phase: state.phase, index: state.index });
  }
  if (!state) count("games the host could not finish");

  await Promise.race([Promise.all(playing), pause(20_000)]);   // the phones fetch their final screens
  for (const s of [g.host, ...g.phones]) {
    if (s.stormAt && (s === g.host || s.playerId)) count("screens not back after the storm");
    s.done = true;
    s.stream?.abort("done");
    screens.delete(s);
  }
  settle(g);
}

/* What the room saw, and whether the scores add up. A phone on a slow line
 * is late whatever the server does, so it is counted apart from the room. */
function settle(g) {
  for (const [key, seen] of g.seen) {
    const mark = g.marks.get(key);
    if (mark) {
      for (const [t, line] of seen) {
        if (line !== "slow line") hist("Next → phone shows it").add(t - mark);
        if (line) hist(`Next → phone shows it (${line})`).add(t - mark);
      }
    }
    const times = seen.filter(([, line]) => line !== "slow line").map(([t]) => t);
    if (times.length > 1) hist("first → last phone on a new screen").add(Math.max(...times) - Math.min(...times));
    const [, phase, index] = key.split(":");
    const deadline = g.deadlines.get(Number(index));
    if (phase === "reveal" && deadline) {
      for (const t of times) if (t > deadline + GRACE_MS - 50) hist("clock out → phone shows the reveal").add(t - deadline - GRACE_MS);
    }
  }
  const joined = g.phones.filter(p => p.playerId);
  const finished = joined.filter(p => p.final);
  count("phones that reached the final screen", finished.length);
  for (const p of finished) {
    if (p.earned.size !== p.final.final?.played) continue;   // it missed a reveal while away: nothing to add up
    const sum = [...p.earned.values()].reduce((a, b) => a + b, 0);
    count(sum === p.final.me.score ? "scores that add up" : "scores that do not add up");
  }
  if (joined.length && finished.length === joined.length) {
    const ranks = finished.map(p => p.final.standing?.rank).sort((a, b) => a - b);
    count(ranks.every((r, i) => r === i + 1) ? "games ranked 1…N" : "games with broken ranks");
  }
  count("games played");
}

/* ---------- the process ---------- */

process.on("message", async msg => {
  if (msg.type === "start") {
    cfg = msg.cfg;
    const r = await fetch(`${base()}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": hostIp() },
      body: JSON.stringify({ password: cfg.password })
    }).catch(err => ({ ok: false, status: reason(err) }));
    if (!r.ok) return process.send({ type: "failed", error: `could not sign in: ${r.status}` });
    cookie = r.headers.get("set-cookie").split(";")[0];
    process.send({ type: "ready" });
  } else if (msg.type === "go") {
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const progress = setInterval(() => process.send({ type: "progress", counters }), 2000);
    await Promise.all(cfg.slots.map(async slot => {
      do {
        await runGame(slot);
      } while (Date.now() < cfg.soakUntil);   // a soak keeps every slot playing game after game
    }));
    clearInterval(progress);
    loop.disable();
    const cpu = process.cpuUsage(cpu0);
    const wall = performance.now() - t0;
    process.send({
      type: "result",
      hists: Object.fromEntries(Object.entries(hists).map(([k, h]) => [k, h.toJSON()])),
      counters,
      generator: { cpu: (cpu.user + cpu.system) / 10 / wall, loopP99: loop.percentile(99) / 1e6, loopMax: loop.max / 1e6 }
    }, () => process.exit(0));
  } else if (msg.type === "storm") {
    for (const s of screens) {
      if (s.done) continue;
      s.stormAt = msg.at;
      if (cfg.storm === "drop") s.stream?.abort("wake");
    }
  }
});
