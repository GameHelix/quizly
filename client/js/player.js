/* The player's phone. Join with the PIN — the QR code fills it in — pick a
 * nickname and an avatar, then follow the game: the question arrives with
 * the projector, a tap locks in an answer, and the reveal says how it went.
 *
 * Two things are fetched: the game's shared state, about once a second,
 * and this phone's own view, again each time the game moves to a new
 * screen. A refresh or a locked phone loses nothing — the player's id and
 * token wait in localStorage.
 */

import { AVATARS, LETTERS, NICKNAME_MAX } from "/shared/quiz.js";
import { buzz, confetti, countUp } from "./fx.js";
import { brand, footer, icon, missionPanel, progressRail, siteHeader, trophyArt } from "./design.js";
import { moveHtml, tier } from "./leaderboard.js";
import { clock, getState, live } from "./live.js";
import { cardResult, sharePanel, wireShare } from "./share.js";
import { $, announce, api, askDialog, escapeHtml, fmt, keepAwake, ordinal, plural, toast } from "./ui.js";

const app = $("app");
const SESSION_KEY = "quizly:player";
const LAST_KEY = "quizly:last";
const ANSWER_GRACE_MS = 1500;           // server/play.js still takes an answer this long after the clock runs out

let session = readStore(SESSION_KEY);   // { pin, playerId, token, nickname, avatar }
let game = null;                        // the shared state
let me = null;                          // this phone's own view of the current screen
let screenKey = "";                     // the screen `me` was fetched for
let drawn = "";                         // what is on screen now, so a poll redraws only on change
let pending = null;                     // a choice tapped on this screen
let sending = false;                    // …and still on its way to the server
let picked = null;                      // { index, choice, sure }: this phone's answer, carried into the reveal
let lastScore = 0;
let effects = new Set();                // celebrations already played on this screen
let poller = null;
let ticker = null;
const shown = new WeakMap();            // element → the html last put in it

let linkPin = (new URLSearchParams(location.search).get("pin") || "").replace(/\D/g, "").slice(0, 6);
if (session && linkPin && linkPin !== session.pin) {
  // A new QR code wins over an old game.
  clearSession();
}
if (session) follow();
else renderJoin();

/* ---------- joining ---------- */

