/* `npm run abuse-test -- --url http://localhost:3000`
 *
 * Attacks a running Quizly the ways a bored or hostile person in the room
 * might, and checks it holds: floods, races, forged tokens and cookies,
 * injection and traversal attempts, oversized and malformed bodies. It
 * watches /api/health throughout to show the server stays responsive.
 *
 * It trips the rate limits for the address it runs from (sign-in for 15
 * minutes, PIN guessing for 10) — run it locally, or against a deployment
 * when nobody needs to sign in from that address for a while.
 *
 *   --url        where Quizly runs  (default http://localhost:3000)
 *   --password   the admin password (default $ADMIN_PASSWORD)
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.LOAD_URL || "http://localhost:3000" },
    password: { type: "string", default: process.env.ADMIN_PASSWORD || "" }
  }
});
const BASE = args.url.replace(/\/+$/, "");
const results = [];

async function call(method, path, { body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h["content-type"] ??= "application/json";
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: "manual" });
  } catch (err) {
    return { status: 0, data: null, text: String(err.cause?.code || err.message), headers: new Headers() };
  }
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data, text, headers: res.headers };
}

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const pct = (list, p) => list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((p / 100) * list.length))];

// Health is measured all the way through, so a flood that stalls the server shows up.
let attacking = true;
const health = [];
const healthLoop = (async () => {
  while (attacking) {
    const t0 = performance.now();
    const r = await fetch(`${BASE}/api/health`).catch(() => null);
    health.push(r?.ok ? performance.now() - t0 : 99_999);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
})();

/* ---------- a game to attack ---------- */

const login = await call("POST", "/api/auth/login", { body: { password: args.password } });
if (login.status !== 200) {
  console.error(`could not sign in (${login.status}) — pass --password or set ADMIN_PASSWORD`);
  process.exit(1);
}
const cookie = login.headers.get("set-cookie").split(";")[0];
const admin = { cookie };
const quiz = (await call("GET", "/api/host/quizzes", { headers: admin })).data.find(q => q.questions > 0);
const game = (await call("POST", "/api/host/games", { body: { quizId: quiz.id }, headers: admin })).data;
const pin = game.pin;
const player = (await call("POST", `/api/games/${pin}/players`, { body: { nickname: "Target" } })).data;
const auth = token => ({ authorization: `Bearer ${token}` });

/* ---------- identity and access ---------- */

check("admin API refuses requests without the cookie",
  (await call("GET", "/api/admin/quizzes")).status === 401);
check("admin API refuses a forged cookie",
  (await call("GET", "/api/admin/quizzes", { headers: { cookie: `quizly_admin=${Date.now() + 9e7}.forgedsignature` } })).status === 401);
const [exp, sig] = decodeURIComponent(cookie.split("=")[1]).split(".");
check("admin API refuses a cookie whose expiry was edited",
  (await call("GET", "/api/admin/quizzes", { headers: { cookie: `quizly_admin=${Number(exp) + 1}.${sig}` } })).status === 401);
check("host controls refuse a player's token",
  (await call("POST", `/api/host/games/${pin}/next`, { body: {}, headers: auth(player.token) })).status === 401);
check("cross-site POST is refused even with the admin cookie",
  (await call("POST", "/api/host/games", { body: { quizId: quiz.id }, headers: { ...admin, origin: "https://evil.example" } })).status === 403);
check("a player cannot read another player's private view",
  (await call("GET", `/api/games/${pin}/players/${player.playerId}`, { headers: auth("x".repeat(32)) })).status === 401);
check("a made-up player id is refused",
  (await call("GET", `/api/games/${pin}/players/00000000-0000-4000-8000-000000000000`, { headers: auth(player.token) })).status === 401);
check("a non-UUID player id is refused cleanly, not a 500",
  (await call("GET", `/api/games/${pin}/players/' or 1=1 --`, { headers: auth(player.token) })).status === 401);

/* ---------- nothing leaks before the reveal ---------- */

const decoy = (await call("POST", `/api/games/${pin}/players`, { body: { nickname: "Decoy" } })).data;
await call("POST", `/api/host/games/${pin}/next`, { body: { from: { phase: "lobby", index: -1 } }, headers: admin });
const shared = await call("GET", `/api/games/${pin}`);
const own = await call("GET", `/api/games/${pin}/players/${player.playerId}`, { headers: auth(player.token) });
check("the shared state carries no correct answer while the clock runs",
  shared.data.phase === "question" && shared.data.question.answer === undefined && !("reveal" in shared.data) && !shared.text.includes("explanation"));
check("a phone's own view carries no correct answer while the clock runs",
  own.data.phase === "question" && !("result" in own.data) && !own.text.includes('"answer"'));

/* ---------- races ---------- */

await new Promise(resolve => setTimeout(resolve, Math.max(0, shared.data.question.opensAt - Date.now()) + 100));
const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => call("POST", `/api/games/${pin}/answers`, {
  body: { playerId: player.playerId, index: 0, choice: i % shared.data.question.options.length, elapsedMs: 0 },
  headers: auth(player.token)
})));
check("25 simultaneous answers from one phone: exactly one counts",
  burst.filter(r => r.status === 200).length === 1, `${burst.filter(r => r.status === 200).length} accepted`);
const claimedInstant = (await call("POST", `/api/games/${pin}/answers`, {
  body: { playerId: decoy.playerId, index: 0, choice: 0, elapsedMs: -99999 }, headers: auth(decoy.token)
})).status;
check("a phone claiming a negative answer time is accepted but clamped", claimedInstant === 200);

