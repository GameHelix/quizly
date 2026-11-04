/* The whole HTTP API against a real Postgres: a quiz imported, a game
 * hosted, players joining and answering, the clock running out, the final
 * screen and the results — plus the rules and the guards around them.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PASSWORD, client, startInstance, startTestApp } from "./helpers.js";

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

/* The states a live stream sends, one at a time; pings are skipped. */
function states(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 3000) {
      const giveUp = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (message.startsWith("data: ")) return JSON.parse(message.slice(6));
          continue;
        }
        let timer;
        const late = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, giveUp - Date.now()), { late: true }); });
        const chunk = await Promise.race([reader.read(), late]);
        clearTimeout(timer);
        if (chunk.late) throw new Error(`no state within ${timeoutMs} ms`);
        if (chunk.done) throw new Error("the stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close: () => reader.cancel()
  };
}

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
  assert.equal(created.data.questions.length, sample.questions.length);
  quizId = created.data.id;

  const bad = await admin("PUT", `/api/admin/quizzes/${quizId}/questions/q99`,
    { id: "q99", prompt: "Half a question", options: ["only one"], answer: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /two options/);

  const good = await admin("PUT", `/api/admin/quizzes/${quizId}/questions/q99`,
    { id: "q99", category: "Extra", prompt: "Is this saved?", options: ["Yes", "No"], answer: 0, explanation: "It is." });
  assert.equal(good.status, 200);
  assert.equal((await admin("GET", `/api/admin/quizzes/${quizId}`)).data.questions.length, sample.questions.length + 1);
  assert.equal((await admin("DELETE", `/api/admin/quizzes/${quizId}/questions/q99`)).status, 200);
  assert.equal((await admin("DELETE", `/api/admin/quizzes/${quizId}/questions/q99`)).status, 404);

  // Out-of-range settings are clamped, not stored as given.
  const settings = await admin("PUT", `/api/admin/quizzes/${quizId}/settings`,
    { ...sample.settings, speedBonus: 500, secondsPerQuestion: 1, questionsPerRound: 3, shuffleQuestions: false });
  assert.equal(settings.data.settings.secondsPerQuestion, 5);
  assert.equal(settings.data.settings.questionsPerRound, 3);

  const renamed = await admin("PATCH", `/api/admin/quizzes/${quizId}`, { title: "  AI   Quiz  " });
  assert.equal(renamed.data.title, "AI Quiz");

  const badImport = await admin("PUT", `/api/admin/quizzes/${quizId}/import`, { questions: [{ prompt: "x", options: ["a", "b"], answer: 5 }] });
  assert.equal(badImport.status, 400);
  assert.equal((await admin("GET", `/api/admin/quizzes/${quizId}`)).data.questions.length, sample.questions.length, "a failed import changes nothing");
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

  assert.ok(["Aysel", "=cmd|' /C calc'!A0"].includes(s.reveal.fastest.nickname), "the fastest right answer is named");
  assert.ok(s.reveal.fastest.ms >= 0);

  let a = (await me(aysel)).data;
  assert.equal(a.result.correct, true);
  assert.ok(a.result.points >= 500 && a.result.points <= 1000, `points ${a.result.points}`);
  assert.equal(a.result.bonus, 0);
  assert.equal(a.result.base, 500, "the points say where they came from");
  assert.ok(a.result.ms >= 0 && a.result.ms <= 1000);
  assert.equal(a.standing.of, 3);
  const k = (await me(kamran)).data;
  assert.equal(k.result.correct, false);
  assert.equal(k.result.points, 0);
  assert.equal(k.result.base, 0);
  assert.equal(k.standing.rank, 3);
  assert.equal(k.standing.behind, null, "last place has nobody behind");
  assert.ok(k.standing.ahead.gap > 0);

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
  assert.ok(a.result.points - a.result.base - a.result.bonus > 0, "a quick answer earns a speed share");
  assert.equal(a.me.streak, 2);
  assert.equal(a.standing.rank, 1);
  assert.equal(a.standing.ahead, null);
  assert.ok(a.standing.behind.gap > 0, "the leader is told who is chasing");

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
  assert.equal(a.final.bestStreak, 3);
  assert.ok(a.final.avgCorrectMs >= 0);
  assert.deepEqual(a.history, [true, true, true], "the trail of dots");
  assert.deepEqual((await me(kamran)).data.history, [false, true, null], "wrong, right, no answer");
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

test("a live stream sends every change of the game as it happens", async () => {
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  assert.equal((await fetch(`${app.base}/api/games/000000/live`)).status, 404);
  const res = await fetch(`${app.base}/api/games/${pin}/live`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.match(res.headers.get("cache-control"), /no-store/);
  const stream = states(res);

  let s = await stream.next();
  assert.equal(s.phase, "lobby");
  assert.equal(s.players, 0);
  assert.ok(Math.abs(s.now - Date.now()) < 1000, "stamped with the server's time as it is sent");

  let asked = Date.now();
  await anon("POST", `/api/games/${pin}/players`, { nickname: "Streamer" });
  s = await stream.next();
  assert.equal(s.players, 1);
  assert.ok(Date.now() - asked < 1000, `a join arrives at once (${Date.now() - asked} ms)`);

  asked = Date.now();
  await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } });
  s = await stream.next();
  assert.equal(s.phase, "question");
  assert.ok(Date.now() - asked < 1000, `the next question arrives at once (${Date.now() - asked} ms)`);

  // Nobody answers and nothing polls: the feed itself closes the question when time is up.
  s = await stream.next(s.question.deadline - Date.now() + 3000);
  assert.equal(s.phase, "reveal");
  stream.close();
  await admin("POST", `/api/host/games/${pin}/end`);
});