function renderJoin(message = "") {
  stop();
  document.title = "Quizly — join the game";
  drawn = "";
  document.body.dataset.mood = "";
  const last = readStore(LAST_KEY) || {};
  let avatar = AVATARS.includes(last.avatar) ? last.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const fixedPin = /^\d{6}$/.test(linkPin) ? linkPin : "";

  app.innerHTML = `
    ${siteHeader("play")}
    <div class="home-layout${fixedPin ? " quick-join" : ""}">
      <section class="home-intro"><span class="intro-tag">${icon("spark")} Made for your kind of people</span>
        <h1>Big brains.<br><span>Bigger energy.</span></h1>
        <p class="sub">A room full of friends. A little friendly rivalry.<br>One more reason to bring your A-game.</p>
        <div class="hero-art">${trophyArt()}<span class="art-sticker one">${icon("users")} Better together</span><span class="art-sticker two">${icon("bolt")} Keep that streak going!</span></div>
      </section>
      <section class="join-panel" aria-labelledby="join-title">
      <div class="panel-head"><span class="panel-icon">${icon("play")}</span><span class="live-label">LIVE QUIZ. REAL PEOPLE.</span></div>
      <h2 id="join-title">You're one PIN away.</h2><p class="sub">Your next “I knew that!” moment starts here.</p>
    <form class="stack" id="join" autocomplete="off" novalidate>
      <div class="pinline${fixedPin ? "" : " hidden"}" id="pin-fixed">
        <span class="sub">Game PIN</span><b>${fixedPin.slice(0, 3)} ${fixedPin.slice(3)}</b>
        <button type="button" class="quiet" id="pin-change" style="padding:6px 12px;font-size:13px">Change</button>
      </div>
      <div class="field${fixedPin ? " hidden" : ""}" id="pin-field">
        <label for="pin">Game PIN</label>
        <input id="pin" inputmode="numeric" maxlength="7" placeholder="123 456" value="${fixedPin}" aria-describedby="pin-hint join-err" ${fixedPin ? "" : "autofocus"}>
        <span class="note" id="pin-hint" style="font-size:10px;display:block;margin-top:7px">Look for the six-digit code on the big screen.</span>
      </div>
      <div class="field">
        <label for="nick">Your nickname</label>
        <input id="nick" maxlength="${NICKNAME_MAX}" autocapitalize="words" autocomplete="nickname"
               enterkeyhint="go" placeholder="What should we call you?" value="${escapeHtml(last.nickname || "")}">
      </div>
      <div class="field">
        <div class="field-title"><label id="avatar-label">Pick your game face</label><span>Make it you.</span></div>
        <div class="avatars" id="avatars" role="group" aria-labelledby="avatar-label">
          ${AVATARS.map(a => `<button type="button" class="av${a === avatar ? " on" : ""}" data-av="${a}" aria-label="Choose ${a} avatar" aria-pressed="${a === avatar}">${a}</button>`).join("")}
        </div>
      </div>
      <button type="submit" class="big" id="join-btn">Let's play ${icon("arrow")}</button>
      <p class="err" id="join-err" role="alert">${escapeHtml(message)}</p>
    </form><p class="join-footnote">${icon("check")} No account. No download. Just good fun.</p></section></div>
    <section class="how-strip" aria-label="How it works">
      <div class="how-item"><span class="how-number">01</span><div><b>Get in the room</b><p>Enter the PIN, pick your name, find your people.</p></div></div>
      <div class="how-item"><span class="how-number">02</span><div><b>Think fast. Tap faster.</b><p>Answer live questions. Every right answer counts.</p></div></div>
      <div class="how-item"><span class="how-number">03</span><div><b>Make your way to the top</b><p>Build a streak. Climb the board. Own your moment.</p></div></div>
    </section>
    <aside class="reward-strip">${icon("trophy")}<p><b>A little competition goes a long way.</b> Earn points, chase streaks, and celebrate the wins.</p><div class="reward-tags"><span>${icon("bolt")} Speed bonuses</span><span>${icon("spark")} Answer streaks</span><span>${icon("trophy")} Game awards</span></div></aside>${footer()}`;

  if (fixedPin) $("nick").focus();
  $("pin-change").onclick = () => {
    $("pin-fixed").classList.add("hidden");
    $("pin-field").classList.remove("hidden");
    $("pin").select();
  };
  $("avatars").onclick = e => {
    const b = e.target.closest("[data-av]");
    if (!b) return;
    avatar = b.dataset.av;
    for (const x of $("avatars").children) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", x === b);
    }
  };
  $("join").onsubmit = async e => {
    e.preventDefault();
    const err = $("join-err");
    const pin = $("pin").value.replace(/\D/g, "");
    const nickname = $("nick").value.trim();
    if (pin.length !== 6) { err.textContent = "The PIN has six digits — it is on the big screen."; $("pin").setAttribute("aria-invalid", "true"); $("pin").focus(); return; }
    if (!nickname) { err.textContent = "Pick a nickname first."; $("nick").setAttribute("aria-invalid", "true"); $("nick").focus(); return; }
    $("pin").removeAttribute("aria-invalid");
    $("nick").removeAttribute("aria-invalid");
    $("join-btn").disabled = true;
    $("join-btn").textContent = "Joining your game…";
    err.textContent = "";
    try {
      const joined = await api(`/api/games/${pin}/players`, { method: "POST", body: { nickname, avatar } });
      session = { pin, playerId: joined.playerId, token: joined.token, nickname: joined.nickname, avatar: joined.avatar };
      writeStore(SESSION_KEY, session);
      writeStore(LAST_KEY, { nickname: joined.nickname, avatar: joined.avatar });
      history.replaceState(null, "", "/");   // a refresh now resumes instead of re-joining
      linkPin = "";
      keepAwake();
      follow();
    } catch (ex) {
      err.textContent = ex.message;
      $("join-btn").disabled = false;
      $("join-btn").innerHTML = `Let's play ${icon("arrow")}`;
    }
  };
}

/* ---------- following the game ---------- */

function follow() {
  stop();
  keepAwake();
  render();
  poller = live(`/api/games/${session.pin}`, state => {
    game = state;
    const key = `${game.status}:${game.phase}:${game.index}`;
    if (key !== screenKey) {
      screenKey = key;
      me = null;
      pending = null;
      sending = false;
      effects = new Set();
      loadMe(key);
    }
    render();
  }, {
    query: "phone=1",   // the shared state without the roster and the leaderboard, which a phone does not show
    onError: err => {
      if (err.status === 404) ended("This game has ended.");
    }
  });
}

