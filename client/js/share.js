/* The result card at the end of a game: a picture worth posting, drawn on a
 * canvas from this phone's final view, and a message to send with it.
 *
 * Every result earns a playful title made from its avatar and how the game
 * went (a "Lightning Turtle", a "Curious Bunny"), so nobody has to win to
 * want to share. The phone's share sheet takes the picture to Instagram,
 * WhatsApp, LinkedIn and the rest; a button per app opens that app, and Save
 * and Copy work where nothing else does.
 */

import { icon } from "./design.js";
import { tier } from "./leaderboard.js";
import { $, copyText, escapeHtml, fmt, ordinal, plural, toast } from "./ui.js";

const W = 1080;   // 4:5, the shape Instagram, LinkedIn and WhatsApp all show whole
const H = 1350;
const DISPLAY = "'Space Grotesk', Inter, sans-serif";
const BODY = "Inter, sans-serif";
const EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";
const INK = "#1b3027";
const MUTED = "#5c685e";
const FOREST = "#245c43";
const MEDALS = ["🥇", "🥈", "🥉"];

// Backgrounds in the answer colours, each with its text colour and a pale tint.
const LOOKS = [
  { bg: "#1368ce", ink: "#ffffff", tint: "#dce9fb" },
  { bg: "#d81e3f", ink: "#ffffff", tint: "#fde2e7" },
  { bg: "#ffc21a", ink: "#2b2200", tint: "#fff1c2" },
  { bg: "#1f7f12", ink: "#ffffff", tint: "#e2f2dc" },
  { bg: "#7864ce", ink: "#ffffff", tint: "#ece8fa" }
];
const CONFETTI = ["#d81e3f", "#1368ce", "#ffc21a", "#1f7f12", "#d4ed83", "#ffffff", "#f4a349", "#7864ce"];

const ANIMALS = {
  "🦊": "Fox", "🐼": "Panda", "🐯": "Tiger", "🦁": "Lion", "🐸": "Frog", "🐙": "Octopus",
  "🦄": "Unicorn", "🐝": "Bee", "🐧": "Penguin", "🦉": "Owl", "🐨": "Koala", "🐵": "Monkey",
  "🐳": "Whale", "🦖": "T-Rex", "🐢": "Turtle", "🦩": "Flamingo", "🐞": "Ladybug", "🦔": "Hedgehog",
  "🐶": "Puppy", "🐱": "Kitten", "🐰": "Bunny", "🐻": "Bear", "🐮": "Cow", "🐷": "Piglet"
};

/* The first that fits names the card. Each has three lines to say it, and
 * "New look" moves to the next; a dare closes the card unless it says another. */
const DARE = "Can you beat me? 😜";
const PERSONAS = [
  { word: "Champion", emoji: "👑", fits: r => r.rank === 1, lines: [
    "First place! Where do I pick up my crown?",
    "Number one in the room. Photos later! 📸",
    "I came, I played, I won."] },
  { word: "Genius", emoji: "🧠", fits: r => r.has("Flawless"), lines: [
    "Every answer right. Not one miss!",
    "A perfect score. My brain needs a holiday! 🏖️",
    "100% right. Yes, I'm a little proud."] },
  { word: "Lightning", emoji: "⚡", fits: r => r.has("Fastest finger"), lines: [
    "Faster than the question!",
    "I answered before I finished reading.",
    "Speed level: three coffees. ☕☕☕"] },
  { word: "Unstoppable", a: "an", emoji: "🔥", fits: r => r.has("Longest streak") || r.bestStreak >= 5, lines: [
    "So many in a row, my phone got hot!",
    "Streak mode on. Nobody could stop me!",
    "Right, right, right, right… you get it."] },
  { word: "Comeback", emoji: "📈", fits: r => r.has("Comeback"), lines: [
    "Slow start. Big finish!",
    "Plot twist: I came back strong! 🎬",
    "Never give up. Look at me now!"] },
  { word: "Superstar", emoji: "🌟", fits: r => r.rank <= 3 && r.rate >= 0.5, lines: [
    "On the podium. Applause, please! 👏",
    "So close to the crown. Next time!",
    "Podium photo time! 📸"] },
  { word: "Big-Brain", emoji: "💡", fits: r => r.rate >= 0.8, lines: [
    "Brain fully charged! 🔋",
    "Big brain energy, all day long.",
    "My brain did a great job today."] },
  { word: "Clever", emoji: "✨", fits: r => r.rate >= 0.6, lines: [
    "Sharp as a new pencil! ✏️",
    "More right than wrong. I'll take it!",
    "Smart, and still humble. Mostly."] },
  { word: "Bright", emoji: "🌤️", fits: r => r.rate >= 0.4, lines: [
    "Getting brighter with every question!",
    "Half genius, half surprise. 🎁",
    "Today a warm-up. Next time, the crown!"] },
  { word: "Curious", emoji: "🌱", dare: "Come and learn with me! 🌱", fits: () => true, lines: [
    "Every miss was a new thing learned!",
    "Came to play, left smarter.",
    "My brain is still loading… and learning fast!"] }
];

