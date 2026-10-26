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
import { moveHtml } from "./leaderboard.js";
import { clock, getState, poll } from "./live.js";
import { $, api, escapeHtml, fmt, keepAwake, ordinal, plural, toast } from "./ui.js";

const app = $("app");
const SESSION_KEY = "quizly:player";
const LAST_KEY = "quizly:last";

let session = readStore(SESSION_KEY);   // { pin, playerId, token, nickname, avatar }
let game = null;                        // the shared state
let me = null;                          // this phone's own view of the current screen
let screenKey = "";                     // the screen `me` was fetched for
let drawn = "";                         // what is on screen now, so a poll redraws only on change
let pending = null;                     // a choice sent and not yet confirmed
let lastScore = 0;
let celebrated = "";
let poller = null;
let ticker = null;

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
  drawn = "";
  document.body.dataset.mood = "";
  const last = readStore(LAST_KEY) || {};
  let avatar = AVATARS.includes(last.avatar) ? last.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const fixedPin = /^\d{6}$/.test(linkPin) ? linkPin : "";

  app.innerHTML = `
    <p class="eyebrow">Quizly</p>
    <h1>Join the game</h1>
    <form class="card stack" id="join" autocomplete="off" novalidate>
      <div class="pinline${fixedPin ? "" : " hidden"}" id="pin-fixed">
        <span class="sub">Game PIN</span><b>${fixedPin.slice(0, 3)} ${fixedPin.slice(3)}</b>
        <button type="button" class="quiet" id="pin-change" style="padding:6px 12px;font-size:13px">Change</button>
      </div>
      <div class="field${fixedPin ? " hidden" : ""}" id="pin-field">
        <label for="pin">Game PIN</label>
        <input id="pin" inputmode="numeric" maxlength="7" placeholder="123 456" value="${fixedPin}" ${fixedPin ? "" : "autofocus"}>
      </div>
      <div class="field">
        <label for="nick">Your nickname</label>
        <input id="nick" maxlength="${NICKNAME_MAX}" autocapitalize="words" autocomplete="nickname"
               enterkeyhint="go" placeholder="What should we call you?" value="${escapeHtml(last.nickname || "")}">
      </div>
      <div class="field">
        <label>Your avatar</label>
        <div class="avatars" id="avatars">
          ${AVATARS.map(a => `<button type="button" class="av${a === avatar ? " on" : ""}" data-av="${a}" aria-pressed="${a === avatar}">${a}</button>`).join("")}
        </div>
      </div>
      <button type="submit" class="big" id="join-btn">Join</button>
      <p class="err" id="join-err" role="alert">${escapeHtml(message)}</p>
    </form>`;

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
    if (pin.length !== 6) return void (err.textContent = "The PIN has six digits — it is on the big screen.");
    if (!nickname) return void (err.textContent = "Pick a nickname first.");
    $("join-btn").disabled = true;
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
    }
  };
}

/* ---------- following the game ---------- */