async function loadMe(key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const view = await getState(`/api/games/${session.pin}/players/${session.playerId}`, { token: session.token });
      if (key !== screenKey) return;   // the game moved on while this was on its way
      if (view.kicked) return removed();
      me = view;
      if (view.me) lastScore = view.me.score;
      if (view.phase === "question" && pending == null) picked = { index: view.index, choice: view.choice, sure: true };
      render();
      if (game?.phase === "final" && me?.final) poller?.stop();   // nothing more will change
      return;
    } catch (err) {
      if (err.status === 401) return lost();
      if (err.status === 404) return ended("This game has ended.");
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

function render() {
  if (!game) return draw("connecting", () => `<p class="eyebrow">Quizly</p><h1 class="waiting-dots">Connecting</h1>`);
  if (game.status === "abandoned") return ended("The host closed this game.");
  // The private view is fresher than the shared one, which a CDN may hold
  // for a second; use it only once both describe the same screen.
  const mine = me && me.phase === game.phase && me.index === game.index ? me : null;
  switch (game.phase) {
    case "lobby": return renderLobby();
    case "question": return renderQuestion(mine);
    case "reveal": return renderReveal(mine);
    case "leaderboard": return renderStanding(mine);
    case "final": return renderFinal(mine);
  }
}

/* Draws html() unless the same fingerprint is already on screen. mood tints
 * the whole page: "good" or "calm" at a reveal, nothing otherwise. */
function draw(fingerprint, html, after, mood = "") {
  if (fingerprint !== drawn) {
    const newPhase = fingerprint.split(":")[0] !== drawn.split(":")[0];
    drawn = fingerprint;
    clearInterval(ticker);
    document.body.dataset.mood = mood;
    const title = { lobby: "You're in the lobby", question: `Question ${(game?.index || 0) + 1}`, reveal: "Your answer result", leaderboard: "Your standing", final: "Your final results" }[game?.phase] || "Connecting to your game";
    document.title = `${title} · Quizly`;
    app.innerHTML = `<div class="player-shell"><header class="player-top">${brand()}<div class="bar"><span class="pill">PIN ${session?.pin || ""}</span><button class="text-btn" data-leave>Leave</button></div></header><div class="player-content"><h1 class="sr-only">${title}</h1>${html()}</div></div>`;
    if (newPhase) {
      // "instant" overrides the page's smooth scrolling; an older browser that
      // rejects the option must not stop the screen from being wired up below
      try {
        window.scrollTo({ top: 0, behavior: "instant" });
      } catch {
        window.scrollTo(0, 0);
      }
      announce(title);
    }
    after?.();
  }
}

/* The question count, the run so far as a trail of dots, the streak and the score. */
function header(score, mine) {
  const streak = mine?.me?.streak >= 2 ? `<span class="pill fire">🔥 ${mine.me.streak}</span>` : "";
  const dots = (mine?.history ?? []).map(h => `<i class="${h === true ? "ok" : h === false ? "no" : ""}"></i>`).join("") +
    (game.phase === "question" ? `<i class="now"></i>` : "");
  return `
    <div class="game-head"><div class="row">
      <span class="bar"><span class="pill">${game.index + 1} / ${game.total}</span><span class="trail" aria-hidden="true">${dots}</span></span>
      <span class="bar">${streak}<span class="pill on">${fmt(score)} pts</span></span>
    </div>${progressRail(game.index, game.total, game.phase)}</div>`;
}

function renderLobby() {
  draw("lobby", () => `
    <div class="hero">
      <div class="face">${escapeHtml(session.avatar)}</div>
      <p class="eyebrow">${escapeHtml(game.title)}</p>
      <h1>You're in, ${escapeHtml(session.nickname)}!</h1>
      <p class="sub">Your game face is on. Your competition is joining.</p>
      <div class="waiting-room"><span class="live-label">YOU'RE IN THE LOBBY</span><p>The host will start when everyone's ready.</p><p class="note" id="lobby-count" role="status"></p></div>
      ${missionPanel()}<button class="text-btn" data-help style="margin-top:18px">How do points work? ${icon("arrow")}</button>
    </div>`);
  $("lobby-count").textContent = `${plural(game.players, "player")} in so far`;
}

/* The question is drawn once and then only updated in place: a screen
 * redrawn under a finger swallows the tap, and options that move as the
 * countdown ends take it to the wrong answer. */
function renderQuestion(mine) {
  const q = game.question;
  const size = q.prompt.length > 200 ? "q-l" : q.prompt.length > 110 ? "q-m" : "";
  const compact = Math.max(...q.options.map(o => o.length)) > 70 ? " compact" : "";
  draw(`q:${game.index}`, () => `
    <div id="head"></div>
    <h2 class="${size}" style="margin-top:18px">${escapeHtml(q.prompt)}</h2>
    <div class="timer" id="timer" role="timer" aria-label="Question time remaining"><span id="bar"></span></div>
    <div class="timer-meta"><span id="hint"></span><span id="left">&nbsp;</span></div>
    <div class="opts${compact}" id="opts">
      ${q.options.map((o, i) => `
        <button class="opt c${i}" data-i="${i}" aria-pressed="false" disabled>
          <span class="k">${LETTERS[i]}</span><span>${escapeHtml(o)}</span>
        </button>`).join("")}
      <div class="countdown" id="countdown" aria-hidden="true"></div>
    </div>
    <p class="status" id="status" role="status"></p>
    <p class="tally" id="tally"></p>
    <div id="mission"></div>`,
  () => {
    app.querySelectorAll("button.opt").forEach(b => { b.onclick = () => choose(Number(b.dataset.i)); });
    ticker = setInterval(tickQuestion, 100);
  });
  const choice = mine?.choice ?? pending;
  swap("head", header(lastScore, mine));
  swap("mission", missionPanel(mine?.me?.streak || 0));
  $("opts").classList.toggle("locked", choice != null);
  for (const b of app.querySelectorAll("button.opt")) {
    const on = Number(b.dataset.i) === choice;
    b.classList.toggle("picked", on);
    b.classList.toggle("sending", on && sending);
    b.setAttribute("aria-pressed", String(on));
  }
  tickQuestion();
}

function tickQuestion() {
  const q = game?.question;
  if (game?.phase !== "question" || !q) return clearInterval(ticker);
  const now = clock.now();
  const choice = me?.choice ?? pending;
  const locked = choice != null;
  const opensIn = q.opensAt - now;
  const remaining = q.deadline - now;
  const open = opensIn <= 0 && remaining > 0 && !locked;
  app.querySelectorAll("button.opt").forEach(b => { b.disabled = !open; });
  const countdown = $("countdown");
  if (opensIn > 0) {
    // 3, 2, 1 in big type over the waiting options, then "Go!"
    const n = String(Math.ceil(opensIn / 1000));
    if (countdown.textContent !== n) {
      countdown.textContent = n;
      replay(countdown, "go");
    }
  } else if (/^\d$/.test(countdown.textContent)) {
    countdown.textContent = "Go!";
    replay(countdown, "go");
    buzz(25);
    setTimeout(() => countdown.classList.add("done"), 600);
  }
  const secs = Math.ceil(remaining / 1000);
  setText($("hint"), locked ? "✓ Locked in" : opensIn > 0 ? "Get ready…" : remaining > 0 ? "Tap once to answer" : "Time's up!");
  $("hint").classList.toggle("locked", locked);
  // A calm clock: no red, no buzz in the last seconds — this is a quiz over lunch.
  setText($("left"), open ? `${secs}s` : "");
  $("bar").style.width = opensIn > 0 ? "100%" : `${Math.max(0, (remaining / q.limitMs) * 100).toFixed(1)}%`;
  setText($("status"), locked ? (sending ? "Sending your answer…" : `Answer ${LETTERS[choice]} is locked in.`)
    : remaining <= 0 ? "Time's up! The answer is coming…" : "");
  setText($("tally"), locked ? `${fmt(game.answered)} of ${plural(game.players, "player")} answered` : "");
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

async function choose(i) {
  const q = game.question;
  const index = game.index;
  const now = clock.now();
  if (pending != null || me?.choice != null || now < q.opensAt) return;
  pending = i;
  sending = true;
  picked = { index, choice: i, sure: false };
  buzz(20);
  render();
  try {
    await sendAnswer({ playerId: session.playerId, index, choice: i, elapsedMs: Math.round(now - q.opensAt) }, q.deadline);
    if (picked?.index === index) picked.sure = true;
  } catch (err) {
    if (picked?.index === index) picked = null;   // unknown until the reveal says
    if (err.code === "kicked") return removed();
    if (err.code === "not_in_game") return lost();
    if (err.code !== "already_answered" && game?.index === index && game.phase === "question") {
      pending = null;
      toast(err.message);
    }
  }
  if (game?.index === index) sending = false;
  render();
}

/* A tap lost on the way — the server restarting, the venue's Wi-Fi blinking —
 * is sent again until it gets through or the question has closed. The server
 * takes one answer per question and refuses a second copy as already
 * answered, so trying again can never count a tap twice. */
async function sendAnswer(body, deadline) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(`/api/games/${session.pin}/answers`, { method: "POST", token: session.token, body });
    } catch (err) {
      if (attempt > 0 && err.code === "already_answered") return;   // an earlier copy got through
      const lost = err.status === 0 || err.status >= 500;
      if (!lost || clock.now() > deadline + ANSWER_GRACE_MS) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, 300 * 2 ** attempt)));
    }
  }
}

