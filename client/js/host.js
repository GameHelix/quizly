/* The presenter's screen, made for a projector. Pick a quiz, show the QR
 * code while the room joins, then run the whole game with one button:
 * Next — or the space bar, Enter, →, or a presentation clicker.
 *
 * It polls the game about once a second like every other screen; its own
 * button presses come back with the new state at once.
 */

import { LETTERS } from "/shared/quiz.js";
import { bump, confetti, sound } from "./fx.js";
import { renderBoard } from "./leaderboard.js";
import { clock, getState, poll } from "./live.js";
import { $, adminGate, api, escapeHtml, fitToScreen, fmt, keepAwake, keepFitting, plural, toast } from "./ui.js";

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
    app.innerHTML = `<div class="wrap"><p class="eyebrow">Quizly</p><h1>Could not load the quizzes</h1><p class="sub">${escapeHtml(err.message)}</p></div>`;
    return;
  }
  const playable = quizzes.filter(q => q.questions > 0);
  if (!playable.length) {
    app.innerHTML = `
      <div class="wrap">
        <p class="eyebrow">Quizly</p>
        <h1>No quizzes to play yet</h1>
        <p class="sub">Create a quiz or import a quiz file in the <a href="/admin">admin panel</a>, then come back here.</p>
      </div>`;
    return;
  }
  let remembered = null;
  try {
    remembered = localStorage.getItem("quizly:quiz");
  } catch {
    // storage blocked: start from the first quiz
  }
  app.innerHTML = `
    <div class="wrap">
      <div class="row">
        <div><p class="eyebrow">Quizly</p><h1>Host a game</h1></div>
        <span class="bar"><a class="sub" href="/admin">Admin panel</a></span>
      </div>
      <form class="card" id="create">
        <div class="field">
          <label for="quiz">Quiz</label>
          <select id="quiz">
            ${playable.map(q => `<option value="${escapeHtml(q.id)}"${q.id === remembered ? " selected" : ""}>${escapeHtml(q.title)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="category">Questions from</label>
          <select id="category"></select>
        </div>
        <p class="sub" id="summary"></p>
        <button type="submit" class="big" id="create-btn">Create game</button>
        <p class="err" id="create-err" role="alert"></p>
      </form>
      <p class="note" style="margin-top:16px">On the game screen: <b>F</b> full screen, <b>M</b> sound on or off,
        and <b>Space</b>, <b>Enter</b>, <b>→</b> or a presentation clicker for Next.</p>
    </div>`;

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
    }
  };
}

/* ---------- running it ---------- */

function watch(pin, initial) {
  stop();
  keepAwake();
  seenPlayers = 0;
  if (initial) show(initial);
  poller = poll(async () => show(await getState(`/api/host/games/${pin}`)), 1000, {
    onError: err => {
      if (err.status === 401) location.reload();
      else if (err.status === 404) {
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
      <div class="hbar"><p class="eyebrow">${escapeHtml(game.title)}</p><span class="grow"></span>${toolbar()}</div>
      <div class="lobby">
        <section class="joincard">
          <p class="eyebrow">Scan to join</p>
          <img class="qr" src="/api/games/${game.pin}/qr.svg" alt="QR code that opens the game on a phone">
          <p class="eyebrow">or go to</p>
          <p class="url">${escapeHtml(url.host)}</p>
          <p class="eyebrow">and enter the game PIN</p>
          <p class="pin">${game.pin.slice(0, 3)} ${game.pin.slice(3)}</p>
          ${local ? `<p class="warn">Phones cannot reach “localhost”. Open this page at this computer's network address, or set PUBLIC_URL.</p>` : ""}
        </section>
        <section class="stack">
          <div class="row">
            <h1 style="margin:0"><span id="count">0</span> <span id="count-word">players</span></h1>
            <button id="next" style="font-size:20px;padding:14px 34px">Start</button>
          </div>
          <p class="sub" id="lobby-hint"></p>
          <div class="chips" id="chips"></div>
        </section>
      </div>
    </div>`);
  $("count").textContent = fmt(game.players);
  $("count-word").textContent = game.players === 1 ? "player" : "players";
  $("next").disabled = !game.players || busy;
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
    chip.onclick = () => {
      if (confirm(`Remove ${p.nickname} from the game?`)) act("kick", { playerId: p.id });
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
        <span class="pill">Question ${game.index + 1} of ${game.total}</span>
        ${q.category ? `<span class="pill">${escapeHtml(q.category)}</span>` : ""}
        <span class="grow"></span>${toolbar()}
      </div>
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
  clockEl.style.setProperty("--p", `${((remaining / q.limitMs) * 100).toFixed(1)}%`);
  clockEl.classList.toggle("low", remaining > 0 && remaining <= 5000);
  if (secs !== lastSecond) {
    if (secs > 0 && secs <= 5) sound.tick();
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
        <h3>${fmt(r.correct)} of ${plural(r.answered, "answer")} right${r.answered ? ` · ${Math.round((r.correct / total) * 100)}%` : ""}</h3>
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
  draw(key, () => `
    <div class="stage">
      <div class="hbar">
        <span class="pill">After question ${game.index + 1} of ${game.total}</span>
        <span class="grow"></span>${toolbar()}
      </div>
      <h1 class="hq">Scoreboard</h1>
      <ol class="board" id="board"></ol>
      <div class="hfoot">
        <button class="quiet" id="end">End game</button><span class="grow"></span>
        <button id="next">Next question →</button>
      </div>
    </div>`, () => {
    renderBoard($("board"), (game.leaderboard || []).slice(0, 10));
    fitToScreen();
    // A name that should not be on a projector can go from here too.
    $("board").onclick = e => {
      const row = e.target.closest("li[data-id]");
      const name = row?.querySelector(".nm")?.textContent;
      if (row && confirm(`Remove ${name} from the game?`)) act("kick", { playerId: row.dataset.id });
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
      <div class="hbar"><p class="eyebrow">${escapeHtml(game.title)} · final results</p><span class="grow"></span>${toolbar()}</div>
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
    if ($("rest")) renderBoard($("rest"), lb.slice(3, 10), { gains: false });
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
    <div class="wrap">
      <p class="eyebrow">Quizly</p>
      <h1>Game closed</h1>
      <p class="sub">It ended before it started, so there are no results.</p>
      <button id="again">New game</button>
    </div>`;
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
    toast(err.message);
    return false;
  } finally {
    busy = false;
    if (game?.phase === "lobby") $("next").disabled = !game.players;
  }
}

