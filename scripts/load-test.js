/* `npm run load-test -- --url https://your-app.vercel.app --players 60`
 *
 * Plays one whole game against a running Quizly with simulated phones that
 * behave like people: they join over a few seconds, poll about once a
 * second, answer at human speed, and some lock their screen for a while or
 * reload the page. One simulated host runs the game. At the end every score
 * is checked against the points each phone was told it earned.
 *
 *   --url        where Quizly runs                    (default http://localhost:3000)
 *   --password   the admin password                   (default $ADMIN_PASSWORD)
 *   --players    how many phones                      (default 60)
 *   --quiz       quiz id to play                      (default the first with questions)
 *   --questions  stop after this many                 (default all in the round)
 *   --flaky      share of phones that drop out a while (default 0.15)
 *
 * The game it creates is a real one: delete it from the admin panel's
 * Results tab afterwards if you ran this against production.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.LOAD_URL || "http://localhost:3000" },
    password: { type: "string", default: process.env.ADMIN_PASSWORD || "" },
    players: { type: "string", default: "60" },
    quiz: { type: "string", default: "" },
    questions: { type: "string", default: "0" },
    flaky: { type: "string", default: "0.15" }
  }
});
const BASE = args.url.replace(/\/+$/, "");
const PLAYERS = Number(args.players);
const FLAKY = Number(args.flaky);
const MAX_QUESTIONS = Number(args.questions) || Infinity;

/* ---------- measuring ---------- */

const timings = new Map();   // label → [ms]
const failures = new Map();  // "label status" → count
let requests = 0;

async function call(label, method, path, { body, token, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const t0 = performance.now();
  requests += 1;
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (err) {
    count(`${label} network`);
    throw err;
  }
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
  (timings.get(label) ?? timings.set(label, []).get(label)).push(performance.now() - t0);
  if (!res.ok) count(`${label} ${res.status}${data?.code ? " " + data.code : ""}`);
  return { status: res.status, data, headers: res.headers };
}

function count(key) {
  failures.set(key, (failures.get(key) ?? 0) + 1);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (ms, spread = 0.3) => ms * (1 - spread + Math.random() * spread * 2);
const pct = (list, p) => list.length ? list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((p / 100) * list.length))] : 0;

/* ---------- the host ---------- */

const login = await call("login", "POST", "/api/auth/login", { body: { password: args.password } });
if (login.status !== 200) {
  console.error(`could not sign in (${login.status}): ${login.data?.error ?? login.data}. Pass --password or set ADMIN_PASSWORD.`);
  process.exit(1);
}
const cookie = login.headers.get("set-cookie").split(";")[0];
const quizzes = (await call("quizzes", "GET", "/api/host/quizzes", { cookie })).data;
const quiz = args.quiz ? quizzes.find(q => q.id === args.quiz) : quizzes.find(q => q.questions > 0);
if (!quiz) {
  console.error("no quiz with questions to play: import data/questions.json in the admin panel first");
  process.exit(1);
}
const created = await call("create", "POST", "/api/host/games", { body: { quizId: quiz.id }, cookie });
if (created.status !== 201) {
  console.error("could not create a game:", created.data);
  process.exit(1);
}
const pin = created.data.pin;
console.log(`game ${pin} · "${quiz.title}" · ${created.data.total} questions · ${PLAYERS} phones · ${BASE}`);

/* ---------- the phones ---------- */

let finished = false;
const phones = Array.from({ length: PLAYERS }, (_, i) => ({
  i,
  nickname: `Bot ${String(i + 1).padStart(3, "0")}`,
  flaky: Math.random() < FLAKY,
  playerId: null,
  token: null,
  key: "",
  earned: new Map(),   // question index → points the reveal reported
  answered: 0,
  final: null
}));

async function phone(p) {
  await pause(Math.random() * Math.min(10_000, PLAYERS * 120));   // people scan the QR code over a few seconds
  const joined = await call("join", "POST", `/api/games/${pin}/players`, { body: { nickname: p.nickname } });
  if (joined.status !== 201) return;
  p.playerId = joined.data.playerId;
  p.token = joined.data.token;
  let dropped = false;

  while (!finished || !p.final) {
    // a flaky phone locks its screen for a while once, mid-game
    if (p.flaky && !dropped && p.answered >= 2 && Math.random() < 0.3) {
      dropped = true;
      await pause(jitter(8000));
      if (Math.random() < 0.5) p.key = "";   // half of them come back as a reload: everything refetched
    }
    const state = await call("state", "GET", `/api/games/${pin}`).catch(() => null);
    const s = state?.data;
    if (state?.status === 200 && s) {
      const key = `${s.phase}:${s.index}`;
      if (key !== p.key) {
        p.key = key;
        const mine = await call("me", "GET", `/api/games/${pin}/players/${p.playerId}`, { token: p.token }).catch(() => null);
        const me = mine?.data;
        if (me?.result && me.phase === "reveal") p.earned.set(me.index, me.result.points);
        if (me?.final) p.final = me;
        if (s.phase === "question" && me?.phase === "question" && me.choice === null) answerLater(p, s);
      }
      if (s.phase === "final" && p.final) return;
    }
    await pause(jitter(1000, 0.2));
  }
}