/* The verdict needs only this phone's own answer and the right one, so it
 * shows with the reveal; the points, streak and rank follow when this
 * phone's own view arrives. */
function renderReveal(mine) {
  const q = game.question;
  const r = game.reveal;
  const res = mine?.result;
  const choice = res ? res.choice : picked?.index === game.index && picked.sure ? picked.choice : undefined;
  const known = choice !== undefined;
  const correct = known && choice === r.answer;
  draw(`r:${game.index}:${known ? choice : "?"}`, () => {
    // A miss is part of learning: calm colours, a kind word, and how the room did.
    let verdict = `<div class="verdict"><h3 class="waiting-dots">Checking</h3></div>`;
    if (choice === null) {
      verdict = `<div class="verdict calm"><h3>Time's up</h3><p class="sub" style="margin:0">No problem: the right answer is marked below.</p>${roomLine(r, false)}</div>`;
    } else if (correct) {
      verdict = `
        <div class="verdict good">
          <h3>Correct!</h3>
          <div class="burst">+<span id="burst">…</span></div>
          <p class="breakdown" id="breakdown"></p>
          ${roomLine(r, true)}
          ${r.fastest?.playerId === session.playerId ? `<span class="streak-msg">⚡ Fastest in the room!</span>` : ""}
          <span id="streak-msg"></span>
        </div>`;
    } else if (known) {
      verdict = `<div class="verdict calm"><h3>Good try!</h3><p class="sub" style="margin:0">Now you know: the right answer is marked below.</p>${roomLine(r, false)}</div>`;
    }
    return `
      <div id="head"></div>
      ${verdict}
      <div class="opts reveal">
        ${q.options.map((o, i) => `
          <button class="opt c${i}${i === r.answer ? " right" : i === choice ? " wrong" : ""}" disabled>
            <span class="k">${LETTERS[i]}</span><span>${escapeHtml(o)}${i === r.answer ? '<small class="result-heading">Correct answer</small>' : i === choice ? '<small class="result-heading">Your answer</small>' : ""}</span>
          </button>`).join("")}
      </div>
      ${r.explanation ? `<div class="card learning-note"><span class="eyebrow">A little more to know</span><p style="margin:0">${escapeHtml(r.explanation)}</p></div>` : ""}
      <div id="mission"></div>
      <p class="status" id="standing"></p>`;
  }, null, known ? (correct ? "good" : "calm") : "");

  const streak = mine?.me?.streak ?? 0;
  const s = mine?.standing;
  swap("head", header(mine?.me?.score ?? lastScore, mine));
  swap("mission", missionPanel(streak));
  swap("standing", !s ? "" : tier(s) === "top" ? `You're ${ordinal(s.rank)} of ${s.of} ${moveHtml(Math.max(0, s.move))}`
    : tier(s) === "half" ? `You're in the top half ${moveHtml(Math.max(0, s.move))}` : "");
  if (known && once("verdict")) {
    announce(correct ? "Correct!" : choice === null ? "Time's up. The right answer is marked below." : "Good try. The right answer is marked below.");
    if (correct) buzz([50]);
  }
  const burst = $("burst");
  if (correct && res && burst && !shown.has(burst)) {
    shown.set(burst, true);
    // where the points came from, so speed and streaks visibly pay
    const speed = res.points - res.base - res.bonus;
    if (res.base != null) {
      swap("breakdown", [`+${fmt(res.base)} correct`, speed > 0 && `+${fmt(speed)} speed`,
        res.bonus > 0 && `+${fmt(res.bonus)} streak`, res.ms != null && `in ${(res.ms / 1000).toFixed(1)} s`]
        .filter(Boolean).map(t => `<span>${t}</span>`).join(""));
    }
    if (streak >= 2) swap("streak-msg", `<span class="streak-msg">🔥 ${streak} in a row!</span>`);
    if (once("points")) {
      countUp(burst, 0, res.points, 900);
      announce(`You earned ${fmt(res.points)} points.`);
      if (streak >= 3) confetti(1500, 80);
    } else {
      burst.textContent = fmt(res.points);
    }
  }
}