const glyph = body => `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const enc = encodeURIComponent;

/* Chat apps take the message straight away. Instagram takes only a picture,
 * and LinkedIn and Facebook post one best, so on a phone those three share
 * the card; elsewhere LinkedIn and Facebook fall back to sharing the link. */
const APPS = [
  { key: "whatsapp", name: "WhatsApp", link: m => `https://wa.me/?text=${enc(`${m.text}\n${m.url}`)}`,
    glyph: glyph('<path fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" d="M12 3.6a8.4 8.4 0 0 0-7.2 12.7l-1.1 4 4.1-1.1A8.4 8.4 0 1 0 12 3.6Z"/><path fill="#fff" d="M9.3 7.7c-.3 0-.7.2-.9.6-.4.7-.4 2 .8 3.7 1.3 1.9 3 3 4.6 3.4.8.2 1.4-.2 1.7-.7.2-.3.3-.7.2-.9-.1-.2-.3-.3-.6-.4l-1.3-.6c-.3-.1-.5 0-.6.2l-.5.6c-.1.2-.3.2-.5.1-.9-.4-1.9-1.3-2.4-2.2-.1-.2-.1-.3.1-.5l.4-.5c.2-.2.2-.4.1-.6l-.6-1.4c-.1-.3-.3-.4-.5-.4Z"/>') },
  { key: "instagram", name: "Instagram",
    glyph: glyph('<rect x="4" y="4" width="16" height="16" rx="4.6" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="3.7" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.6" cy="7.4" r="1.1" fill="#fff"/>') },
  { key: "linkedin", name: "LinkedIn", picture: true, link: m => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(m.url)}`,
    glyph: glyph('<rect x="5" y="9.6" width="3" height="9" fill="#fff"/><circle cx="6.5" cy="6.4" r="1.75" fill="#fff"/><path fill="#fff" d="M10.4 9.6h2.9v1.3c.5-.9 1.6-1.5 2.9-1.5 2.3 0 3.3 1.5 3.3 4v5.2h-3v-4.6c0-1.2-.4-2-1.5-2-1.2 0-1.6.9-1.6 2v4.6h-3V9.6Z"/>') },
  { key: "telegram", name: "Telegram", link: m => `https://t.me/share/url?url=${enc(m.url)}&text=${enc(m.text)}`,
    glyph: glyph('<path fill="#fff" d="M20.3 4.4 3.6 10.9c-1.1.4-1.1 1.1-.2 1.4l4.3 1.3 1.6 5c.2.6.6.7 1 .3l2.3-2.1 4.5 3.3c.8.5 1.4.2 1.6-.8l2.9-13.6c.3-1.2-.4-1.7-1.3-1.3Z"/><path fill="none" stroke="#229ed9" stroke-width="1.3" stroke-linecap="round" d="m8.4 13.3 8.3-5.3"/>') },
  { key: "facebook", name: "Facebook", picture: true, link: m => `https://www.facebook.com/sharer/sharer.php?u=${enc(m.url)}`,
    glyph: glyph('<path fill="#fff" d="M13.4 20.5v-7.3h2.5l.4-2.9h-2.9V8.5c0-.8.2-1.4 1.4-1.4h1.6V4.6c-.3 0-1.2-.1-2.3-.1-2.2 0-3.8 1.4-3.8 3.9v1.9H7.8v2.9h2.5v7.3h3.1Z"/>') },
  { key: "x", name: "X", link: m => `https://twitter.com/intent/tweet?text=${enc(m.text)}&url=${enc(m.url)}`,
    glyph: glyph('<path fill="#fff" d="M16.9 4h2.7l-5.9 6.8L20.6 20h-5.4l-4.2-5.5L6.1 20H3.4l6.3-7.3L3.1 4h5.5l3.8 5 4.5-5Zm-.9 14.4h1.5L8 5.5H6.4l9.6 12.9Z"/>') }
];