function endGame() {
  if (confirm("End the game now? The scores so far become the final results.")) act("end");
}

function toolbar() {
  return `
    <button class="quiet" id="lock" title="Lock or open the game to new players (L)" aria-label="Lock"></button>
    <button class="quiet" id="snd" title="Sound on or off (M)" aria-label="Sound">${sound.on ? "🔊" : "🔇"}</button>
    <button class="quiet" id="fs" title="Full screen (F)" aria-label="Full screen">⛶</button>`;
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
  b.textContent = game.locked ? "🔒 Locked" : "🔓 Open";
  b.classList.toggle("ghost", !!game.locked);
  b.classList.toggle("quiet", !game.locked);
}

function toggleSound() {
  const on = sound.toggle();
  if ($("snd")) $("snd").textContent = on ? "🔊" : "🔇";
  toast(on ? "Sound on" : "Sound off");
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const onButton = e.target.closest("button, a");
  if (["Space", "Enter", "ArrowRight", "PageDown"].includes(e.code) && !onButton) {
    if (!game || game.phase === "final" || (game.phase === "lobby" && !game.players)) return;
    e.preventDefault();
    act("next");
  } else if (e.key === "f" || e.key === "F") fullscreen();
  else if (e.key === "m" || e.key === "M") toggleSound();
  else if (e.key === "l" || e.key === "L") toggleLock();
});

function stop() {
  poller?.stop();
  poller = null;
  clearInterval(ticker);
}
