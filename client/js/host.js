/* The presenter's screen, made for a projector. Pick a quiz, show the QR
 * code while the room joins, then run the whole game with one button:
 * Next — or the space bar, Enter, →, or a presentation clicker.
 *
 * It polls the game about once a second like every other screen; its own
 * button presses come back with the new state at once.
 */

import { LETTERS } from "/shared/quiz.js";
import { brand, footer, icon, progressRail, siteHeader, trophyArt } from "./design.js";
import { bump, confetti, sound } from "./fx.js";
import { TOP, climberHtml, renderBoard } from "./leaderboard.js";
import { clock, live } from "./live.js";
import { $, adminGate, api, askDialog, copyText, escapeHtml, fitToScreen, fmt, keepAwake, keepFitting, plural, toast } from "./ui.js";

const app = $("app");
let game = null;
let drawn = "";
let poller = null;
let ticker = null;
let busy = false;
let lastSecond = null;
let seenPlayers = 0;
let seenAnswers = 0;

await adminGate(app, "the host screen");
keepFitting();
open();
window.addEventListener("hashchange", open);

function open() {
  const pin = location.hash.slice(1);
  if (/^\d{6}$/.test(pin)) watch(pin);
  else renderCreate();
}

/* ---------- creating a game ---------- */

async function renderCreate() {
  stop();
  game = null;
  drawn = "";
  app.innerHTML = `<div class="wrap"><p class="eyebrow">Quizly</p><h1 class="waiting-dots">Loading quizzes</h1></div>`;
  let quizzes;
  try {
    quizzes = await api("/api/host/quizzes");
  } catch (err) {
    app.innerHTML = `${siteHeader("host")}<div class="wrap"><p class="eyebrow">Let's try that again</p><h1>Couldn't load your quizzes</h1><p class="sub">${escapeHtml(err.message)}</p><button id="retry">Try again</button></div>`;
    $("retry").onclick = renderCreate;
    return;
  }
  const playable = quizzes.filter(q => q.questions > 0);
  if (!playable.length) {
    app.innerHTML = `
      ${siteHeader("host")}<div class="wrap narrow"><div class="empty-state">${icon("book")}<h1>Your next great game starts here.</h1>
        <p>Create your first quiz or import a quiz file in the studio, then invite your people.</p><a class="btn" href="/admin" style="margin-top:24px">Open quiz studio ${icon("arrow")}</a>
      </div></div>${footer()}`;
    return;
  }
  let remembered = null;
  try {
    remembered = localStorage.getItem("quizly:quiz");
  } catch {
    // storage blocked: start from the first quiz
  }
  app.innerHTML = `
    ${siteHeader("host")}<div class="wrap wide"><div class="setup-layout">
      <section class="setup-copy"><span class="intro-tag">${icon("play")} The room is yours</span><h1>Great company.<br>Even better competition.</h1>
        <p class="sub">Pick a quiz. Gather your people. We'll take care of the countdowns, the points, and the big finish.</p><div class="hero-art">${trophyArt()}</div>
        <div class="key-hints"><span><kbd>F</kbd> Full screen</span><span><kbd>M</kbd> Sound</span><span><kbd>→</kbd> Next step</span></div></section>
      <form class="card setup-form" id="create"><span class="panel-icon" style="margin-bottom:18px">${icon("grid")}</span><h2>Set up your game</h2><p class="sub">Your lobby opens first. Start when everyone's in.</p>
        <div class="field">
          <label for="quiz">Choose your quiz</label>
          <select id="quiz">
            ${playable.map(q => `<option value="${escapeHtml(q.id)}"${q.id === remembered ? " selected" : ""}>${escapeHtml(q.title)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="category">Questions from</label>
          <select id="category"></select>
        </div>
        <div class="setup-summary">${icon("book")}<span id="summary"></span></div>
        <button type="submit" class="big" id="create-btn">Open the lobby ${icon("arrow")}</button>
        <p class="err" id="create-err" role="alert"></p>
        <p class="join-footnote">${icon("users")} Players join with a PIN or QR code.</p>
      </form></div></div>${footer()}`;

  const fill = () => {
    const q = playable.find(x => x.id === $("quiz").value);
    $("category").innerHTML = `<option value="">All categories</option>` +
      q.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    $("summary").textContent = `${plural(q.questions, "question")} in this quiz.`;
  };
  $("quiz").onchange = fill;
  fill();

  $("create").onsubmit = async e => {
    e.preventDefault();
    sound.unlock();
    $("create-btn").disabled = true;
    $("create-btn").textContent = "Opening your lobby…";
    try {
      localStorage.setItem("quizly:quiz", $("quiz").value);
    } catch {
      // not remembered, no harm
    }
    try {
      const state = await api("/api/host/games", { method: "POST", body: { quizId: $("quiz").value, category: $("category").value } });
      history.replaceState(null, "", `#${state.pin}`);
      watch(state.pin, state);
    } catch (err) {
      $("create-err").textContent = err.message;
      $("create-btn").disabled = false;
      $("create-btn").innerHTML = `Open the lobby ${icon("arrow")}`;
    }
  };
}