/* Everything the card and the message say, from the phone's final view. */
export function cardResult(mine, quiz) {
  const f = mine.final;
  const s = mine.standing;
  const r = {
    nickname: mine.me.nickname, avatar: mine.me.avatar, quiz, score: mine.me.score,
    correct: f.correct, played: f.played, rate: f.played ? f.correct / f.played : 0,
    rank: s.rank, of: s.of, tier: tier(s), bestStreak: f.bestStreak, avgMs: f.avgCorrectMs,
    history: (mine.history ?? []).slice(0, f.played), badges: f.badges,
    has: title => f.badges.some(b => b.title === title)
  };
  r.persona = PERSONAS.find(p => p.fits(r));
  r.title = `${r.persona.word} ${ANIMALS[r.avatar] ?? "Star"}`;
  return r;
}

/* What goes with the picture: who, how it went, the run as coloured squares
 * that give no answers away, and a dare. */
function message(r) {
  const misses = r.played - r.correct;
  const place = r.tier === "top" ? `${MEDALS[r.rank - 1] ?? "🏅"} ${ordinal(r.rank)} of ${r.of}`
    : r.tier === "half" ? `top half of ${r.of}`
    : misses ? `🌱 ${plural(misses, "new thing")} learned` : `🔥 ${r.bestStreak} in a row`;
  return {
    text: [
      `I'm ${r.persona.a ?? "a"} ${r.title}! ${r.avatar}${r.persona.emoji}`,
      `${r.correct}/${r.played} right · ${fmt(r.score)} points · ${place}`,
      r.history.map(h => (h === true ? "🟩" : "⬜")).join(""),
      `“${r.quiz}” on Quizly. ${r.persona.dare ?? DARE}`
    ].join("\n"),
    url: `${location.origin}/`
  };
}

export function sharePanel(r) {
  const m = message(r);
  const label = `${r.nickname} is ${r.persona.a ?? "a"} ${r.title}: ${r.correct} of ${r.played} right, ${fmt(r.score)} points.`;
  return `
    <section class="share-panel" aria-labelledby="share-title">
      <h2 id="share-title">Your result card 🎉</h2>
      <p class="sub">Made just for you. Post it, send it, show it off!</p>
      <div class="share-card">
        <canvas id="share-canvas" width="${W}" height="${H}" role="img" aria-label="${escapeHtml(label)}"></canvas>
        <button type="button" class="share-look" id="share-look">🎲 New look</button>
      </div>
      <button type="button" class="big share-main" id="share-main">${icon("share")} Share my card</button>
      <div class="share-apps">
        ${APPS.map(app => app.link
          ? `<a class="share-app ${app.key}" href="${escapeHtml(app.link(m))}" target="_blank" rel="noopener"${app.picture ? " data-picture" : ""}><span class="dot">${app.glyph}</span>${app.name}</a>`
          : `<button type="button" class="share-app ${app.key}" data-picture><span class="dot">${app.glyph}</span>${app.name}</button>`).join("")}
      </div>
      <div class="share-tools">
        <button type="button" class="text-btn" id="share-save">${icon("download")} Save picture</button>
        <button type="button" class="text-btn" id="share-copy">${icon("copy")} Copy message</button>
      </div>
    </section>`;
}

