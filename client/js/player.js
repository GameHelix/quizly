import { loadQuiz, shuffle, scoreFor, escapeHtml } from "../../shared/quiz.js";

const app = document.getElementById("app");

let quiz = null;      // { settings, questions }
let round = [];       // questions for this round, options already shuffled
let idx = 0;
let score = 0;
let results = [];     // { q, picked, correct, points }
let askedAt = 0;
let ticker = null;

init();

async function init() {
  try {
    quiz = await loadQuiz();
  } catch (err) {
    app.innerHTML = `
      <p class="eyebrow">AI Quiz</p>
      <h1>Could not load the questions</h1>
      <p>${escapeHtml(err.message)}</p>
      <p class="note">If you opened this file directly from disk, the browser blocks the fetch.
      Serve the folder instead, for example <code>npx serve .</code> or <code>python3 -m http.server</code>,
      then open the address it prints.</p>`;
    return;
  }
  renderStart();
}

function prepareRound() {
  const s = quiz.settings;
  let pool = s.shuffleQuestions ? shuffle(quiz.questions) : quiz.questions.slice();
  pool = pool.slice(0, Math.min(s.questionsPerRound, pool.length));
  round = pool.map(q => {
    if (!s.shuffleOptions) return { ...q, order: q.options.map((_, i) => i) };
    const order = shuffle(q.options.map((_, i) => i));
    return { ...q, order };
  });
  idx = 0;
  score = 0;
  results = [];
}

function renderStart() {
  const s = quiz.settings;
  const total = Math.min(s.questionsPerRound, quiz.questions.length);
  app.innerHTML = `
    <p class="eyebrow">AI Quiz</p>
    <h1>How well do you know this?</h1>
    <div class="card">
      <div class="row" style="margin-bottom:16px">
        <span class="sub">${total} question${total === 1 ? "" : "s"}</span>
        <span class="sub">${s.secondsPerQuestion}s each</span>
      </div>
      <p style="margin:0">Faster correct answers score more. You will see why each answer is right as you go.</p>
    </div>
    <div class="bar" style="margin-top:24px">
      <button id="go">Start</button>
      <a class="sub" href="admin.html" style="color:var(--muted)">Admin panel</a>
    </div>`;
  document.getElementById("go").onclick = () => { prepareRound(); renderQuestion(); };
}

function renderQuestion() {
  const item = round[idx];
  const limit = quiz.settings.secondsPerQuestion * 1000;
  askedAt = Date.now();

  const opts = item.order.map((origIndex, slot) => `
    <button class="opt" data-orig="${origIndex}">
      <span class="k">${"ABCDEF"[slot]}</span><span>${escapeHtml(item.options[origIndex])}</span>
    </button>`).join("");

  app.innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <span class="pill">Question ${idx + 1} of ${round.length}</span>
      <span class="pill on">${score} pts</span>
    </div>
    <h2>${escapeHtml(item.prompt)}</h2>
    <div class="timer"><span id="bar"></span></div>
    <p class="note" id="left" style="margin-top:6px"></p>
    <div class="opts">${opts}</div>`;

  app.querySelectorAll(".opt").forEach(b => {
    b.onclick = () => answer(Number(b.dataset.orig));
  });

  const bar = document.getElementById("bar");
  const left = document.getElementById("left");
  clearInterval(ticker);
  ticker = setInterval(() => {
    const elapsed = Date.now() - askedAt;
    const frac = Math.max(0, 1 - elapsed / limit);
    bar.style.width = (frac * 100).toFixed(1) + "%";
    left.textContent = Math.ceil(frac * quiz.settings.secondsPerQuestion) + "s left";
    if (frac <= 0) answer(null);
  }, 100);
}

function answer(picked) {
  clearInterval(ticker);
  const item = round[idx];
  const limit = quiz.settings.secondsPerQuestion * 1000;
  const correct = picked === item.answer;
  const gained = scoreFor(correct, Date.now() - askedAt, limit, quiz.settings);
  score += gained;
  results.push({ q: item, picked, correct, points: gained });
  renderReveal();
}

function renderReveal() {
  const r = results[results.length - 1];
  const item = r.q;
  const last = idx === round.length - 1;

  const opts = item.order.map((origIndex, slot) => {
    let cls = "opt";
    if (origIndex === item.answer) cls += " right";
    else if (origIndex === r.picked) cls += " wrong";
    return `<button class="${cls}" disabled>
      <span class="k">${"ABCDEF"[slot]}</span><span>${escapeHtml(item.options[origIndex])}</span>
    </button>`;
  }).join("");

  const verdict = r.picked === null
    ? "Out of time."
    : r.correct ? `Correct. +${r.points}` : "Not this time.";

  app.innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <span class="pill">Question ${idx + 1} of ${round.length}</span>
      <span class="pill on">${score} pts</span>
    </div>
    <h2>${escapeHtml(item.prompt)}</h2>
    <div class="opts">${opts}</div>
    <div class="card" style="margin-top:20px">
      <h3 style="color:${r.correct ? "var(--good)" : "var(--amber)"}">${verdict}</h3>
      <p style="margin:0">${escapeHtml(item.explanation)}</p>
    </div>
    <div class="bar" style="margin-top:24px">
      <button id="next">${last ? "See your score" : "Next question"}</button>
    </div>`;

  document.getElementById("next").onclick = () => {
    if (last) return renderFinal();
    idx += 1;
    renderQuestion();
  };
}

function renderFinal() {
  const right = results.filter(r => r.correct).length;
  const rows = results.map((r, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td>${escapeHtml(r.q.prompt)}<br>
        <span class="sub">${r.correct ? "Correct" : "Answer: " + escapeHtml(r.q.options[r.q.answer])}</span></td>
      <td class="num">${r.points}</td>
    </tr>`).join("");

  app.innerHTML = `
    <p class="eyebrow">Result</p>
    <h1>${score} points</h1>
    <p class="sub" style="margin-bottom:28px">${right} of ${results.length} correct.</p>
    <table>
      <tr><th></th><th>Question</th><th style="text-align:right">Points</th></tr>
      ${rows}
    </table>
    <div class="bar" style="margin-top:28px">
      <button id="again">Play again</button>
      <button class="quiet" id="home">Back to start</button>
    </div>`;

  document.getElementById("again").onclick = () => { prepareRound(); renderQuestion(); };
  document.getElementById("home").onclick = renderStart;
}
