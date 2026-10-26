/* Shared visual language. Decorative SVGs stay local and need no image requests. */
const paths = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  trophy: '<path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 1v5m-4 3h8m-6-3h4v3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  book: '<path d="M12 5v16m0-16C9 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-7-2-10 1Z"/>',
  flag: '<path d="M5 22V3c5-4 9 4 14 0v11c-5 4-9-4-14 0"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4V5Zm5 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>'
};

export const icon = (name, cls = "") => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;

export const brand = () => `<a class="brand" href="/" aria-label="Quizly. Home"><span class="brand-mark" aria-hidden="true"><svg width="29" height="29" viewBox="0 0 64 64" fill="currentColor"><path d="M32 10a20 20 0 1 0 12 36l9 8 6-7-9-8A20 20 0 0 0 32 10Zm0 10a10 10 0 1 1 0 20 10 10 0 0 1 0-20Z"/></svg></span>quizly<span class="brand-dot">.</span></a>`;

export function siteHeader(active = "play") {
  return `<header class="site-header">${brand()}<button class="quiet nav-toggle" data-nav-toggle aria-expanded="false" aria-controls="primary-navigation" aria-label="Explore navigation">${icon("grid")}</button><nav class="site-nav" id="primary-navigation" aria-label="Main navigation">
    <a href="/"${active === "play" ? ' aria-current="page"' : ""}>${icon("play")}<span>Play</span></a>
    <a href="/board"${active === "board" ? ' aria-current="page"' : ""}>${icon("trophy")}<span>Leaderboard</span></a>
    <a href="/admin"${active === "admin" ? ' aria-current="page"' : ""}>${icon("grid")}<span>Quiz studio</span></a>
  </nav><a class="btn header-cta" href="/host">Host a game ${icon("arrow")}</a></header>`;
}

export const footer = () => `<footer class="site-footer"><span>A little friendly competition. A lot of fun.</span><button class="text-btn" data-help>How to play ${icon("arrow")}</button></footer>`;

export const trophyArt = () => `<svg class="trophy-art" viewBox="0 0 440 280" fill="none" aria-hidden="true">
  <circle cx="230" cy="143" r="112" fill="#d5edac"/>
  <path d="m70 69 8 13 15-1-10 12 5 15-14-7-13 9 2-16-11-10 15-2 3-13Z" fill="#f4a349"/>
  <path d="m366 51 4 12 13 4-13 4-4 12-4-12-13-4 13-4 4-12Z" fill="#245c43"/>
  <path d="m330 218 4 10 11 3-11 4-4 10-3-10-11-4 11-3 3-10Z" fill="#7864ce"/>
  <g transform="rotate(-9 230 135)"><path d="M174 68h-37v26c0 31 19 47 47 47m100-73h37v26c0 31-19 47-47 47" stroke="#e7aa25" stroke-width="15"/>
  <path d="M170 52h118v62c0 38-25 62-59 62s-59-24-59-62V52Z" fill="#f5c84c"/>
  <path d="M229 52h59v62c0 38-25 62-59 62V52Z" fill="#ecb431"/>
  <path d="m229 76 9 19 21 3-15 15 3 22-18-10-19 10 4-22-16-15 22-3 9-19Z" fill="#fff7d3"/>
  <path d="M220 175h18v33h-18z" fill="#e5ac2b"/><path d="M196 206h66v13h-66z" fill="#f5c84c"/>
  <rect x="183" y="219" width="92" height="20" rx="5" fill="#245c43"/></g>
  <path d="m106 172-9 16m-5-28-17 5m262-40 16-9m-20-3 2-17" stroke="#245c43" stroke-width="4" stroke-linecap="round"/>
  <circle cx="115" cy="224" r="6" fill="#7864ce"/><circle cx="316" cy="41" r="4" fill="#f4a349"/>
</svg>`;

export function progressRail(index, total, phase) {
  const done = phase === "question" ? index : index + 1;
  return `<div class="round-progress" role="progressbar" aria-label="Questions completed" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${Math.min(100, done / Math.max(1, total) * 100)}%"></span></div>`;
}

export function missionPanel(streak = 0) {
  const target = streak < 3 ? 3 : 5;
  return `<div class="mission-panel"><span class="mission-icon">${icon("bolt")}</span><div class="grow"><b>${streak >= 5 ? "You're on fire!" : streak >= 3 ? "Streak unlocked. Keep it going!" : "Your next challenge"}</b><span>${streak >= 5 ? "Five in a row. Every answer counts." : `Get ${target} answers right in a row`}</span></div><div class="mission-dots" role="img" aria-label="${streak} consecutive correct answers; goal: ${target}">${Array.from({length: target}, (_, i) => `<i class="${i < streak ? "done" : ""}"></i>`).join("")}</div></div>`;
}
