/* The whole HTTP API against a real Postgres: a quiz imported, a game
 * hosted, players joining and answering, the clock running out, the final
 * screen and the results — plus the rules and the guards around them.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PASSWORD, client, startTestApp } from "./helpers.js";

let app;
let admin;
let anon;
let quizId;

before(async () => {
  app = await startTestApp();
  admin = client(app.base);
  anon = client(app.base);
});

after(() => app?.close());

const bearer = token => ({ authorization: `Bearer ${token}` });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function correctAnswer(pin, index) {
  const { rows: [g] } = await app.context.pool.query(
    "select round from games where pin = $1 order by created_at desc limit 1", [pin]);
  return g.round[index].answer;
}

test("health check reaches the database", async () => {
  const r = await anon("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test("admin and host routes need the password", async () => {
  assert.equal((await anon("GET", "/api/admin/quizzes")).status, 401);
  assert.equal((await anon("POST", "/api/host/games", { quizId: "x" })).status, 401);
  assert.equal((await anon("GET", "/api/auth/me")).data.admin, false);
  assert.equal((await admin("POST", "/api/auth/login", { password: "wrong" })).status, 401);

  const ok = await admin("POST", "/api/auth/login", { password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(ok.headers.get("set-cookie"), /SameSite=Lax/i);
  assert.equal((await admin("GET", "/api/auth/me")).data.admin, true);
});

test("quizzes are imported, edited and validated", async () => {
  const sample = app.sample();
  const created = await admin("POST", "/api/admin/quizzes", { data: sample });
  assert.equal(created.status, 201);
  assert.equal(created.data.title, "AI Quiz");
  assert.equal(created.data.questions.length, 18);
  quizId = created.data.id;

  const bad = await admin("PUT", `/api/admin/quizzes/${quizId}/questions/q99`,
    { id: "q99", prompt: "Half a question", options: ["only one"], answer: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /two options/);

  const good = await admin("PUT", `/api/admin/quizzes/${quizId}/questions/q99`,
    { id: "q99", category: "Extra", prompt: "Is this saved?", options: ["Yes", "No"], answer: 0, explanation: "It is." });
  assert.equal(good.status, 200);
  assert.equal((await admin("GET", `/api/admin/quizzes/${quizId}`)).data.questions.length, 19);
  assert.equal((await admin("DELETE", `/api/admin/quizzes/${quizId}/questions/q99`)).status, 200);
  assert.equal((await admin("DELETE", `/api/admin/quizzes/${quizId}/questions/q99`)).status, 404);

  // Out-of-range settings are clamped, not stored as given.
  const settings = await admin("PUT", `/api/admin/quizzes/${quizId}/settings`,
    { ...sample.settings, secondsPerQuestion: 1, questionsPerRound: 3, shuffleQuestions: false });
  assert.equal(settings.data.settings.secondsPerQuestion, 5);
  assert.equal(settings.data.settings.questionsPerRound, 3);

  const renamed = await admin("PATCH", `/api/admin/quizzes/${quizId}`, { title: "  AI   Quiz  " });
  assert.equal(renamed.data.title, "AI Quiz");

  const badImport = await admin("PUT", `/api/admin/quizzes/${quizId}/import`, { questions: [{ prompt: "x", options: ["a", "b"], answer: 5 }] });
  assert.equal(badImport.status, 400);
  assert.equal((await admin("GET", `/api/admin/quizzes/${quizId}`)).data.questions.length, 18, "a failed import changes nothing");
});

test("a whole game: join, answer, reveal, streaks, the clock, the podium and the results", async () => {
  const hosted = await admin("POST", "/api/host/games", { quizId });
  assert.equal(hosted.status, 201);
  const pin = hosted.data.pin;
  assert.match(pin, /^\d{6}$/);
  assert.equal(hosted.data.phase, "lobby");
  assert.ok(hosted.data.joinUrl.endsWith(`/?pin=${pin}`));

  const qr = await anon("GET", `/api/games/${pin}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(qr.data, /<svg/);

  // Joining
  const join = (nickname, avatar) => anon("POST", `/api/games/${pin}/players`, { nickname, avatar });
  const aysel = (await join("Aysel", "🦊")).data;
  const kamran = (await join("Kamran")).data;
  const sneaky = (await join("=cmd|' /C calc'!A0")).data;
  assert.equal(aysel.avatar, "🦊");
  assert.equal((await join("aysel")).data.code, "nickname_taken");
  assert.equal((await join("   ")).data.code, "bad_nickname");
  assert.equal((await anon("POST", "/api/games/000000/players", { nickname: "x" })).status, 404);
  const me = p => anon("GET", `/api/games/${pin}/players/${p.playerId}`, undefined, bearer(p.token));
  const answer = (p, index, choice, extra = {}) =>
    anon("POST", `/api/games/${pin}/answers`, { playerId: p.playerId, index, choice, elapsedMs: 1000, ...extra }, bearer(p.token));

  const lobby = await admin("GET", `/api/host/games/${pin}`);
  assert.equal(lobby.data.players, 3);
  assert.deepEqual(lobby.data.roster.map(p => p.nickname), ["Aysel", "Kamran", "=cmd|' /C calc'!A0"]);

  // Question 1: everyone answers, so it closes without waiting for the clock.
  let s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } })).data;
  assert.equal(s.phase, "question");
  assert.equal(s.index, 0);
  assert.equal(s.total, 3);
  assert.equal(s.question.answer, undefined, "the correct answer stays on the server while the clock runs");
  assert.equal(s.reveal, undefined);
  const right0 = await correctAnswer(pin, 0);
  const wrong0 = (right0 + 1) % s.question.options.length;
  assert.equal((await me(aysel)).data.choice, null);

  assert.equal((await answer(aysel, 0, right0)).status, 200);
  assert.equal((await answer(aysel, 0, wrong0)).data.code, "already_answered");
  assert.equal((await answer(kamran, 0, 99)).data.code, "bad_choice");
  assert.equal((await answer(kamran, 1, wrong0)).data.code, "not_open");
  assert.equal((await answer({ ...kamran, token: "forged" }, 0, wrong0)).status, 401);
  assert.equal((await answer({ ...kamran, token: aysel.token }, 0, wrong0)).status, 401, "a token only works for its own player");
  assert.equal((await answer(kamran, 0, wrong0)).status, 200);
  assert.equal((await me(kamran)).data.choice, wrong0);
  assert.equal((await admin("GET", `/api/host/games/${pin}`)).data.answered, 2);
  assert.equal((await answer(sneaky, 0, right0)).status, 200);

  s = (await admin("GET", `/api/host/games/${pin}`)).data;
  assert.equal(s.phase, "reveal", "the last answer closed the question");
  assert.equal(s.reveal.answer, right0);
  assert.equal(s.reveal.answered, 3);
  assert.equal(s.reveal.correct, 2);
  assert.equal(s.reveal.counts.reduce((a, b) => a + b), 3);

  let a = (await me(aysel)).data;
  assert.equal(a.result.correct, true);
  assert.ok(a.result.points >= 500 && a.result.points <= 1000, `points ${a.result.points}`);
  assert.equal(a.result.bonus, 0);
  assert.equal(a.standing.of, 3);
  const k = (await me(kamran)).data;
  assert.equal(k.result.correct, false);
  assert.equal(k.result.points, 0);
  assert.equal(k.standing.rank, 3);

  // A second click on the same screen does nothing.
  s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "reveal", index: 0 } })).data;
  assert.equal(s.phase, "leaderboard");
  s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "reveal", index: 0 } })).data;
  assert.equal(s.phase, "leaderboard");
  assert.equal(s.leaderboard.length, 3);

  // Question 2: Aysel's second right answer in a row earns the streak bonus.
  s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "leaderboard", index: 0 } })).data;
  assert.equal(s.index, 1);
  const right1 = await correctAnswer(pin, 1);
  await answer(aysel, 1, right1);
  await answer(kamran, 1, right1);
  await answer(sneaky, 1, (right1 + 1) % s.question.options.length);
  a = (await me(aysel)).data;
  assert.equal(a.phase, "reveal");
  assert.equal(a.result.bonus, 100);
  assert.equal(a.me.streak, 2);
  assert.equal(a.standing.rank, 1);

  // Question 3: only Aysel answers, so the clock has to run out (5 s + grace).
  await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "reveal", index: 1 } });
  s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "leaderboard", index: 1 } })).data;
  assert.equal(s.index, 2);
  await answer(aysel, 2, await correctAnswer(pin, 2));
  assert.equal((await admin("GET", `/api/host/games/${pin}`)).data.phase, "question");
  await pause(s.question.deadline - Date.now() + 1600);
  assert.equal((await answer(kamran, 2, 0)).data.code, "not_open", "too late once the question has closed");
  s = (await admin("GET", `/api/host/games/${pin}`)).data;
  assert.equal(s.phase, "reveal", "the first request after the deadline closed the question");

  // The end
  s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "reveal", index: 2 } })).data;
  assert.equal(s.phase, "final");
  assert.equal(s.status, "finished");
  assert.deepEqual(s.awards.map(x => x.key).sort(), ["fastest", "streak"]);
  assert.equal(s.leaderboard[0].nickname, "Aysel");

  a = (await me(aysel)).data;
  assert.equal(a.final.correct, 3);
  assert.equal(a.final.played, 3);
  assert.deepEqual(a.final.badges.map(b => b.title), ["Winner", "Flawless", "Fastest finger", "Longest streak"]);
  assert.equal(a.final.podium.length, 3);
  assert.equal((await answer(kamran, 2, 0)).data.code, "not_open");

  // Results, and a CSV that a spreadsheet cannot run as a formula
  const list = (await admin("GET", "/api/admin/games")).data;
  const game = list.find(g => g.pin === pin);
  assert.equal(game.players, 3);
  assert.equal(game.played, 3);
  const results = (await admin("GET", `/api/admin/games/${game.id}`)).data;
  assert.equal(results.standings[0].nickname, "Aysel");
  assert.equal(results.questions.length, 3);
  const csv = await admin("GET", `/api/admin/games/${game.id}/results.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /attachment/);
  assert.ok(csv.data.startsWith("rank,nickname"));
  // fetch's text() drops a leading BOM while decoding, so look at the bytes for the one Excel needs.
  const cookie = (await admin("GET", "/api/auth/me")).headers.get("set-cookie");
  const login = await fetch(`${app.base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD })
  });
  const bytes = new Uint8Array(await (await fetch(`${app.base}/api/admin/games/${game.id}/results.csv`, {
    headers: { cookie: login.headers.get("set-cookie").split(";")[0] }
  })).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(cookie, null);
  assert.ok(csv.data.includes(`"'=cmd|' /C calc'!A0"`) || csv.data.includes("'=cmd|' /C calc'!A0"));
  assert.ok(!/(^|,)=cmd/m.test(csv.data));
  assert.equal((await admin("DELETE", `/api/admin/games/${game.id}`)).status, 200);
});

test("when the last answers arrive together, the question still closes at once", async () => {
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  const room = [];
  for (let i = 0; i < 6; i++) room.push((await anon("POST", `/api/games/${pin}/players`, { nickname: `Racer ${i}` })).data);
  await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } });
  const all = await Promise.all(room.map(p => anon("POST", `/api/games/${pin}/answers`,
    { playerId: p.playerId, index: 0, choice: 0, elapsedMs: 900 }, bearer(p.token))));
  assert.ok(all.every(r => r.status === 200));
  assert.equal((await admin("GET", `/api/host/games/${pin}`)).data.phase, "reveal", "nobody waits for the clock");
  await admin("POST", `/api/host/games/${pin}/end`);
});

test("the host can remove a player, and an empty lobby can be closed", async () => {
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  const p = (await anon("POST", `/api/games/${pin}/players`, { nickname: "Troll" })).data;
  const q = (await anon("POST", `/api/games/${pin}/players`, { nickname: "Fine" })).data;
  const kicked = await admin("POST", `/api/host/games/${pin}/kick`, { playerId: p.playerId });
  assert.deepEqual(kicked.data.roster.map(x => x.nickname), ["Fine"]);
  assert.equal((await anon("GET", `/api/games/${pin}/players/${p.playerId}`, undefined, bearer(p.token))).data.kicked, true);
  // The nickname is free again for someone else.
  assert.equal((await anon("POST", `/api/games/${pin}/players`, { nickname: "troll" })).status, 201);
  assert.equal((await admin("POST", `/api/host/games/${pin}/kick`, { playerId: "not-a-uuid" })).data.code, "no_player");
  assert.ok(q.playerId);

  const ended = await admin("POST", `/api/host/games/${pin}/end`);
  assert.equal(ended.data.status, "abandoned");
  assert.equal((await anon("POST", `/api/games/${pin}/players`, { nickname: "Late" })).data.code, "game_over");
});

test("a locked game turns new players away, and the host can remove someone mid-game", async () => {
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  const first = (await anon("POST", `/api/games/${pin}/players`, { nickname: "Early" })).data;
  const second = (await anon("POST", `/api/games/${pin}/players`, { nickname: "Prankster" })).data;

  const locked = await admin("POST", `/api/host/games/${pin}/lock`, { locked: true });
  assert.equal(locked.data.locked, true);
  const refused = await anon("POST", `/api/games/${pin}/players`, { nickname: "Bot 1" });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "game_locked");
  assert.equal((await anon("GET", `/api/games/${pin}`)).data.locked, true);

  // Players already in carry on: the game starts and they can answer.
  let s = (await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } })).data;
  assert.equal(s.phase, "question");
  const r = await anon("POST", `/api/games/${pin}/answers`,
    { playerId: first.playerId, index: 0, choice: 0, elapsedMs: 500 }, bearer(first.token));
  assert.equal(r.status, 200);

  // Removing the only player still to answer closes the question.
  s = (await admin("POST", `/api/host/games/${pin}/kick`, { playerId: second.playerId })).data;
  assert.equal(s.phase, "reveal");
  assert.equal(s.players, 1);
  const late = await anon("POST", `/api/games/${pin}/answers`,
    { playerId: second.playerId, index: 0, choice: 1 }, bearer(second.token));
  assert.equal(late.status, 403);
  assert.equal(late.data.code, "kicked", "a removed player is told so");

  assert.equal((await admin("POST", `/api/host/games/${pin}/lock`, { locked: false })).data.locked, false);
  assert.equal((await anon("POST", `/api/games/${pin}/players`, { nickname: "Latecomer" })).status, 201, "open again: late joiners welcome");
  assert.equal((await anon("POST", `/api/host/games/${pin}/lock`, { locked: true })).status, 401, "only the host can lock");
  await admin("POST", `/api/host/games/${pin}/end`);
});

test("guards: cross-site writes, bad bodies, escaping, and nothing secret in the shared state", async () => {
  const evil = { origin: "https://evil.example" };
  assert.equal((await anon("POST", "/api/auth/login", { password: PASSWORD }, evil)).status, 403);
  assert.equal((await admin("POST", "/api/host/games", { quizId }, evil)).status, 403);

  const raw = await fetch(`${app.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(raw.status, 400);
  const big = await fetch(`${app.base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x".repeat(600_000) })
  });
  assert.equal(big.status, 413);

  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  await anon("POST", `/api/games/${pin}/players`, { nickname: "<img src=x onerror=alert(1)>" });
  const text = await (await fetch(`${app.base}/api/games/${pin}`)).text();
  assert.ok(!text.includes("<img"), "angle brackets are escaped in JSON");
  assert.ok(text.includes("\\u003cimg"));

  const res = await fetch(`${app.base}/api/games/${pin}`);
  assert.match(res.headers.get("cache-control"), /s-maxage=1/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(`${app.base}/server/config.js`)).status, 404, "server code is not served");
  assert.match(await (await fetch(`${app.base}/no-such-page`)).text(), /Nothing here/);
  assert.equal((await fetch(`${app.base}/.env`)).status, 404);
  await admin("POST", `/api/host/games/${pin}/end`);
});

test("rate limits: PIN guessing and password guessing", async () => {
  let blocked = false;
  for (let i = 0; i < 35 && !blocked; i++) {
    blocked = (await anon("POST", "/api/games/000001/players", { nickname: "guess" })).status === 429;
  }
  assert.ok(blocked, "PIN guessing is cut off");

  const guesser = client(app.base);
  blocked = false;
  for (let i = 0; i < 25 && !blocked; i++) {
    blocked = (await guesser("POST", "/api/auth/login", { password: `guess-${i}` })).status === 429;
  }
  assert.ok(blocked, "password guessing is cut off");
  await app.context.pool.query("delete from rate_limits");
});

test("requests that fail on purpose cannot use up a shared address's allowance", async () => {
  // Everyone in the room shares one address; a troll must not be able to lock them out.
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  const junk = [];
  for (let i = 0; i < 16; i++) {
    junk.push(...await Promise.all(Array.from({ length: 20 }, () => anon("POST", `/api/games/${pin}/players`, { nickname: "" }))));
  }
  assert.equal(junk.length, 320);
  assert.ok(junk.every(r => r.data.code === "bad_nickname"));
  assert.equal((await anon("POST", `/api/games/${pin}/players`, { nickname: "Real person" })).status, 201);

  for (let i = 0; i < 19; i++) await anon("POST", "/api/auth/login", { password: `wrong-${i}` });
  assert.equal((await client(app.base)("POST", "/api/auth/login", { password: PASSWORD })).status, 200,
    "the presenter still gets in after a run of wrong passwords");
  await admin("POST", `/api/host/games/${pin}/end`);
  await app.context.pool.query("delete from rate_limits");
});