/* How the room did on this question, so a miss feels normal and a hit feels shared. */
function roomLine(r, correct) {
  if (!r.answered) return "";
  const pct = Math.round((r.correct / r.answered) * 100);
  const text = correct
    ? pct === 100 ? "Everyone got it right! 🙌" : pct < 50 ? `Only ${pct}% got it right. Well done!` : `${pct}% got it right, you too!`
    : pct === 0 ? "Nobody got this one. Tricky!" : pct < 50 ? `Only ${pct}% got it right. A tricky one!` : `${pct}% got it right. Now you know too!`;
  return `<p class="room">${text}</p>`;
}

/* Puts html into the element with this id, unless it is already there. */
function swap(id, html) {
  const el = $(id);
  if (el && shown.get(el) !== html) {
    el.innerHTML = html;
    shown.set(el, html);
  }
}

/* True the first time it is asked about tag on the current screen. */
function once(tag) {
  if (effects.has(tag)) return false;
  effects.add(tag);
  return true;
}

/* Restarts a CSS animation on el. */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function renderStanding(mine) {
  const s = mine?.standing;
  draw(`lb:${game.index}:${s ? 1 : 0}`, () => `
    <div class="hero">
      <div class="face">${escapeHtml(session.avatar)}</div>
      <p class="eyebrow">After question ${game.index + 1} of ${game.total}</p>
      ${s ? `
        ${placeHtml(s, "Keep going!")}
        <p class="sub">${tier(s) === "top" ? `of ${s.of} · ` : ""}${fmt(mine.me.score)} points ${moveHtml(Math.max(0, s.move))}</p>
        <p>${!s.ahead ? "You're in the lead! 🏆"
          : s.ahead.gap > 0 ? `${plural(s.ahead.gap, "point")} behind ${who(s.ahead)}`
          : `Level with ${who(s.ahead)}: speed decides`}</p>
        ${s.behind ? `<p class="sub">${who(s.behind)} is ${s.behind.gap > 0 ? `${plural(s.behind.gap, "point")} behind you` : "level with you"}</p>` : ""}
        ${mine.me.streak >= 2 ? `<p><span class="pill fire">🔥 ${mine.me.streak} right in a row</span></p>` : ""}`
      : `<h1 class="waiting-dots">Counting</h1>`}
      <p class="note">Next question coming up — eyes on the big screen.</p>
      ${progressRail(game.index, game.total, game.phase)}${missionPanel(mine?.me?.streak || 0)}
    </div>`);
}

