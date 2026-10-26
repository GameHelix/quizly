/* The live leaderboard: a second screen in the room, or anyone's laptop.
 * Open /board#PIN and it follows the game — the QR code while people join,
 * then the standings, sliding into their new order after every question.
 * It reads only the shared state, so it needs no password.
 */

import { confetti } from "./fx.js";
import { renderBoard } from "./leaderboard.js";
import { getState, poll } from "./live.js";
import { $, escapeHtml, fitToScreen, keepFitting, plural } from "./ui.js";

const app = $("app");
let poller = null;
let drawn = "";
let boardJson = "";
let celebrated = false;

keepFitting();
open();
window.addEventListener("hashchange", open);

function open() {
  poller?.stop();
  drawn = "";
  boardJson = "";
  celebrated = false;
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
    <div class="wrap narrow">
      <p class="eyebrow">Quizly</p>
      <h1>Live leaderboard</h1>
      <form class="card" id="ask">
        <div class="field">
          <label for="pin">Game PIN</label>
          <input id="pin" inputmode="numeric" maxlength="7" placeholder="123 456" autofocus>
        </div>
        <button type="submit" class="big">Show the leaderboard</button>
        <p class="err" role="alert">${escapeHtml(message)}</p>
      </form>
    </div>`;
  $("ask").onsubmit = e => {
    e.preventDefault();
    const pin = $("pin").value.replace(/\D/g, "");
    if (pin.length !== 6) return;
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
      <p class="eyebrow">${escapeHtml(game.title)}</p><span class="grow"></span>
      <span class="pill" id="where"></span><span class="pill" id="players"></span>
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
          <section><div class="chips" id="chips"></div></section>
        </div>
      </div>`);
    const chips = $("chips");
    if (chips.children.length !== (game.roster || []).length) {
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
        <h1 class="hq">Leaderboard</h1>
        <ol class="board" id="board"></ol>
        <div class="awards" id="awards"></div>
        <p class="note" id="empty"></p>
      </div>`);
    const rows = game.leaderboard || [];
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