/* Draws the card into the panel and wires up its buttons. The picture is
 * made ahead of the tap: a share sheet only opens straight from one. */
export function wireShare(r) {
  const canvas = $("share-canvas");
  if (!canvas) return;
  const m = message(r);
  const full = `${m.text}\n${m.url}`;
  let look = Math.floor(seeded(r.nickname)() * LOOKS.length * 3);
  let file = null;
  let drawing = 0;

  const redraw = async () => {
    const mine = ++drawing;
    file = null;
    await drawCard(canvas, r, look);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (mine === drawing && blob) file = new File([blob], "quizly-result.png", { type: "image/png" });
  };
  const can = data => !!navigator.canShare?.(data);
  const share = async data => {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err.name !== "AbortError") toast("Sharing didn't work here. Try Save picture.");
    }
  };
  const save = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const notYet = () => toast("One moment: your card is almost ready.");

  $("share-look").onclick = () => {
    look++;
    redraw();
  };
  $("share-main").onclick = () => {
    if (!file) return notYet();
    if (can({ files: [file], text: full })) return share({ files: [file], text: full });
    if (can({ files: [file] })) return share({ files: [file] });
    if (navigator.share) return share({ text: m.text, url: m.url });
    save();
    copyText(full, "Picture saved and message copied. Post it anywhere!", "Picture saved. Post it anywhere!");
  };
  for (const el of document.querySelectorAll(".share-app[data-picture]")) {
    el.addEventListener("click", e => {
      if (file && can({ files: [file] })) {
        e.preventDefault();
        const withText = !el.classList.contains("instagram") && can({ files: [file], text: full });
        share(withText ? { files: [file], text: full } : { files: [file] });
      } else if (el.tagName === "BUTTON") {   // Instagram has no link to fall back to
        if (!file) return notYet();
        save();
        toast("Picture saved. Add it to your Instagram story!");
      }
    });
  }
  $("share-save").onclick = () => (file ? save() : notYet());
  $("share-copy").onclick = () => copyText(full, "Message copied. Paste it anywhere!", "Copy isn't available here.");
  redraw();
}

/* ---------- drawing ---------- */