function who(p) {
  return `${escapeHtml(p.avatar)} ${escapeHtml(p.nickname)}`;
}

/* The big line for where a player stands: an exact place in the top few,
 * "Top half" below that, and further down just a kind word. */
function placeHtml(s, kind) {
  const t = tier(s);
  return t === "top" ? `<div class="rank">${ordinal(s.rank)}</div>`
    : `<div class="rank tier">${t === "half" ? "Top half" : kind}</div>`;
}

function renderFinal(mine) {
  const f = mine?.final;
  const card = f ? cardResult(mine, game.title) : null;
  draw(`final:${f ? 1 : 0}`, () => {
    if (!f) return `<div class="hero"><h1 class="waiting-dots">Adding it up</h1></div>`;
    const s = mine.standing;
    return `
      <div class="hero">
        <div class="face">${escapeHtml(session.avatar)}</div>
        <p class="eyebrow">${escapeHtml(game.title)} · final</p>
        <span class="result-heading">${s.rank === 1 ? "You took the crown!" : s.rank <= 3 ? "A podium finish. Nicely played!" : "That's a wrap. Nicely played!"}</span>${placeHtml(s, "Well played!")}
        <p class="sub">${tier(s) === "top" ? `of ${s.of} · ` : ""}${fmt(mine.me.score)} points</p>
        <div class="stats">
          <div class="stat"><b>${f.played ? Math.round((f.correct / f.played) * 100) : 0}%</b><span>${f.correct} of ${f.played} right</span></div>
          <div class="stat"><b>🔥 ${f.bestStreak}</b><span>best streak</span></div>
          <div class="stat"><b>${f.avgCorrectMs == null ? "—" : (f.avgCorrectMs / 1000).toFixed(1) + "s"}</b><span>per right answer</span></div>
        </div>
        ${f.badges.length ? `<div class="badges">${f.badges.map(b => `
          <div class="badge"><span class="e">${escapeHtml(b.emoji)}</span><b>${escapeHtml(b.title)}</b>${b.detail ? `<small>${escapeHtml(b.detail)}</small>` : ""}</div>`).join("")}</div>` : ""}
        ${sharePanel(card)}
        <div class="card" style="text-align:left;margin-top:18px">
          <h3>Podium</h3>
          ${f.podium.map(p => `<p style="margin:6px 0">${["🥇", "🥈", "🥉"][p.rank - 1]} ${escapeHtml(p.avatar)} ${escapeHtml(p.nickname)} <span class="sub">· ${fmt(p.score)}</span></p>`).join("")}
        </div>
        <button class="big" id="again" style="margin-top:20px">Join another game</button>
      </div>`;
  }, () => {
    $("again")?.addEventListener("click", leave);
    if (card) wireShare(card);
    if (f && once("final")) {
      if (mine.standing.rank <= 3) confetti();
      buzz([60, 40, 60, 40, 140]);
    }
  });
}

