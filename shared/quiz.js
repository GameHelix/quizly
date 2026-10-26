/* Quiz rules shared by the server and the browser: the bank's shape,
 * validation, shuffling and scoring. Pure functions only — no storage and
 * no DOM — so both sides import this same file. The server serves it to
 * the browser at /shared/quiz.js.
 */

export const LETTERS = "ABCDEF";
const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const DIFFICULTIES = ["easy", "medium", "hard"];
const MAX_STREAK_STEPS = 5;
export const NICKNAME_MAX = 20;
const TITLE_MAX = 80;

export const AVATARS = [
  "🦊", "🐼", "🐯", "🦁", "🐸", "🐙", "🦄", "🐝", "🐧", "🦉", "🐨", "🐵",
  "🐳", "🦖", "🐢", "🦩", "🐞", "🦔", "🐶", "🐱", "🐰", "🐻", "🐮", "🐷"
];

/* [min, max] for every numeric setting. The admin form uses the same numbers. */
const SETTING_LIMITS = {
  questionsPerRound: [1, 50],
  secondsPerQuestion: [5, 120],
  basePoints: [0, 5000],
  speedBonus: [0, 5000],
  streakBonus: [0, 1000]
};

const TEXT_LIMITS = { prompt: 400, option: 160, explanation: 1000, category: 40 };

/* Fills in anything a hand-edited file left out, so the rest of the app
 * never has to defend against a missing field. A quiz file is
 * { version, title, settings, questions }; data/questions.json is one. */
export function normalise(data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    version: d.version || 1,
    title: cleanTitle(d.title),
    settings: normaliseSettings(d.settings),
    questions: (Array.isArray(d.questions) ? d.questions : []).map(normaliseQuestion)
  };
}

export function normaliseSettings(s) {
  const src = s && typeof s === "object" ? s : {};
  const pick = (key, fallback) => clamp(Math.round(num(src[key], fallback)), SETTING_LIMITS[key]);
  return {
    questionsPerRound: pick("questionsPerRound", 5),
    secondsPerQuestion: pick("secondsPerQuestion", 20),
    shuffleQuestions: src.shuffleQuestions !== false,
    shuffleOptions: src.shuffleOptions !== false,
    basePoints: pick("basePoints", 500),
    speedBonus: pick("speedBonus", 500),
    streakBonus: pick("streakBonus", 100)
  };
}

export function normaliseQuestion(q, i = 0) {
  const src = q && typeof q === "object" ? q : {};
  return {
    id: text(src.id) || "q" + String(i + 1).padStart(2, "0"),
    category: text(src.category) || "General",
    difficulty: DIFFICULTIES.includes(src.difficulty) ? src.difficulty : "medium",
    prompt: text(src.prompt),
    options: Array.isArray(src.options) ? src.options.slice(0, MAX_OPTIONS).map(text) : ["", ""],
    answer: num(src.answer, 0),
    explanation: text(src.explanation)
  };
}

/* What is wrong with a normalised question, in words for the admin, or null. */
export function questionProblem(q) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(q.id)) return "The id may only use letters, digits, - and _ (40 at most)";
  if (!q.prompt) return "The question text is empty";
  if (q.prompt.length > TEXT_LIMITS.prompt) return `The question is over ${TEXT_LIMITS.prompt} characters`;
  if (q.options.length < MIN_OPTIONS) return "At least two options are needed";
  if (q.options.some(o => !o)) return "One of the options is blank";
  if (q.options.some(o => o.length > TEXT_LIMITS.option)) return `An option is over ${TEXT_LIMITS.option} characters`;
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) return "Mark which option is correct";
  if (q.category.length > TEXT_LIMITS.category) return `The category is over ${TEXT_LIMITS.category} characters`;
  if (q.explanation.length > TEXT_LIMITS.explanation) return `The explanation is over ${TEXT_LIMITS.explanation} characters`;
  return null;
}

/* Trims, folds runs of whitespace and drops control and direction-override
 * characters. Returns "" when nothing usable is left. */
export function cleanNickname(raw) {
  return cleanLine(raw, NICKNAME_MAX);
}

export function cleanTitle(raw) {
  return cleanLine(raw, TITLE_MAX);
}

function cleanLine(raw, max) {
  if (typeof raw !== "string") return "";
  // Whitespace first, so a newline becomes a space rather than vanishing with the
  // control characters; then at most two combining marks per letter, so nobody's
  // name towers over the others on the projector.
  const s = raw.normalize("NFC").replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/(\p{M}{2})\p{M}+/gu, "$1").trim();
  return [...s].slice(0, max).join("");
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* A correct answer is worth basePoints plus a share of speedBonus for the
 * time left on the clock: basePoints + speedBonus at once, basePoints at the buzzer. */
export function scoreFor(correct, elapsedMs, limitMs, settings) {
  if (!correct) return 0;
  const left = Math.max(0, limitMs - Math.min(elapsedMs, limitMs));
  return Math.round(settings.basePoints + settings.speedBonus * (left / limitMs));
}

/* Extra points for a correct answer that continues a run: streakBonus for
 * the second in a row, twice that for the third, capped at MAX_STREAK_STEPS. */
export function streakBonusFor(streakBefore, settings) {
  return settings.streakBonus * Math.min(Math.max(0, streakBefore), MAX_STREAK_STEPS);
}

function text(v) {
  return v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, [min, max]) {
  return Math.min(max, Math.max(min, n));
}