async function drawCard(canvas, r, look) {
  const theme = LOOKS[look % LOOKS.length];
  const line = r.persona.lines[look % r.persona.lines.length];
  const logo = await ready(`${r.nickname} ${r.title} ${r.quiz} ${line}`);
  const c = canvas.getContext("2d");
  c.fillStyle = theme.bg;
  c.fillRect(0, 0, W, H);
  c.fillStyle = "rgba(255, 255, 255, .12)";
  circle(c, 90, 120, 260);
  circle(c, W - 60, H - 120, 300);
  scatter(c, theme, seeded(`${r.nickname}:${look}`));

  // a white sticker, a little tilted
  c.save();
  c.translate(W / 2, 640);
  c.rotate(-0.025);
  c.shadowColor = "rgba(0, 0, 0, .25)";
  c.shadowBlur = 60;
  c.shadowOffsetY = 24;
  c.fillStyle = "#ffffff";
  rounded(c, -470, -530, 940, 1040, 56);
  c.fill();
  c.shadowColor = "transparent";

  // the brand, and the quiz
  if (logo) c.drawImage(logo, -420, -496, 76, 76);
  c.textBaseline = "middle";
  c.textAlign = "left";
  c.font = `700 56px ${DISPLAY}`;
  c.fillStyle = INK;
  c.fillText("quizly", -330, -456);
  c.fillStyle = FOREST;
  c.fillText(".", -334 + c.measureText("quizly").width, -456);
  c.textAlign = "center";
  c.font = `600 28px ${BODY}`;
  const quiz = clip(c, r.quiz, 330);
  const qw = c.measureText(quiz).width + 44;
  c.fillStyle = "#eff6df";
  rounded(c, 420 - qw, -484, qw, 56, 28);
  c.fill();
  c.fillStyle = FOREST;
  c.fillText(quiz, 420 - qw / 2, -455);

  // the avatar, with sparkles and the title's emoji pinned to it
  c.fillStyle = theme.tint;
  circle(c, 0, -262, 140);
  sparkle(c, -196, -330, 30, theme.bg === "#ffc21a" ? "#f4a349" : theme.bg);
  sparkle(c, 186, -352, 20, "#ffc21a");
  sparkle(c, -170, -160, 16, "#f4a349");
  c.font = `180px ${EMOJI}`;
  c.fillText(r.avatar, 0, -250);
  c.fillStyle = "#ffffff";
  circle(c, 112, -168, 54);
  c.lineWidth = 8;
  c.strokeStyle = theme.bg;
  c.stroke();
  c.font = `58px ${EMOJI}`;
  c.fillText(r.persona.emoji, 112, -163);

  // who, and what they turned out to be
  c.textBaseline = "alphabetic";
  c.fillStyle = FOREST;
  c.font = `700 30px ${BODY}`;
  c.letterSpacing = "3px";   // where a browser supports it
  c.fillText(clip(c, `${r.nickname} is ${r.persona.a ?? "a"}`.toUpperCase(), 800), 0, -62);
  c.letterSpacing = "0px";
  c.fillStyle = INK;
  fitFont(c, r.title, 860, 700, 100, 56, DISPLAY);
  c.fillText(r.title, 0, 28);
  c.fillStyle = MUTED;
  c.font = `500 36px ${BODY}`;
  wrap(c, line, 800).slice(0, 2).forEach((text, i) => c.fillText(text, 0, 92 + i * 46));

  // three numbers
  stats(r).forEach(([value, label], i) => {
    const x = -440 + i * 300;
    c.fillStyle = "#f7f8f2";
    rounded(c, x, 178, 280, 128, 28);
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = "#dfe5d9";
    c.stroke();
    c.fillStyle = INK;
    fitFont(c, value, 244, 700, 54, 30, DISPLAY);
    c.fillText(value, x + 140, 250);
    c.fillStyle = MUTED;
    c.font = `500 25px ${BODY}`;
    c.fillText(clip(c, label, 250), x + 140, 288);
  });

  // the run of answers: green for right, a quiet grey for the rest
  c.fillStyle = MUTED;
  c.font = `700 22px ${BODY}`;
  c.letterSpacing = "3px";
  c.fillText("MY ANSWERS", 0, 350);
  c.letterSpacing = "0px";
  const n = Math.max(1, r.history.length);
  const gap = n > 15 ? 6 : 10;
  const size = Math.min(50, Math.floor((880 - (n - 1) * gap) / n));
  const x0 = -(n * size + (n - 1) * gap) / 2;
  r.history.forEach((right, i) => {
    const x = x0 + i * (size + gap);
    c.fillStyle = right ? "#1f7f12" : "#e9ede4";
    rounded(c, x, 368, size, size, size * 0.28);
    c.fill();
    if (right) tick(c, x, 368, size);
  });

  pills(c, chips(r), theme.tint, 446);
  c.restore();

  // a dare, on the background
  c.textAlign = "center";
  c.fillStyle = theme.ink;
  fitFont(c, r.persona.dare ?? DARE, 900, 700, 58, 40, DISPLAY);
  c.fillText(r.persona.dare ?? DARE, W / 2, 1240);
  c.globalAlpha = 0.85;
  c.font = `500 28px ${BODY}`;
  c.fillText(`Played on quizly · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`, W / 2, 1296);
  c.globalAlpha = 1;
}

function stats(r) {
  const misses = r.played - r.correct;
  const place = r.tier === "top" ? [`${MEDALS[r.rank - 1] ? `${MEDALS[r.rank - 1]} ` : ""}${ordinal(r.rank)}`, `of ${plural(r.of, "player")}`]
    : r.tier === "half" ? ["Top half", `of ${plural(r.of, "player")}`]
    : misses ? [`🌱 ${misses}`, misses === 1 ? "new thing learned" : "new things learned"]
    : [`🔥 ${r.bestStreak}`, "in a row"];
  return [[`${r.correct}/${r.played}`, "right answers"], [fmt(r.score), "points"], place];
}