/* ---------- leaving ---------- */

function ended(message) {
  stop();
  clearSession();
  showMessage("Game over", message);
}

function removed() {
  stop();
  clearSession();
  showMessage("You were removed", "The host took you out of this game. You can join a different game with a new PIN.");
}

function lost() {
  stop();
  clearSession();
  renderJoin("We lost track of you. Join again.");
}

function leave() {
  stop();
  clearSession();
  history.replaceState(null, "", "/");
  renderJoin();
}

function showMessage(title, text) {
  drawn = "";
  document.body.dataset.mood = "";
  app.innerHTML = `
    ${siteHeader("play")}<div class="wrap narrow"><div class="empty-state">
    <span class="panel-icon" style="margin:0 auto 20px">${icon("flag")}</span>
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${escapeHtml(text)}</p>
    <button class="big" id="again" style="margin-top:24px">Find your next game ${icon("arrow")}</button></div></div>${footer()}`;
  $("again").onclick = () => {
    history.replaceState(null, "", "/");
    renderJoin();
  };
}

function stop() {
  poller?.stop();
  poller = null;
  clearInterval(ticker);
}

function clearSession() {
  session = null;
  game = null;
  me = null;
  screenKey = "";
  pending = null;
  sending = false;
  picked = null;
  lastScore = 0;
  effects = new Set();
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing stored
  }
}

function readStore(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode: the game still works, a refresh just means joining again
  }
}

document.addEventListener("keydown", e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select, button, a, dialog")) return;
  if (document.querySelector("dialog[open]")) return;
  const index = /^[1-6]$/.test(e.key) ? Number(e.key) - 1 : LETTERS.indexOf(e.key.toUpperCase());
  const button = app.querySelector(`button.opt[data-i="${index}"]`);
  if (index >= 0 && button && !button.disabled) { e.preventDefault(); button.click(); }
});

document.addEventListener("click", async e => {
  if (!e.target.closest("[data-leave]")) return;
  if (await askDialog({ title: "Leave this game?", message: "Returning with a new nickname starts a new player. Your current score stays on the board.", confirmLabel: "Leave game" })) leave();
});