const s = (await call("GET", `/api/host/games/${pin}`, { headers: admin })).data;
const nexts = await Promise.all(Array.from({ length: 30 }, () => call("POST", `/api/host/games/${pin}/next`, {
  body: { from: { phase: s.phase, index: s.index } }, headers: admin
})));
const after = (await call("GET", `/api/host/games/${pin}`, { headers: admin })).data;
check("30 simultaneous Next presses on one screen move the game one step",
  nexts.every(r => r.status === 200) && after.index === s.index && after.phase !== "question" || (s.phase === "reveal" && after.phase === "leaderboard"),
  `${s.phase}:${s.index} → ${after.phase}:${after.index}`);

const names = await Promise.all(Array.from({ length: 20 }, () =>
  call("POST", `/api/games/${pin}/players`, { body: { nickname: "Twin" } })));
check("20 simultaneous joins with one nickname: exactly one gets it",
  names.filter(r => r.status === 201).length === 1, `${names.filter(r => r.status === 201).length} joined`);

/* ---------- hostile input ---------- */

const xss = await call("POST", `/api/games/${pin}/players`, { body: { nickname: `<script>alert(1)</script>` } });
const roster = await call("GET", `/api/host/games/${pin}`, { headers: admin });
check("markup in a nickname is stored as text and escaped in JSON",
  xss.status === 201 && !roster.text.includes("<script>"));
check("an emoji-and-direction-override nickname is cleaned",
  (await call("POST", `/api/games/${pin}/players`, { body: { nickname: "‮evil\u0000" } })).data.nickname === "evil");
check("SQL in a PIN finds no game",
  (await call("POST", `/api/games/${encodeURIComponent("1' or '1'='1")}/players`, { body: { nickname: "x" } })).status === 404);
check("SQL in a quiz id finds no quiz",
  (await call("GET", `/api/admin/quizzes/${encodeURIComponent("x' or 1=1 --")}`, { headers: admin })).status === 404);
check("malformed JSON is a 400, not a 500",
  (await call("POST", `/api/games/${pin}/players`, { raw: "{nickname:" })).status === 400);
check("a 1 MB body is refused",
  (await call("POST", `/api/games/${pin}/players`, { raw: JSON.stringify({ nickname: "x".repeat(1_000_000) }) })).status === 413);
check("a nickname that is an object or array is refused",
  (await call("POST", `/api/games/${pin}/players`, { body: { nickname: { $gt: "" } } })).status === 400 &&
  (await call("POST", `/api/games/${pin}/players`, { body: { nickname: ["a", "b"] } })).status === 400);
check("prototype keys in a body do nothing",
  (await call("POST", `/api/games/${pin}/players`, { raw: '{"__proto__":{"admin":true},"nickname":"Proto"}' })).status === 201 &&
  (await call("GET", "/api/auth/me")).data.admin === false);

for (const path of ["/../server/config.js", "/%2e%2e/server/config.js", "/shared/..%2fserver/config.js",
  "/js/..%2f..%2fpackage.json", "/.env", "/.git/config", "/server/app.js", "/node_modules/pg/package.json"]) {
  const r = await call("GET", path);
  check(`traversal ${path} serves nothing`, r.status === 404 || (r.status >= 300 && r.status < 400) || !/import|DATABASE_URL|"name"|\[core\]/.test(r.text), `${r.status}`);
}

/* ---------- floods ---------- */

const t0 = performance.now();
const guesses = await Promise.all(Array.from({ length: 300 }, (_, i) =>
  call("POST", `/api/games/${String(100000 + ((i * 7919) % 900000)).padStart(6, "0")}/players`, { body: { nickname: "guess" } })));
const blocked = guesses.filter(r => r.status === 429).length;
check("300 PIN guesses at once: the guessing is cut off", blocked > 200, `${blocked} refused with 429 in ${(performance.now() - t0).toFixed(0)} ms`);

const passwords = await Promise.all(Array.from({ length: 40 }, (_, i) =>
  call("POST", "/api/auth/login", { body: { password: `guess-${i}` } })));
check("40 password guesses at once: cut off after twenty",
  passwords.filter(r => r.status === 429).length >= 15, `${passwords.filter(r => r.status === 429).length} refused with 429`);

// 2000 polls, 200 in flight at any moment: three rooms' worth of phones all asking at once.
const polls = [];
const tPoll = performance.now();
await Promise.all(Array.from({ length: 200 }, async () => {
  while (polls.length < 2000) {
    polls.push(null);
    polls[polls.length - 1] = await call("GET", `/api/games/${pin}`);
  }
}));
const pollFailures = polls.filter(r => r?.status !== 200).length;
check("2000 polls with 200 in flight all succeed", pollFailures === 0,
  `${pollFailures} failed · ${(2000 / ((performance.now() - tPoll) / 1000)).toFixed(0)} requests/s`);

attacking = false;
await healthLoop;
const p99 = pct(health, 99);
check("the server stayed responsive throughout", p99 < 1000, `health p50 ${pct(health, 50).toFixed(0)} ms · p99 ${p99.toFixed(0)} ms · max ${Math.max(...health).toFixed(0)} ms over ${health.length} probes`);

await call("POST", `/api/host/games/${pin}/end`, { body: {}, headers: admin });
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