/* The badges won, or a little something for everyone else. */
function chips(r) {
  if (r.badges.length) return r.badges.slice(0, 3).map(b => `${b.emoji} ${b.title}`);
  const list = [];
  if (r.bestStreak >= 2) list.push(`🔥 ${r.bestStreak} in a row`);
  if (r.avgMs != null) list.push(`⏱️ ${(r.avgMs / 1000).toFixed(1)} s per right answer`);
  return list.length ? list : ["📚 Learning mode: on"];
}

function pills(c, items, fill, top) {
  c.font = `600 26px ${BODY}`;
  let list = items.map(text => clip(c, text, 836));
  const width = () => list.reduce((sum, text) => sum + c.measureText(text).width + 44, 0) + (list.length - 1) * 12;
  while (list.length > 1 && width() > 880) list = list.slice(0, -1);
  let x = -width() / 2;
  c.textBaseline = "middle";
  for (const text of list) {
    const w = c.measureText(text).width + 44;
    c.fillStyle = fill;
    rounded(c, x, top, w, 50, 25);
    c.fill();
    c.fillStyle = INK;
    c.fillText(text, x + w / 2, top + 26);
    x += w + 12;
  }
  c.textBaseline = "alphabetic";
}

function scatter(c, theme, rand) {
  const colors = CONFETTI.filter(color => color !== theme.bg);
  for (let i = 0; i < 70; i++) {
    const x = rand() * W;
    const y = rand() * H;
    if (y > 1170 && y < 1320 && x > 150 && x < 930) continue;   // leave the dare readable
    const size = 12 + rand() * 20;
    c.save();
    c.translate(x, y);
    c.rotate(rand() * Math.PI);
    const color = colors[Math.floor(rand() * colors.length)];
    const shape = rand();
    c.fillStyle = color;
    if (shape < 0.35) {
      circle(c, 0, 0, size / 2);
    } else if (shape < 0.75) {
      rounded(c, -size / 2, -size / 6, size, size / 3, size / 6);
      c.fill();
    } else {
      sparkle(c, 0, 0, size / 1.6, color);
    }
    c.restore();
  }
}

function circle(c, x, y, radius) {
  c.beginPath();
  c.arc(x, y, radius, 0, Math.PI * 2);
  c.fill();
}

function sparkle(c, x, y, radius, color) {
  c.fillStyle = color;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    const d = i % 2 ? radius * 0.3 : radius;
    c.lineTo(x + Math.sin(a) * d, y - Math.cos(a) * d);
  }
  c.closePath();
  c.fill();
}

function tick(c, x, y, size) {
  c.strokeStyle = "#ffffff";
  c.lineWidth = size * 0.12;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(x + size * 0.28, y + size * 0.52);
  c.lineTo(x + size * 0.44, y + size * 0.68);
  c.lineTo(x + size * 0.74, y + size * 0.34);
  c.stroke();
}

// arcTo rather than roundRect, which older phones lack
function rounded(c, x, y, w, h, radius) {
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function fitFont(c, text, max, weight, size, min, family) {
  c.font = `${weight} ${size}px ${family}`;
  while (size > min && c.measureText(text).width > max) {
    size -= 2;
    c.font = `${weight} ${size}px ${family}`;
  }
}

function wrap(c, text, max) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && c.measureText(next).width > max) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return line ? [...lines, line] : lines;
}

function clip(c, text, max) {
  if (c.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length && c.measureText(`${chars.join("")}…`).width > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/* The same numbers for the same seed, so a card keeps its look when redrawn. */
function seeded(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* The fonts the card is set in, and the logo, before the first stroke. */
let logo = null;
async function ready(text) {
  logo ??= fetch("/favicon.svg?v=2").then(res => res.text()).then(svg => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    // a size of its own lets every browser draw the SVG on a canvas
    img.src = `data:image/svg+xml;charset=utf-8,${enc(svg.replace("<svg ", '<svg width="152" height="152" '))}`;
  })).catch(() => null);
  if (document.fonts) {
    await Promise.all([
      document.fonts.load("700 100px 'Space Grotesk'", text),
      document.fonts.load("500 36px Inter", text)
    ]).catch(() => {});
  }
  return logo;
}
