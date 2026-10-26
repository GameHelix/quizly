/* The live leaderboard: a second screen in the room, or anyone's laptop.
 * Open /board#PIN and it follows the game — the QR code while people join,
 * then the standings, sliding into their new order after every question.
 * It reads only the shared state, so it needs no password.
 */

import { confetti } from "./fx.js";
import { brand, footer, icon, siteHeader, trophyArt } from "./design.js";
import { renderBoard } from "./leaderboard.js";
import { getState, poll } from "./live.js";
import { $, escapeHtml, fitToScreen, keepFitting, plural } from "./ui.js";

const app = $("app");
let poller = null;
let drawn = "";
let boardJson = "";
let celebrated = false;
let rosterJson = "";

keepFitting();
open();
window.addEventListener("hashchange", open);

function open() {
  poller?.stop();
  drawn = "";
  boardJson = "";
  celebrated = false;
  rosterJson = "";
  const pin = location.hash.slice(1);
  if (!/^\d{6}$/.test(pin)) return ask();
  poller = poll(async () => show(await getState(`/api/games/${pin}`)), 1500, {
    onError: err => {
      if (err.status === 404) ask("No game with that PIN is running.");
    }
  });
}

function ask(message = "") {
  poller?.stop();
  drawn = "";
  app.innerHTML = `
    ${siteHeader("board")}<div class="board-entry">
      <div><span class="intro-tag">${icon("trophy")} Every point has a story</span><h1>Who's bringing<br>their A-game?</h1><p class="sub">Follow the friendly rivalry, the comeback moments,<br>and the climb to the top. Live, as it happens.</p>${trophyArt()}</div>
      <form class="card" id="ask" novalidate><span class="panel-icon" style="margin-bottom:20px">${icon("trophy")}</span><h2>Get the room buzzing.</h2><p class="sub" style="font-size:13px">Enter a game PIN to follow the standings.</p>
        <div class="field">
          <label for="pin">Game PIN</label>
          <input class="pin-input" id="pin" inputmode="numeric" maxlength="7" placeholder="123 456" aria-describedby="board-error" autofocus>
        </div>
        <button type="submit" class="big">Show the leaderboard ${icon("arrow")}</button>
        <p class="err" id="board-error" role="alert">${escapeHtml(message)}</p><p class="join-footnote">${icon("check")} A front-row seat. No sign-in needed.</p>
      </form>
    </div>${footer()}`;
  $("ask").onsubmit = e => {
    e.preventDefault();
    const pin = $("pin").value.replace(/\D/g, "");
    if (pin.length !== 6) { $("board-error").textContent = "Enter the six-digit PIN from the host's screen."; $("pin").setAttribute("aria-invalid", "true"); $("pin").focus(); return; }
    $("pin").removeAttribute("aria-invalid");
    $("ask").querySelector('button[type="submit"]').textContent = "Finding your game…";
    history.replaceState(null, "", `#${pin}`);
    open();
  };
}

function show(game) {
  if (game.status === "abandoned") return ask("That game was closed before it started.");
  const where = game.phase === "final" ? "Final results"
    : game.phase === "lobby" ? "Waiting to start"
    : `Question ${game.index + 1} of ${game.total}`;
  const head = `
    <div class="hbar">
      ${brand()}<p class="eyebrow">${escapeHtml(game.title)}</p><span class="grow"></span>
      <span class="pill" id="where"></span><span class="pill" id="players"></span>
      <a href="/board" class="sub" style="font-size:11px">Switch game</a>
    </div>`;

  if (game.phase === "lobby") {
    const url = new URL(game.joinUrl);
    draw("lobby", () => `
      <div class="stage ambient">
        ${head}
        <div class="lobby">
          <section class="joincard">
            <p class="eyebrow">Scan to join</p>
            <img class="qr" src="/api/games/${game.pin}/qr.svg" alt="QR code that opens the game on a phone">
            <p class="url">${escapeHtml(url.host)}</p>
            <p class="eyebrow">Game PIN</p>
            <p class="pin">${game.pin.slice(0, 3)} ${game.pin.slice(3)}</p>
          </section>
          <section><span class="live-label">GOOD COMPANY IS JOINING</span><h1 class="lobby-heading">Meet your competition.</h1><p class="sub">Find your game face. The host will start when everyone's ready.</p><div class="chips" id="chips"></div></section>
        </div>
      </div>`);
    const chips = $("chips");
    const signature = JSON.stringify(game.roster || []);
    if (signature !== rosterJson) {
      rosterJson = signature;
      chips.replaceChildren(...(game.roster || []).map(p => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `${p.avatar} ${p.nickname}`;
        return chip;
      }));
      fitToScreen();
    }
  } else {
    draw("board", () => `
      <div class="stage">
        ${head}
        <h1 class="hq" id="board-title">A little friendly rivalry.</h1><div class="board-column-head"><span>The leaderboard</span><span>Points</span></div>
        <ol class="board" id="board"></ol>
        <div class="awards" id="awards"></div>
        <p class="note" id="empty"></p>
        <p class="spectator-note" id="spectator-note">${icon("bolt")} Every question is a chance to climb. Keep playing.</p>
      </div>`);
    const rows = game.leaderboard || [];
    $("board-title").textContent = game.phase === "final" ? "The final bragging rights." : "A little friendly rivalry.";
    $("spectator-note").classList.toggle("hidden", game.phase === "final");
    const json = JSON.stringify(rows);
    if (json !== boardJson) {
      boardJson = json;
      renderBoard($("board"), rows);
      fitToScreen();
    }
    $("empty").textContent = rows.length ? "" : "The standings appear after the first question.";
    if (game.phase === "final" && !celebrated) {
      celebrated = true;
      $("awards").innerHTML = (game.awards || []).map(a => `
        <div class="award" style="animation-delay:0s">
          <div class="e">${escapeHtml(a.emoji)}</div>
          <div class="t">${escapeHtml(a.title)}</div>
          <div class="w">${escapeHtml(a.avatar)} ${escapeHtml(a.nickname)}</div>
          <div class="d">${escapeHtml(a.detail)}</div>
        </div>`).join("");
      fitToScreen();
      confetti(4000);
      poller?.stop();
    }
  }
  $("where").textContent = where;
  $("players").textContent = plural(game.players ?? 0, "player");
}

function draw(fingerprint, html) {
  if (fingerprint === drawn) return;
  drawn = fingerprint;
  app.innerHTML = html();
  fitToScreen();
}
