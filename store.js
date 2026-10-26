/* Shared data layer for the player and the admin panel.
 *
 * Source of truth is questions.json. The admin panel saves edits to
 * localStorage, which overrides the file until it is reset or exported.
 * When you port this to Next.js, replace loadQuiz/saveQuiz with calls to
 * your API route; nothing else in the app touches storage.
 */

const STORAGE_KEY = "ai-quiz:data:v1";

export async function loadQuiz() {
  const local = readLocal();
  if (local) return local;
  const res = await fetch("questions.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load questions.json (" + res.status + ")");
  return normalise(await res.json());
}

export async function loadDefaults() {
  const res = await fetch("questions.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load questions.json (" + res.status + ")");
  return normalise(await res.json());
}

export function saveQuiz(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalise(data)));
}

export function clearLocal() {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasLocalEdits() {
  return readLocal() !== null;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalise(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/* Fills in anything a hand-edited file left out, so the UI never
 * has to defend against a missing field. */
export function normalise(data) {
  const d = data && typeof data === "object" ? data : {};
  const s = d.settings || {};
  return {
    version: d.version || 1,
    settings: {
      questionsPerRound: num(s.questionsPerRound, 5),
      secondsPerQuestion: num(s.secondsPerQuestion, 20),
      shuffleQuestions: s.shuffleQuestions !== false,
      shuffleOptions: s.shuffleOptions !== false,
      basePoints: num(s.basePoints, 500),
      speedBonus: num(s.speedBonus, 500)
    },
    questions: (Array.isArray(d.questions) ? d.questions : []).map((q, i) => ({
      id: q.id || "q" + String(i + 1).padStart(2, "0"),
      category: q.category || "General",
      difficulty: q.difficulty || "medium",
      prompt: q.prompt || "",
      options: Array.isArray(q.options) ? q.options.slice(0, 6) : ["", ""],
      answer: num(q.answer, 0),
      explanation: q.explanation || ""
    }))
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function scoreFor(correct, elapsedMs, limitMs, settings) {
  if (!correct) return 0;
  const left = Math.max(0, limitMs - Math.min(elapsedMs, limitMs));
  return Math.round(settings.basePoints + settings.speedBonus * (left / limitMs));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