/* ---------- running it ---------- */

function watch(pin, initial) {
  stop();
  keepAwake();
  seenPlayers = 0;
  if (initial) show(initial);
  // The host follows the same public state as every screen in the room.
  poller = live(`/api/games/${pin}`, show, {
    onError: err => {
      if (err.status === 404) {
        toast("That game is no longer running.");
        history.replaceState(null, "", location.pathname);
        renderCreate();
      }
    }
  });
}

function show(state) {
  game = state;
  if (state.status === "abandoned") return closed();
  const key = `${state.phase}:${state.index}`;
  if (state.phase === "lobby") lobby();
  else if (state.phase === "question") question(key);
  else if (state.phase === "reveal") reveal(key);
  else if (state.phase === "leaderboard") scoreboard(key);
  else if (state.phase === "final") final(key);
  syncLock();
}

function draw(fingerprint, html, after) {
  if (fingerprint === drawn) return false;
  drawn = fingerprint;
  clearInterval(ticker);
  app.innerHTML = html();
  wire();
  after?.();
  fitToScreen();
  return true;
}

function lobby() {
  const url = new URL(game.joinUrl);
  const local = url.hostname === "localhost" || url.hostname.startsWith("127.");
  draw(`lobby:${game.pin}`, () => `
    <div class="stage ambient">
      <div class="hbar">${brand()}<span class="pill">${escapeHtml(game.title)}</span><span class="grow"></span>${toolbar()}</div>
      <div class="lobby">
        <section class="joincard">
          <p class="eyebrow">Scan to join</p>
          <img class="qr" src="/api/games/${game.pin}/qr.svg" alt="QR code that opens the game on a phone">
          <p class="eyebrow">or go to</p>
          <p class="url">${escapeHtml(url.host)}</p>
          <p class="eyebrow">and enter the game PIN</p>
          <p class="pin">${game.pin.slice(0, 3)} ${game.pin.slice(3)}</p>
          <div class="join-actions"><button class="text-btn" id="copy-link">Copy invite link ${icon("arrow")}</button><a class="btn quiet" style="font-size:11px;min-height:32px;padding:6px 10px" href="/board#${game.pin}" target="_blank" rel="noopener">Open leaderboard ${icon("trophy")}</a></div>
        </section>
        <section class="stack">
          <span class="live-label">THE LOBBY IS OPEN</span><h1 class="lobby-heading">The more, the merrier.</h1>
          <div class="row">
            <h2 style="margin:0;font-size:28px"><span id="count">0</span> <span id="count-word">players</span> ready</h2>
            <button id="next" style="font-size:18px;padding:14px 28px">Let's play ${icon("play")}</button>
          </div>
          <p class="sub" id="lobby-hint"></p>
          <div class="chips" id="chips"></div>
          <div class="lobby-empty" id="lobby-empty">${icon("users")}<p>Good company is on the way.<br>Share the QR code or game PIN to get everyone in.</p></div>
          <div class="mission-panel"><span class="mission-icon">${icon("bolt")}</span><div class="grow"><b>Bring your A-game</b><span>Think fast, build a streak, and climb the board.</span></div></div>
          ${local ? `<p class="warn">To join on a phone, open the host screen using this computer's network address or share a deployed game link.</p>` : ""}
        </section>
      </div>
    </div>`);
  $("count").textContent = fmt(game.players);
  $("count-word").textContent = game.players === 1 ? "player" : "players";
  $("next").disabled = !game.players || busy;
  $("lobby-empty").classList.toggle("hidden", !!game.players);
  $("copy-link").onclick = () => copyText(game.joinUrl, "Invite link copied");
  $("lobby-hint").textContent = game.locked
    ? "Locked — nobody new can join. Press 🔒 or L to open it again."
    : game.players
      ? "Click a name to remove it. Start when everyone is in — lock the game with L once they are."
      : "Waiting for the first player…";
  updateChips(game.roster || []);
  if (game.players > seenPlayers && seenPlayers > 0) {
    sound.join();
    bump($("count"));
  }
  seenPlayers = game.players;
}

/* Adds and removes name chips in place, so a new name pops in without the
 * others moving. textContent keeps a nickname from ever being markup. */
function updateChips(roster) {
  const box = $("chips");
  const have = new Map([...box.children].map(c => [c.dataset.id, c]));
  const want = new Set(roster.map(p => p.id));
  for (const [id, chip] of have) if (!want.has(id)) chip.remove();
  for (const p of roster) {
    if (have.has(p.id)) continue;
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.dataset.id = p.id;
    chip.title = "Remove from the game";
    chip.textContent = `${p.avatar} ${p.nickname}`;
    chip.onclick = async () => {
      if (await askDialog({ title: `Remove ${p.nickname}?`, message: "They'll leave this game and their score will be removed from the standings.", confirmLabel: "Remove player", danger: true })) act("kick", { playerId: p.id });
    };
    box.append(chip);
  }
  if (roster.length !== have.size) fitToScreen();
}

function question(key) {
  const q = game.question;
  const fresh = draw(key, () => `
    <div class="stage">
      <div class="hbar">
        ${brand()}
        <span class="pill">Question ${game.index + 1} of ${game.total}</span>
        ${q.category ? `<span class="pill">${escapeHtml(q.category)}</span>` : ""}
        <span class="grow"></span>${toolbar()}
      </div>
      ${progressRail(game.index, game.total, game.phase)}
      <h1 class="hq">${escapeHtml(q.prompt)}</h1>
      <div class="clockrow">
        <div class="clock" id="clock"><span id="secs"></span></div>
        <div class="answered-big leadin" id="answered-box"><b id="answered">Get ready</b><span id="answered-label">the options open on zero</span></div>
      </div>
      <div class="tiles waiting" id="tiles">
        ${q.options.map((o, i) => `<div class="tile c${i}"><span class="k">${LETTERS[i]}</span><span class="t">${escapeHtml(o)}</span></div>`).join("")}
      </div>
      <div class="hfoot">
        <button class="quiet" id="end">End game</button><span class="grow"></span>
        <span class="hint">Space or → closes the question now</span>
        <button id="next">Skip timer</button>
      </div>
    </div>`);
  if (fresh) {
    lastSecond = null;
    seenAnswers = 0;
    ticker = setInterval(tick, 100);
  }
  tick();
  if (game.answered > seenAnswers) bump($("answered"));
  seenAnswers = game.answered;
}

function tick() {
  if (game?.phase !== "question") return clearInterval(ticker);
  const q = game.question;
  const now = clock.now();
  const opensIn = q.opensAt - now;
  const remaining = Math.max(0, q.deadline - now);
  const clockEl = $("clock");
  if (opensIn > 0) {
    // The lead-in: the question is up, the options open on zero.
    const n = Math.ceil(opensIn / 1000);
    if ($("secs").textContent !== String(n)) {
      $("secs").textContent = n;
      clockEl.style.setProperty("--p", "100%");
      sound.tick();
    }
    return;
  }
  const tiles = $("tiles");
  if (tiles.classList.contains("waiting")) {
    tiles.classList.remove("waiting");
    $("answered-box").classList.remove("leadin");
    sound.go();
  }
  const secs = Math.ceil(remaining / 1000);
  $("secs").textContent = secs;
  $("answered").textContent = fmt(game.answered);
  $("answered-label").textContent = secs > 0
    ? `of ${plural(game.players, "player")} answered`
    : `of ${plural(game.players, "player")} answered · revealing the answer…`;
  // A calm clock, as on the phones: no red, no pulse, no ticking down the last seconds.
  clockEl.style.setProperty("--p", `${((remaining / q.limitMs) * 100).toFixed(1)}%`);
  if (secs !== lastSecond) {
    if (secs === 0 && lastSecond !== null) sound.timeUp();
    lastSecond = secs;
  }
}

function reveal(key) {
  const q = game.question;
  const r = game.reveal;
  const total = Math.max(1, r.answered);
  draw(key, () => `
    <div class="stage">
      <div class="hbar">
        ${brand()}
        <span class="pill">Question ${game.index + 1} of ${game.total}</span>
        <span class="grow"></span>${toolbar()}
      </div>
      <h2 class="hq small">${escapeHtml(q.prompt)}</h2>
      <div class="tiles reveal">
        ${q.options.map((o, i) => `
          <div class="tile c${i} ${i === r.answer ? "right" : "dim"}" style="--i:${i}">
            <span class="fill" data-w="${((r.counts[i] / total) * 100).toFixed(1)}"></span>
            <span class="k">${i === r.answer ? "✓" : LETTERS[i]}</span>
            <span class="t">${escapeHtml(o)}</span>
            <span class="n">${fmt(r.counts[i])}</span>
          </div>`).join("")}
      </div>
      <div class="card explain">
        <div class="explain-head">
          <h3>${fmt(r.correct)} of ${plural(r.answered, "answer")} right${r.answered ? ` · ${Math.round((r.correct / total) * 100)}%` : ""}</h3>
          ${r.fastest ? `<p class="spotlight">⚡ Fastest: <b>${escapeHtml(r.fastest.avatar)} ${escapeHtml(r.fastest.nickname)}</b> ${(r.fastest.ms / 1000).toFixed(1)} s</p>` : ""}
        </div>
        ${r.explanation ? `<p>${escapeHtml(r.explanation)}</p>` : ""}
      </div>
      <div class="hfoot">
        <button class="quiet" id="end">End game</button><span class="grow"></span>
        <button id="next">${game.index + 1 === game.total ? "Final results" : "Scoreboard"} →</button>
      </div>
    </div>`, () => {
    sound.reveal();
    requestAnimationFrame(() => {
      app.querySelectorAll(".fill").forEach(f => f.style.setProperty("--w", `${f.dataset.w}%`));
    });
  });
}

function scoreboard(key) {
  const climber = climberHtml(game.leaderboard);
  draw(key, () => `
    <div class="stage">
      <div class="hbar">
        ${brand()}
        <span class="pill">After question ${game.index + 1} of ${game.total}</span>
        <span class="grow"></span>${toolbar()}
      </div>
      <h1 class="hq">A little friendly rivalry.</h1>
      ${climber ? `<p class="spotlight">${climber}</p>` : ""}
      <div class="board-column-head"><span>The leaderboard</span><span>Points</span></div>
      <ol class="board" id="board"></ol>
      <div class="hfoot">
        <button class="quiet" id="end">End game</button><span class="grow"></span>
        <button id="next">Next question →</button>
      </div>
    </div>`, () => {
    renderBoard($("board"), (game.leaderboard || []).slice(0, TOP));
    fitToScreen();
    // A name that should not be on a projector can go from here too.
    $("board").onclick = async e => {
      const row = e.target.closest("li[data-id]");
      const name = row?.querySelector(".nm")?.textContent;
      if (row && await askDialog({ title: `Remove ${name}?`, message: "This player will leave the game.", confirmLabel: "Remove player", danger: true })) act("kick", { playerId: row.dataset.id });
    };
  });
}

function final(key) {
  const lb = game.leaderboard || [];
  const place = (p, n) => (p
    ? `<div class="place p${n}">
         <div class="face">${escapeHtml(p.avatar)}</div>
         <div class="who">${escapeHtml(p.nickname)}</div>
         <div class="pts">${fmt(p.score)} points</div>
         <div class="block">${n}</div>
       </div>`
    : `<div class="place p${n}"></div>`);
  draw(key, () => `
    <div class="stage">
      <div class="hbar">${brand()}<p class="eyebrow">${escapeHtml(game.title)} · final results</p><span class="grow"></span>${toolbar()}</div>
      <h1 class="hq small podium-title" style="text-align:center">Big brains. Well-earned bragging rights.</h1>
      <div class="podium">${place(lb[1], 2)}${place(lb[0], 1)}${place(lb[2], 3)}</div>
      ${game.awards?.length ? `
        <div class="awards">
          ${game.awards.map(a => `
            <div class="award">
              <div class="e">${escapeHtml(a.emoji)}</div>
              <div class="t">${escapeHtml(a.title)}</div>
              <div class="w">${escapeHtml(a.avatar)} ${escapeHtml(a.nickname)}</div>
              <div class="d">${escapeHtml(a.detail)}</div>
            </div>`).join("")}
        </div>` : ""}
      ${lb.length > 3 ? `<ol class="board compact" id="rest"></ol>` : ""}
      <div class="hfoot">
        <a class="btn quiet" href="/api/admin/games/${encodeURIComponent(game.id)}/results.csv">Download results (CSV)</a>
        <a class="btn quiet" href="/board#${game.pin}" target="_blank" rel="noopener">Leaderboard screen</a>
        <span class="grow"></span>
        <button id="again">New game</button>
      </div>
    </div>`, () => {
    $("again").onclick = () => {
      history.replaceState(null, "", location.pathname);
      renderCreate();
    };
    if ($("rest")) renderBoard($("rest"), lb.slice(3, TOP), { gains: false });
    fitToScreen();
    // In time with first place rising onto the podium.
    setTimeout(() => {
      confetti(4500, 240);
      sound.fanfare();
    }, 2700);
    poller?.stop();
  });
}

function closed() {
  stop();
  drawn = "";
  app.innerHTML = `
    ${siteHeader("host")}<div class="wrap narrow"><div class="empty-state">
      ${icon("flag")}
      <h1>Game closed</h1>
      <p class="sub">It ended before it started, so there are no results.</p>
      <button id="again" style="margin-top:24px">Start a fresh game ${icon("arrow")}</button>
    </div></div>${footer()}`;
  $("again").onclick = () => {
    history.replaceState(null, "", location.pathname);
    renderCreate();
  };
}

/* ---------- controls ---------- */

/* Sends one host action and shows the state it comes back with. True if it worked. */
async function act(action, body = {}) {
  if (busy || !game) return false;
  busy = true;
  sound.unlock();
  try {
    show(await api(`/api/host/games/${game.pin}/${action}`, {
      method: "POST",
      body: { from: { phase: game.phase, index: game.index }, ...body }
    }));
    return true;
  } catch (err) {
    if (err.status === 401) location.reload();   // the sign-in has run out: the page asks for it again
    else toast(err.message);
    return false;
  } finally {
    busy = false;
    if (game?.phase === "lobby") $("next").disabled = !game.players;
  }
}

async function endGame() {
  if (await askDialog({ title: "Call it a game?", message: "The scores so far will become the final results.", confirmLabel: "End game", danger: true })) act("end");
}

function toolbar() {
  return `
    <button class="quiet" id="lock" title="Lock or open the game to new players (L)" aria-label="Lock"></button>
    <button class="quiet" id="snd" title="Sound on or off (M)" aria-label="Sound ${sound.on ? "On" : "Off"}" aria-pressed="${sound.on}">${icon("sound")}<span>${sound.on ? "On" : "Off"}</span></button>
    <button class="quiet" id="fs" title="Full screen (F)" aria-label="Full screen">${icon("expand")}</button>`;
}

function wire() {
  $("lock")?.addEventListener("click", toggleLock);
  $("snd")?.addEventListener("click", toggleSound);
  $("fs")?.addEventListener("click", fullscreen);
  $("next")?.addEventListener("click", () => act("next"));
  $("end")?.addEventListener("click", endGame);
}

/* Locking closes the game to new players — once the room is in, so
 * nobody can flood it with made-up names. Players already in carry on. */
function toggleLock() {
  if (!game) return;
  const locking = !game.locked;
  act("lock", { locked: locking }).then(ok => ok && toast(locking ? "Locked: nobody new can join" : "Open: people can join again"));
}

function syncLock() {
  const b = $("lock");
  if (!b || !game) return;
  b.innerHTML = `${icon("lock")} ${game.locked ? "Locked" : "Open"}`;
  b.setAttribute("aria-label", game.locked ? "Locked. Open game to new players" : "Open. Lock game to new players");
  b.setAttribute("aria-pressed", String(!!game.locked));
  b.classList.toggle("ghost", !!game.locked);
  b.classList.toggle("quiet", !game.locked);
}

function toggleSound() {
  const on = sound.toggle();
  if ($("snd")) { $("snd").innerHTML = `${icon("sound")}<span>${on ? "On" : "Off"}</span>`; $("snd").setAttribute("aria-pressed", String(on)); $("snd").setAttribute("aria-label", `Sound ${on ? "On" : "Off"}`); }
  toast(on ? "Sound on" : "Sound off");
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener("keydown", e => {
  if (e.repeat || document.querySelector("dialog[open]") || e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (["Space", "Enter", "NumpadEnter", "ArrowRight", "PageDown"].includes(e.code)) {
    if (!game || game.status === "abandoned") return;   // no stage: keys keep their usual meaning
    // Chrome and Edge leave a clicked button focused. Space would press it
    // again — a second press of Lock opens the game — and a clicker would do
    // nothing, so on the stage these keys only ever mean Next. Enter still
    // presses a button reached with the keyboard.
    const button = e.target.closest("button, a");
    if (button && e.code.endsWith("Enter")) return;
    e.preventDefault();
    button?.blur();
    if (game.phase !== "final" && !(game.phase === "lobby" && !game.players)) act("next");
  } else if (e.key === "f" || e.key === "F") fullscreen();
  else if (e.key === "m" || e.key === "M") toggleSound();
  else if (e.key === "l" || e.key === "L") toggleLock();
});

function stop() {
  poller?.stop();
  poller = null;
  clearInterval(ticker);
}