/* Answers like a person: a moment to read, a moment to think. */
async function answerLater(p, s) {
  const q = s.question;
  const thinking = 600 + Math.random() * Math.min(9000, q.limitMs * 0.6);
  await pause(Math.max(0, q.opensAt - Date.now()) + thinking);
  const choice = Math.floor(Math.random() * q.options.length);
  const r = await call("answer", "POST", `/api/games/${pin}/answers`, {
    token: p.token,
    body: { playerId: p.playerId, index: s.index, choice, elapsedMs: Math.round(thinking) }
  }).catch(() => null);
  if (r?.status === 200) p.answered += 1;
}

/* ---------- the run ---------- */

const healthLatencies = [];
const health = (async () => {
  while (!finished) {
    const t0 = performance.now();
    await fetch(`${BASE}/api/health`).catch(() => {});
    healthLatencies.push(performance.now() - t0);
    await pause(500);
  }
})();

const started = Date.now();
const running = phones.map(p => phone(p).catch(err => count(`phone crashed: ${err.message}`)));

// Host: wait for the room, then step through the game like a presenter.
for (;;) {
  const s = (await call("host", "GET", `/api/host/games/${pin}`, { cookie })).data;
  if (s.players >= PLAYERS * 0.98 || Date.now() - started > 25_000) break;
  await pause(1000);
}
const perQuestion = [];
let state = (await call("next", "POST", `/api/host/games/${pin}/next`, { cookie, body: { from: { phase: "lobby", index: -1 } } })).data;
for (;;) {
  if (state.phase === "question") {
    const opened = Date.now();
    while (state.phase === "question") {
      await pause(1000);
      state = (await call("host", "GET", `/api/host/games/${pin}`, { cookie })).data;
    }
    perQuestion.push({ index: state.index, seconds: (Date.now() - opened) / 1000, answered: state.reveal?.answered, of: state.players });
  }
  if (state.phase === "final") break;
  await pause(state.phase === "reveal" ? 2500 : 1500);   // the presenter talks for a moment
  const stopHere = state.phase === "reveal" && state.index + 1 >= MAX_QUESTIONS;
  const action = stopHere ? "end" : "next";
  state = (await call(action, "POST", `/api/host/games/${pin}/${action}`, { cookie, body: { from: { phase: state.phase, index: state.index } } })).data;
}
finished = true;
await Promise.race([Promise.all(running), pause(20_000)]);
await health;
const seconds = (Date.now() - started) / 1000;

/* ---------- checking ---------- */

const final = (await call("host", "GET", `/api/host/games/${pin}`, { cookie })).data;
const joined = phones.filter(p => p.playerId);
const withFinal = joined.filter(p => p.final);
const mismatched = withFinal.filter(p => [...p.earned.values()].reduce((a, b) => a + b, 0) !== p.final.me.score && p.earned.size === final.total);
const ranks = withFinal.map(p => p.final.standing.rank).sort((a, b) => a - b);
const ranksOk = ranks.every((r, i) => r === i + 1);

/* ---------- report ---------- */

console.log(`\n${joined.length}/${PLAYERS} phones joined · ${withFinal.length} reached the final screen · ${seconds.toFixed(0)}s · ${requests} requests (${(requests / seconds).toFixed(1)}/s)`);
console.log("\nlatency (ms)         count     p50     p95     p99     max");
for (const [label, list] of [...timings].sort()) {
  console.log(`${label.padEnd(18)} ${String(list.length).padStart(7)} ${[50, 95, 99].map(p => pct(list, p).toFixed(0).padStart(7)).join(" ")} ${Math.max(...list).toFixed(0).padStart(7)}`);
}
console.log(`${"health (loop)".padEnd(18)} ${String(healthLatencies.length).padStart(7)} ${[50, 95, 99].map(p => pct(healthLatencies, p).toFixed(0).padStart(7)).join(" ")} ${Math.max(0, ...healthLatencies).toFixed(0).padStart(7)}`);
console.log("\nper question: " + perQuestion.map(q => `#${q.index + 1} ${q.seconds.toFixed(1)}s ${q.answered}/${q.of}`).join(" · "));
console.log(`\nfailures: ${failures.size ? [...failures].map(([k, n]) => `${k} ×${n}`).join(", ") : "none"}`);
console.log(`scores consistent with every reveal: ${mismatched.length === 0 ? "yes" : `NO — ${mismatched.length} differ`}`);
console.log(`final ranks 1..${withFinal.length} with no gaps or ties: ${ranksOk ? "yes" : "NO"}`);
console.log(`podium: ${(final.leaderboard || []).slice(0, 3).map(r => `${r.rank}. ${r.nickname} ${r.score}`).join(" · ")}`);
// Refusals the server is meant to give: a late tap, or a second tap from a phone
// that reloaded while its first answer was on the way.
const unexpected = [...failures.keys()].filter(k => !/answer 409 (too_late|not_open|already_answered)/.test(k));
process.exit(mismatched.length || !ranksOk || unexpected.length || withFinal.length < joined.length ? 1 : 0);
