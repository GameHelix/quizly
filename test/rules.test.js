/* The pure rules: scoring, streaks, validation, nicknames, fair timing,
 * awards and CSV escaping. No database needed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRound, computeAwards, fairElapsed, LATENCY_MS, ranked } from "../server/play.js";
import { csvCell } from "../server/results.js";
import {
  cleanNickname, normalise, normaliseQuestion, normaliseSettings, questionProblem, scoreFor, streakBonusFor
} from "../shared/quiz.js";

const settings = normaliseSettings({});

test("a correct answer is worth base points plus a share of the speed bonus", () => {
  assert.equal(scoreFor(true, 0, 20000, settings), 1000);
  assert.equal(scoreFor(true, 10000, 20000, settings), 750);
  assert.equal(scoreFor(true, 20000, 20000, settings), 500);
  assert.equal(scoreFor(true, 99999, 20000, settings), 500);
  assert.equal(scoreFor(false, 0, 20000, settings), 0);
});

test("streak bonus grows with the run and stops at five steps", () => {
  assert.deepEqual([0, 1, 2, 5, 9].map(s => streakBonusFor(s, settings)), [0, 100, 200, 500, 500]);
  assert.equal(streakBonusFor(3, { ...settings, streakBonus: 0 }), 0);
});

test("settings are filled in and clamped", () => {
  assert.deepEqual(normaliseSettings({ questionsPerRound: 500, secondsPerQuestion: "2", basePoints: -5 }), {
    questionsPerRound: 50, secondsPerQuestion: 5, shuffleQuestions: true, shuffleOptions: true,
    basePoints: 0, speedBonus: 500, streakBonus: 100
  });
});

test("questions are checked before they are saved", () => {
  const q = normaliseQuestion({ id: "q1", prompt: "Which?", options: ["A", "B"], answer: 1 });
  assert.equal(questionProblem(q), null);
  assert.match(questionProblem({ ...q, answer: 2 }), /correct/);
  assert.match(questionProblem({ ...q, options: ["A"] }), /two options/);
  assert.match(questionProblem({ ...q, options: ["A", ""] }), /blank/);
  assert.match(questionProblem({ ...q, prompt: "" }), /empty/);
  assert.match(questionProblem({ ...q, id: "has space" }), /id/);
  assert.match(questionProblem({ ...q, prompt: "x".repeat(401) }), /400/);
  assert.equal(normaliseQuestion({ options: ["1", "2", "3", "4", "5", "6", "7"] }).options.length, 6);
  assert.equal(normalise({ title: "  My\nquiz  " }).title, "My quiz");
});

test("nicknames are trimmed, folded and stripped of control and direction characters", () => {
  assert.equal(cleanNickname("  Aysel   M.  "), "Aysel M.");
  assert.equal(cleanNickname("evil‮esrever"), "evilesrever");
  assert.equal(cleanNickname("a\u0000b​c"), "abc");
  assert.equal(cleanNickname("🦊".repeat(30)), "🦊".repeat(20));
  assert.equal(cleanNickname("\n\t "), "");
  assert.equal(cleanNickname(42), "");
  assert.equal(cleanNickname("Q" + "\u0301".repeat(10)), "Q\u0301\u0301", "no towers of combining marks");
  assert.equal(cleanNickname("Şəhla Çağrı"), "Şəhla Çağrı", "Azerbaijani letters survive");
});

test("a phone may claim back network delay, but no more than the allowance", () => {
  assert.equal(fairElapsed(5000, 4600, 20000), 4600);
  assert.equal(fairElapsed(5000, 4200, 20000), 5000 - LATENCY_MS, "a claim beyond the allowance is cut back to it");
  assert.equal(fairElapsed(5000, 0, 20000), 5000 - LATENCY_MS, "a phone claiming to be instant is held to the allowance");
  assert.equal(fairElapsed(5000, 9000, 20000), 5000, "a phone cannot make itself slower than the server saw");
  assert.equal(fairElapsed(5000, undefined, 20000), 5000);
  assert.equal(fairElapsed(25000, 25000, 20000), 20000);
  assert.equal(fairElapsed(-300, -300, 20000), 0);
});

test("ranking: score, then speed on correct answers, then who joined first", () => {
  const players = [
    { id: "a", score: 900, correct_ms: 3000, joined_at: 1 },
    { id: "b", score: 900, correct_ms: 2000, joined_at: 2 },
    { id: "c", score: 1200, correct_ms: 9000, joined_at: 3 },
    { id: "d", score: 900, correct_ms: 2000, joined_at: 0 }
  ];
  assert.deepEqual(ranked(players).map(p => p.id), ["c", "d", "b", "a"]);
});

test("awards go to the fastest, the longest streak and the biggest climb", () => {
  const p = (id, score, correct_count, correct_ms, best_streak, half) =>
    ({ id, nickname: id, avatar: "🦊", score, correct_count, correct_ms, best_streak, joined_at: 0, ranks: { 1: half } });
  const players = [
    p("steady", 4000, 4, 12000, 4, 1),
    p("quick", 3000, 3, 3000, 2, 2),
    p("late", 2500, 3, 9000, 3, 6),
    p("x", 100, 1, 100, 1, 3), p("y", 50, 1, 100, 1, 4), p("z", 10, 1, 100, 1, 5)
  ];
  const awards = Object.fromEntries(computeAwards(players, 4).map(a => [a.key, a.nickname]));
  assert.deepEqual(awards, { fastest: "quick", streak: "steady", comeback: "late" });
  assert.deepEqual(computeAwards([], 0), []);
});

test("a round follows the settings and keeps the answer pointing at the right option", () => {
  const questions = Array.from({ length: 8 }, (_, i) => ({
    id: `q${i}`, category: i < 4 ? "A" : "B", difficulty: "easy", prompt: `Q${i}`,
    options: ["right", "w1", "w2", "w3"], answer: 0, explanation: ""
  }));
  const round = buildRound(questions, { ...settings, questionsPerRound: 3 }, "B");
  assert.equal(round.length, 3);
  for (const q of round) {
    assert.equal(q.category, "B");
    assert.equal(q.options[q.answer], "right");
  }
  const fixed = buildRound(questions, { ...settings, shuffleQuestions: false, shuffleOptions: false, questionsPerRound: 2 });
  assert.deepEqual(fixed.map(q => q.id), ["q0", "q1"]);
  assert.equal(fixed[0].answer, 0);
});

test("CSV cells are quoted and cannot run as formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell(42), "42");
});