test("phones are sent the shared state without the names only the big screens show", async () => {
  const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
  const p = (await anon("POST", `/api/games/${pin}/players`, { nickname: "Pocket" })).data;
  const big = states(await fetch(`${app.base}/api/games/${pin}/live`));
  const phone = states(await fetch(`${app.base}/api/games/${pin}/live?phone=1`));
  let s = await big.next();
  let m = await phone.next();
  assert.deepEqual(s.roster.map(x => x.nickname), ["Pocket"]);
  assert.equal(m.roster, undefined, "no roster for a phone");
  assert.equal(m.players, 1, "but the count");
  assert.equal((await anon("GET", `/api/games/${pin}?phone=1`)).data.roster, undefined);
  assert.equal((await anon("GET", `/api/games/${pin}`)).data.roster.length, 1);

  await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } });
  s = await big.next();
  m = await phone.next();
  assert.equal(m.phase, "question");
  assert.deepEqual(m.question, s.question, "the same question on every screen");
  await anon("POST", `/api/games/${pin}/answers`, { playerId: p.playerId, index: 0, choice: 0, elapsedMs: 800 }, bearer(p.token));
  do s = await big.next(); while (s.phase !== "reveal");
  do m = await phone.next(); while (m.phase !== "reveal");
  assert.equal(s.leaderboard.length, 1);
  assert.equal(m.leaderboard, undefined, "no leaderboard for a phone");
  assert.equal(m.reveal.answered, 1, "but the reveal");
  assert.equal(typeof m.reveal.answer, "number");
  big.close();
  phone.close();
  await admin("POST", `/api/host/games/${pin}/end`);
});

test("a change on one instance reaches the screens on another at once", async () => {
  // Instance B hears of changes only when instance A announces them: without
  // an announcement its feeds would look once a minute.
  const b = await startInstance(app.url, { liveTickMs: 60_000, quietLookMs: 60_000 });
  try {
    const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
    const stream = states(await fetch(`${b.base}/api/games/${pin}/live`));
    assert.equal((await stream.next()).players, 0);

    let asked = Date.now();
    await anon("POST", `/api/games/${pin}/players`, { nickname: "Far away" });
    let s = await stream.next(2000);
    assert.equal(s.players, 1);
    assert.ok(Date.now() - asked < 1000, `a join on A reaches B at once (${Date.now() - asked} ms)`);

    asked = Date.now();
    await admin("POST", `/api/host/games/${pin}/next`, { from: { phase: "lobby", index: -1 } });
    s = await stream.next(2000);
    assert.equal(s.phase, "question");
    assert.ok(Date.now() - asked < 500, `a new screen on A reaches B at once (${Date.now() - asked} ms)`);

    // Nobody answers and nothing polls: B's feed closes the question when its clock runs out.
    s = await stream.next(s.question.deadline - Date.now() + 3000);
    assert.equal(s.phase, "reveal");
    stream.close();
    await admin("POST", `/api/host/games/${pin}/end`);
  } finally {
    await b.close();
  }
});

test("an instance that cannot hear announcements still follows the game", async () => {
  const c = await startInstance(app.url, { listen: false });   // a pooled URL only: it looks four times a second
  try {
    const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
    const stream = states(await fetch(`${c.base}/api/games/${pin}/live`));
    assert.equal((await stream.next()).players, 0);
    const asked = Date.now();
    await anon("POST", `/api/games/${pin}/players`, { nickname: "Pooled" });
    assert.equal((await stream.next(2000)).players, 1);
    assert.ok(Date.now() - asked < 1000, `seen within a second (${Date.now() - asked} ms)`);
    stream.close();
    await admin("POST", `/api/host/games/${pin}/end`);
  } finally {
    await c.close();
  }
});

test("an instance whose LISTEN hears nothing finds out, and looks four times a second", async () => {
  // Its LISTEN is on another database, as behind a pooler that swallows notifications:
  // it is accepted, and hears nothing. Believing it would leave this instance a minute behind.
  const listenElsewhere = new URL(app.url);
  listenElsewhere.pathname = "/postgres";
  const d = await startInstance(app.url, { listenUrl: listenElsewhere.toString(), quietLookMs: 60_000 });
  try {
    const pin = (await admin("POST", "/api/host/games", { quizId })).data.pin;
    const stream = states(await fetch(`${d.base}/api/games/${pin}/live`));
    assert.equal((await stream.next()).players, 0);
    await pause(3500);   // past the check that finds the LISTEN deaf
    const asked = Date.now();
    await anon("POST", `/api/games/${pin}/players`, { nickname: "Behind a pooler" });
    assert.equal((await stream.next(2000)).players, 1);
    assert.ok(Date.now() - asked < 1000, `seen within a second (${Date.now() - asked} ms)`);
    stream.close();
    await admin("POST", `/api/host/games/${pin}/end`);
  } finally {
    await d.close();
  }
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
  assert.match(await (await fetch(`${app.base}/no-such-page`)).text(), /This round is a dead end/);
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

test("a whole office behind one address can fill several rooms", async () => {
  // An office, a school or a mobile network shows the server one address for everyone in it.
  const pins = [];
  for (let g = 0; g < 2; g++) pins.push((await admin("POST", "/api/host/games", { quizId })).data.pin);
  let joined = 0;
  for (const pin of pins) {
    for (let i = 0; i < 160; i += 20) {
      const batch = await Promise.all(Array.from({ length: 20 }, (_, k) => anon("POST", `/api/games/${pin}/players`, { nickname: `Desk ${i + k}` })));
      joined += batch.filter(r => r.status === 201).length;
    }
  }
  assert.equal(joined, 320, "more than 300 people from one address all get in");
  for (const pin of pins) await admin("POST", `/api/host/games/${pin}/end`);
  await app.context.pool.query("delete from rate_limits");
});
