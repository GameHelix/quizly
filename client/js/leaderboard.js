/* A leaderboard drawn as one row per player, kept between updates: when the
 * standings change each row slides from where it was to where it now is,
 * and its score counts up. The host's scoreboard and the standalone
 * leaderboard screen both draw with this.
 */

import { countUp } from "./fx.js";
import { escapeHtml } from "./ui.js";

const MEDALS = ["🥇", "🥈", "🥉"];

export function renderBoard(list, rows, { gains = true } = {}) {
  const before = new Map([...list.children].map(li => [li.dataset.id, li.getBoundingClientRect().top]));
  const kept = new Map([...list.children].map(li => [li.dataset.id, li]));

  const items = rows.map(r => {
    let li = kept.get(r.id);
    const shown = li ? Number(li.dataset.score) : r.score - (r.gained || 0);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "enter";
    }
    li.innerHTML = `
      <span class="rk${r.rank <= 3 ? " medal" : ""}">${MEDALS[r.rank - 1] ?? r.rank}</span>
      <span class="av">${escapeHtml(r.avatar)}</span>
      <span class="nm">${escapeHtml(r.nickname)}</span>
      <span class="mv">${moveHtml(r.move)}</span>
      <span class="st">${r.streak >= 2 ? `🔥 ${r.streak}` : ""}</span>
      <span class="sc"><span class="gn">${gains && r.gained ? `+${r.gained.toLocaleString("en-US")} ` : ""}</span><span class="n">${shown.toLocaleString("en-US")}</span></span>`;
    li.dataset.score = r.score;
    if (shown !== r.score) countUp(li.querySelector(".n"), shown, r.score);
    return li;
  });
  list.replaceChildren(...items);

  items.forEach((li, i) => {
    const was = before.get(li.dataset.id);
    if (was === undefined) {
      li.style.animationDelay = `${Math.min(i, 12) * 60}ms`;
      return;
    }
    const dy = was - li.getBoundingClientRect().top;
    if (dy && li.animate) {
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  });
}

export function moveHtml(move) {
  if (move > 0) return `<span class="move up">▲${move}</span>`;
  if (move < 0) return `<span class="move down">▼${-move}</span>`;
  return "";
}