function follow() {
  stop();
  keepAwake();
  render();
  poller = poll(async () => {
    game = await getState(`/api/games/${session.pin}`);
    const key = `${game.status}:${game.phase}:${game.index}`;
    if (key !== screenKey) {
      screenKey = key;
      me = null;
      pending = null;
      loadMe(key);
    }
    render();
  }, 1000, {
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
 * the whole page: "good" or "bad" at a reveal, nothing otherwise. */
function draw(fingerprint, html, after, mood = "") {
  if (fingerprint !== drawn) {
    drawn = fingerprint;
    clearInterval(ticker);
    document.body.dataset.mood = mood;
    app.innerHTML = html();
    after?.();
  }
}

/* The question count, the run so far as a trail of dots, the streak and the score. */
function header(score, mine) {
  const streak = mine?.me?.streak >= 2 ? `<span class="pill fire">🔥 ${mine.me.streak}</span>` : "";
  const dots = (mine?.history ?? []).map(h => `<i class="${h === true ? "ok" : h === false ? "no" : ""}"></i>`).join("") +
    (game.phase === "question" ? `<i class="now"></i>` : "");
  return `
    <div class="row">
      <span class="bar"><span class="pill">${game.index + 1} / ${game.total}</span><span class="trail" aria-hidden="true">${dots}</span></span>
      <span class="bar">${streak}<span class="pill on">${fmt(score)} pts</span></span>
    </div>`;
}

function renderLobby() {
  draw("lobby", () => `
    <div class="hero">
      <div class="face">${escapeHtml(session.avatar)}</div>
      <p class="eyebrow">${escapeHtml(game.title)}</p>
      <h1>You're in, ${escapeHtml(session.nickname)}!</h1>
      <p class="sub">Find your name on the big screen. The game starts when the host is ready.</p>
      <p class="note" id="lobby-count"></p>
    </div>`);
  $("lobby-count").textContent = `${plural(game.players, "player")} in so far`;
}

function renderQuestion(mine) {
  const q = game.question;
  const choice = mine?.choice ?? pending;
  const size = q.prompt.length > 200 ? "q-l" : q.prompt.length > 110 ? "q-m" : "";
  const compact = Math.max(...q.options.map(o => o.length)) > 70 ? " compact" : "";
  draw(`q:${game.index}:${choice}:${mine ? 1 : 0}`, () => `
    ${header(lastScore, mine)}
    <h2 class="${size}" style="margin-top:18px">${escapeHtml(q.prompt)}</h2>
    <div class="timer" id="timer"><span id="bar"></span></div>
    <p class="note" id="left">&nbsp;</p>
    <div class="ready" id="ready" aria-live="polite"></div>
    <div class="opts${compact}">
      ${q.options.map((o, i) => `
        <button class="opt c${i}${choice === i ? " picked" : ""}" data-i="${i}" disabled>
          <span class="k">${LETTERS[i]}</span><span>${escapeHtml(o)}</span>
        </button>`).join("")}
    </div>
    <p class="status" id="status">${choice != null ? "Locked in. Waiting for the others…" : ""}</p>`,
  () => {
    app.querySelectorAll("button.opt").forEach(b => { b.onclick = () => choose(Number(b.dataset.i)); });
    ticker = setInterval(tickQuestion, 100);
    tickQuestion();
  });
}

function tickQuestion() {
  const q = game?.question;
  if (game?.phase !== "question" || !q) return clearInterval(ticker);
  const now = clock.now();
  const locked = (me?.choice ?? pending) != null;
  const opensIn = q.opensAt - now;
  const remaining = q.deadline - now;
  const open = opensIn <= 0 && remaining > 0 && !locked;
  app.querySelectorAll("button.opt").forEach(b => { b.disabled = !open; });
  const bar = $("bar");
  const left = $("left");
  const ready = $("ready");
  if (opensIn > 0) {
    // 3, 2, 1 in big type while the options wait, then "Go!"
    const n = String(Math.ceil(opensIn / 1000));
    if (ready.textContent !== n) {
      ready.textContent = n;
      replay(ready, "go");
    }
  } else if (/^\d$/.test(ready.textContent)) {
    ready.textContent = "Go!";
    replay(ready, "go");
    buzz(25);
    setTimeout(() => { if (ready.isConnected) ready.textContent = ""; }, 700);
  }
  if (opensIn > 0) {
    bar.style.width = "100%";
    left.textContent = "Get ready";
  } else if (remaining > 0) {
    bar.style.width = `${((remaining / q.limitMs) * 100).toFixed(1)}%`;
    $("timer").classList.toggle("low", remaining < 5000);
    left.textContent = locked ? "" : `${Math.ceil(remaining / 1000)}s left`;
  } else {
    bar.style.width = "0%";
    left.textContent = "";
    if (!locked) $("status").textContent = "Time's up! The answer is coming…";
  }
}

async function choose(i) {
  const q = game.question;
  const now = clock.now();
  if (pending != null || me?.choice != null || now < q.opensAt) return;
  pending = i;
  buzz(20);
  render();
  try {
    await api(`/api/games/${session.pin}/answers`, {
      method: "POST",
      token: session.token,
      body: { playerId: session.playerId, index: game.index, choice: i, elapsedMs: Math.round(now - q.opensAt) }
    });
  } catch (err) {
    if (err.code === "already_answered") return;
    if (err.code === "kicked") return removed();
    if (err.code === "not_in_game") return lost();
    pending = null;
    toast(err.message);
    render();
  }
}

function renderReveal(mine) {
  const q = game.question;
  const r = game.reveal;
  const res = mine?.result;
  const streak = mine?.me?.streak ?? 0;
  draw(`r:${game.index}:${res ? 1 : 0}`, () => {
    let verdict = `<div class="verdict"><h3 class="waiting-dots">Checking</h3></div>`;
    if (res && res.choice === null) {
      verdict = `<div class="verdict bad"><h3>Time's up</h3><p class="sub" style="margin:0">No answer this time.</p></div>`;
    } else if (res?.correct) {
      verdict = `
        <div class="verdict good">
          <h3>Correct!</h3>
          <div class="burst">+<span id="burst">${fmt(res.points)}</span></div>
          ${res.bonus ? `<p class="sub" style="margin:4px 0 0">including a streak bonus of +${fmt(res.bonus)}</p>` : ""}
          ${streak >= 2 ? `<span class="streak-msg">🔥 ${streak} in a row!</span>` : ""}
        </div>`;
    } else if (res) {
      verdict = `<div class="verdict bad"><h3>Not this time</h3><p class="sub" style="margin:0">The right answer is marked below.</p></div>`;
    }
    return `
      ${header(mine?.me?.score ?? lastScore, mine)}
      ${verdict}
      <div class="opts">
        ${q.options.map((o, i) => `
          <button class="opt c${i}${i === r.answer ? " right" : i === res?.choice ? " wrong" : ""}" disabled>
            <span class="k">${LETTERS[i]}</span><span>${escapeHtml(o)}</span>
          </button>`).join("")}
      </div>
      ${r.explanation ? `<div class="card" style="margin-top:16px"><p style="margin:0">${escapeHtml(r.explanation)}</p></div>` : ""}
      ${mine?.standing ? `<p class="status">You're ${ordinal(mine.standing.rank)} of ${mine.standing.of} ${moveHtml(mine.standing.move)}</p>` : ""}`;
  }, () => {
    if (res && celebrated !== screenKey) {
      celebrated = screenKey;
      buzz(res.correct ? [50] : [90, 60, 90]);
      if (res.correct) {
        countUp($("burst"), 0, res.points, 900);
        if (streak >= 3) confetti(1500, 80);
      }
    }
  }, res ? (res.correct ? "good" : "bad") : "");
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
        <div class="rank">${ordinal(s.rank)}</div>
        <p class="sub">of ${s.of} · ${fmt(mine.me.score)} points ${moveHtml(s.move)}</p>
        <p>${s.ahead
          ? `${fmt(s.ahead.gap)} points behind ${escapeHtml(s.ahead.avatar)} ${escapeHtml(s.ahead.nickname)}`
          : "You're in the lead! 🏆"}</p>
        ${mine.me.streak >= 2 ? `<p><span class="pill fire">🔥 ${mine.me.streak} right in a row</span></p>` : ""}`
      : `<h1 class="waiting-dots">Counting</h1>`}
      <p class="note">Next question coming up — eyes on the big screen.</p>
    </div>`);
}

function renderFinal(mine) {
  const f = mine?.final;
  draw(`final:${f ? 1 : 0}`, () => {
    if (!f) return `<div class="hero"><h1 class="waiting-dots">Adding it up</h1></div>`;
    const s = mine.standing;
    return `
      <div class="hero">
        <div class="face">${escapeHtml(session.avatar)}</div>
        <p class="eyebrow">${escapeHtml(game.title)} · final</p>
        <div class="rank">${ordinal(s.rank)}</div>
        <p class="sub">of ${s.of} · ${fmt(mine.me.score)} points</p>
        <div class="stats">
          <div class="stat"><b>${f.played ? Math.round((f.correct / f.played) * 100) : 0}%</b><span>${f.correct} of ${f.played} right</span></div>
          <div class="stat"><b>🔥 ${f.bestStreak}</b><span>best streak</span></div>
          <div class="stat"><b>${f.avgCorrectMs == null ? "—" : (f.avgCorrectMs / 1000).toFixed(1) + "s"}</b><span>per right answer</span></div>
        </div>
        ${f.badges.length ? `<div class="badges">${f.badges.map(b => `
          <div class="badge"><span class="e">${escapeHtml(b.emoji)}</span><b>${escapeHtml(b.title)}</b>${b.detail ? `<small>${escapeHtml(b.detail)}</small>` : ""}</div>`).join("")}</div>` : ""}
        <div class="card" style="text-align:left;margin-top:18px">
          <h3>Podium</h3>
          ${f.podium.map(p => `<p style="margin:6px 0">${["🥇", "🥈", "🥉"][p.rank - 1]} ${escapeHtml(p.avatar)} ${escapeHtml(p.nickname)} <span class="sub">· ${fmt(p.score)}</span></p>`).join("")}
        </div>
        <button class="big" id="again" style="margin-top:20px">Join another game</button>
      </div>`;
  }, () => {
    $("again")?.addEventListener("click", leave);
    if (f && celebrated !== "final") {
      celebrated = "final";
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
  showMessage("You were removed", "The host took you out of this game. You can join again with another nickname.");
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
    <p class="eyebrow">Quizly</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${escapeHtml(text)}</p>
    <button class="big" id="again" style="margin-top:12px">Join a game</button>`;
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
