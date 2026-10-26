/* The admin panel: the quiz library and the results of games played.
 * Every change is saved to the database as it is made; nothing is kept in
 * the browser.
 */

import { DIFFICULTIES, LETTERS, MAX_OPTIONS, normalise } from "/shared/quiz.js";
import { footer, icon, siteHeader } from "./design.js";
import { $, adminGate, api, askDialog, escapeHtml, fmt, signOut, toast } from "./ui.js";

const app = $("app");
let quizzes = [];          // the library: id, title, size, categories
let quiz = null;           // the selected quiz in full
let editingId = null;      // id being edited, or "__new__", or null

await adminGate(app, "the admin panel");
app.replaceChildren($("admin-ui").content.cloneNode(true));
app.insertAdjacentHTML("afterbegin", siteHeader("admin"));
app.insertAdjacentHTML("beforeend", footer());
app.querySelectorAll("[data-icon]").forEach(el => {
  if (el.classList.contains("stat-icon")) el.innerHTML = icon(el.dataset.icon);
  else el.outerHTML = icon(el.dataset.icon);
});
wire();
try { await loadQuizzes(); } catch (err) { $("list").innerHTML = `<div class="studio-error" role="alert">${escapeHtml(err.message)} <button class="quiet" id="retry-library">Try again</button></div>`; $("retry-library").onclick = () => location.reload(); }

function wire() {
  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("nav.tabs button").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); x.tabIndex = x === b ? 0 : -1; });
      ["questions", "settings", "data", "results"].forEach(t =>
        $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
      if (b.dataset.tab === "results") loadGames();
    };
    b.onkeydown = e => {
      const tabs = [...document.querySelectorAll('nav.tabs button')];
      const index = tabs.indexOf(b);
      const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (next !== null) { e.preventDefault(); tabs[next].click(); tabs[next].focus(); }
    };
  });
  $("signout").onclick = signOut;
  $("quiz").onchange = () => loadQuiz($("quiz").value);
  $("new-quiz").onclick = newQuiz;
  $("rename-quiz").onclick = renameQuiz;
  $("delete-quiz").onclick = deleteQuiz;
  $("add").onclick = () => { editingId = "__new__"; renderEditor(); };
  $("filter").onchange = renderList;
  $("search").oninput = renderList;
  $("refresh-results").onclick = loadGames;
  ["s-base", "s-bonus", "s-streak"].forEach(id => { $(id).oninput = scoringPreview; });
  $("save-settings").onclick = saveSettings;
  $("export").onclick = exportQuiz;
  $("import-new").onchange = e => importFile(e, "new");
  $("import-replace").onchange = e => importFile(e, "replace");
}

/* ---------- the library ---------- */

async function loadQuizzes(selectId) {
  quizzes = await api("/api/admin/quizzes");
  $("stat-quizzes").textContent = fmt(quizzes.length);
  const sel = $("quiz");
  sel.innerHTML = quizzes.map(q =>
    `<option value="${escapeHtml(q.id)}">${escapeHtml(q.title)} · ${q.questions} question${q.questions === 1 ? "" : "s"}</option>`).join("");
  const has = quizzes.length > 0;
  sel.disabled = !has;
  for (const id of ["rename-quiz", "delete-quiz", "add", "save-settings", "export", "import-replace"]) $(id).disabled = !has;
  if (!has) {
    quiz = null;
    sel.innerHTML = `<option>No quizzes yet</option>`;
    $("list").innerHTML = `<div class="empty-state">${icon("book")}<h3>A fresh start. A great first question.</h3><p>Choose New quiz to start creating, or bring a quiz file in with Import &amp; export.</p></div>`;
    $("stat-questions").textContent = "0";
    $("stat-categories").textContent = "0";
    $("count").textContent = "";
    return;
  }
  let remembered = null;
  try {
    remembered = localStorage.getItem("quizly:quiz");
  } catch {
    // storage blocked
  }
  const pick = [selectId, quiz?.id, remembered].find(id => id && quizzes.some(q => q.id === id)) ?? quizzes[0].id;
  sel.value = pick;
  await loadQuiz(pick);
}

async function loadQuiz(id) {
  quiz = await api(`/api/admin/quizzes/${encodeURIComponent(id)}`);
  try {
    localStorage.setItem("quizly:quiz", quiz.id);
  } catch {
    // not remembered
  }
  editingId = null;
  $("search").value = "";
  $("filter").value = "";
  $("editor").classList.add("hidden");
  fillSettings();
  renderList();
}

async function newQuiz() {
  const title = await askDialog({ title: "What's your quiz called?", message: "Give your next great game a name.", value: "", confirmLabel: "Create quiz" });
  if (!title?.trim()) return;
  try {
    const created = await api("/api/admin/quizzes", { method: "POST", body: { title } });
    await loadQuizzes(created.id);
    toast("Quiz created — add its questions");
  } catch (err) {
    toast(err.message);
  }
}

async function renameQuiz() {
  const title = await askDialog({ title: "A fresh name for your quiz", value: quiz.title, confirmLabel: "Save name" });
  if (!title?.trim() || title === quiz.title) return;
  try {
    await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}`, { method: "PATCH", body: { title } });
    await loadQuizzes(quiz.id);
    toast("Renamed");
  } catch (err) {
    toast(err.message);
  }
}

async function deleteQuiz() {
  if (!await askDialog({ title: "Delete this quiz?", message: `“${quiz.title}” and its ${quiz.questions.length} questions will be deleted. Past game results will stay.`, confirmLabel: "Delete quiz", danger: true })) return;
  try {
    await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}`, { method: "DELETE" });
    quiz = null;
    await loadQuizzes();
    toast("Quiz deleted");
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- questions ---------- */

function categories() {
  return [...new Set(quiz.questions.map(q => q.category))].sort();
}

function renderList() {
  if (!quiz) return;
  const sel = $("filter");
  const current = categories().includes(sel.value) ? sel.value : "";
  sel.innerHTML = `<option value="">All categories</option>` +
    categories().map(c => `<option${c === current ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");

  const search = $("search").value.trim().toLocaleLowerCase();
  const shown = quiz.questions.filter(q => (!current || q.category === current) && (!search || [q.prompt, q.category, q.id, ...q.options].some(s => s.toLocaleLowerCase().includes(search))));
  $("count").textContent = `${shown.length} of ${quiz.questions.length}`;
  $("stat-questions").textContent = fmt(quiz.questions.length);
  $("stat-categories").textContent = fmt(categories().length);

  $("list").innerHTML = shown.length ? shown.map(q => `
    <div class="qitem">
      <div class="head">
        <div style="flex:1">
          <div class="meta">
            <span class="pill">${escapeHtml(q.category)}</span>
            <span class="pill" data-level="${escapeHtml(q.difficulty)}">${escapeHtml(q.difficulty)}</span>
            <span class="question-number">#${String(quiz.questions.indexOf(q) + 1).padStart(2, "0")}</span>
          </div>
          <p class="prompt">${escapeHtml(q.prompt)}</p>
          <p class="sub answer-label" style="margin:0">${icon("check")} ${escapeHtml(q.options[q.answer] ?? "—")}</p>
        </div>
        <div class="acts">
          <button class="ghost" data-edit="${escapeHtml(q.id)}">Edit</button>
          <button class="danger" data-del="${escapeHtml(q.id)}">Delete</button>
        </div>
      </div>
    </div>`).join("") : `<div class="empty-state">${icon("search")}<h3>${quiz.questions.length ? "No matches this time." : "Your first question starts it all."}</h3><p>${quiz.questions.length ? "Try a different search or choose All categories." : "Choose Add question to get your quiz going."}</p></div>`;

  $("list").querySelectorAll("[data-edit]").forEach(b => {
    b.onclick = () => { editingId = b.dataset.edit; renderEditor(); };
  });
  $("list").querySelectorAll("[data-del]").forEach(b => {
    b.onclick = async () => {
      const q = quiz.questions.find(x => x.id === b.dataset.del);
      if (!await askDialog({ title: "Delete this question?", message: q.prompt, confirmLabel: "Delete question", danger: true })) return;
      try {
        await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}/questions/${encodeURIComponent(q.id)}`, { method: "DELETE" });
        quiz.questions = quiz.questions.filter(x => x.id !== q.id);
        if (editingId === q.id) { editingId = null; $("editor").classList.add("hidden"); }
        renderList();
        refreshTitles();
        toast("Question deleted");
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function blankQuestion() {
  const n = quiz.questions.length + 1;
  return {
    id: "q" + String(n).padStart(2, "0") + "-" + Math.random().toString(36).slice(2, 6),
    category: categories()[0] || "General", difficulty: "medium",
    prompt: "", options: ["", "", "", ""], answer: 0, explanation: ""
  };
}

function renderEditor() {
  const editor = $("editor");
  const q = editingId === "__new__" ? blankQuestion() : quiz.questions.find(x => x.id === editingId);
  if (!q) { editor.classList.add("hidden"); return; }

  editor.classList.remove("hidden");
  editor.innerHTML = `
    <h3>${editingId === "__new__" ? "New question" : "Editing " + escapeHtml(q.id)}</h3>
    <div class="field">
      <label for="e-prompt">Question</label>
      <textarea id="e-prompt" maxlength="400">${escapeHtml(q.prompt)}</textarea>
    </div>
    <div class="grid2">
      <div class="field">
        <label for="e-cat">Category</label>
        <input id="e-cat" maxlength="40" value="${escapeHtml(q.category)}" list="e-cats">
        <datalist id="e-cats">${categories().map(c => `<option value="${escapeHtml(c)}">`).join("")}</datalist>
      </div>
      <div class="field">
        <label for="e-diff">Difficulty</label>
        <select id="e-diff">
          ${DIFFICULTIES.map(d => `<option${d === q.difficulty ? " selected" : ""}>${d}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Options — select the correct one</label>
      <div id="e-opts">
        ${q.options.map((o, i) => optRow(o, i, i === q.answer)).join("")}
      </div>
      <button class="quiet" id="e-addopt" style="padding:8px 14px;font-size:13px">Add option</button>
    </div>
    <div class="field">
      <label for="e-why">Explanation shown after the reveal</label>
      <textarea id="e-why" maxlength="1000">${escapeHtml(q.explanation)}</textarea>
    </div>
    <div class="bar">
      <button id="e-save">Save question</button>
      <button class="quiet" id="e-cancel">Cancel</button>
    </div>`;

  $("e-addopt").onclick = () => {
    const n = $("e-opts").children.length;
    if (n >= MAX_OPTIONS) return toast(`${MAX_OPTIONS} options is the most a question can have`);
    $("e-opts").insertAdjacentHTML("beforeend", optRow("", n, false));
  };
  $("e-cancel").onclick = () => { editingId = null; editor.classList.add("hidden"); $("add").focus(); };
  $("e-save").onclick = () => saveQuestion(q);
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("e-prompt").focus({ preventScroll: true });
}

function optRow(value, i, checked) {
  return `<div class="optrow">
    <input type="radio" name="correct" value="${i}"${checked ? " checked" : ""} aria-label="Option ${LETTERS[i]} is correct">
    <input type="text" class="opt-text" maxlength="160" value="${escapeHtml(value)}" placeholder="Option ${LETTERS[i]}" aria-label="Answer option ${LETTERS[i]}">
  </div>`;
}

async function saveQuestion(q) {
  const editor = $("editor");
  const rows = [...editor.querySelectorAll(".optrow")];
  const checked = editor.querySelector('input[name="correct"]:checked');
  const prompt = $("e-prompt").value.trim();
  if (!prompt) return toast("The question text is empty");
  if (!checked) return toast("Mark which option is correct");
  // Blank options are dropped; the answer follows its option to its new position.
  const kept = rows.map((r, i) => ({ i, text: r.querySelector(".opt-text").value.trim() })).filter(o => o.text);
  if (kept.length < 2) return toast("At least two options are needed");
  const answer = kept.findIndex(o => o.i === Number(checked.value));
  if (answer < 0) return toast("The option marked correct is blank");

  const updated = {
    id: q.id,
    category: $("e-cat").value.trim() || "General",
    difficulty: $("e-diff").value,
    prompt,
    options: kept.map(o => o.text),
    answer,
    explanation: $("e-why").value.trim()
  };
  const save = $("e-save");
  save.disabled = true;
  save.textContent = "Saving question…";
  try {
    const saved = await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}/questions/${encodeURIComponent(q.id)}`,
      { method: "PUT", body: updated });
    const at = quiz.questions.findIndex(x => x.id === saved.id);
    if (at >= 0) quiz.questions[at] = saved;
    else quiz.questions.push(saved);
    editingId = null;
    editor.classList.add("hidden");
    renderList();
    refreshTitles();
    $("list").querySelector(`[data-edit="${CSS.escape(saved.id)}"]`)?.focus();
    toast("Question saved");
  } catch (err) {
    toast(err.message);
  } finally {
    if (save.isConnected) { save.disabled = false; save.textContent = "Save question"; }
  }
}

/* The question counts in the quiz picker. */
function refreshTitles() {
  const option = [...$("quiz").options].find(o => o.value === quiz.id);
  if (option) option.textContent = `${quiz.title} · ${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"}`;
  const item = quizzes.find(q => q.id === quiz.id);
  if (item) item.questions = quiz.questions.length;
}

/* ---------- settings ---------- */

function fillSettings() {
  const s = quiz.settings;
  $("s-count").value = s.questionsPerRound;
  $("s-secs").value = s.secondsPerQuestion;
  $("s-base").value = s.basePoints;
  $("s-bonus").value = s.speedBonus;
  $("s-streak").value = s.streakBonus;
  $("s-shq").value = s.shuffleQuestions ? "yes" : "no";
  $("s-sho").value = s.shuffleOptions ? "yes" : "no";
  scoringPreview();
}

function scoringPreview() {
  const base = Math.max(0, Math.min(5000, Number($("s-base").value) || 0));
  const speed = Math.max(0, Math.min(5000, Number($("s-bonus").value) || 0));
  const streak = Math.max(0, Math.min(1000, Number($("s-streak").value) || 0));
  $("scoring-preview").textContent = base === base + speed ? fmt(base) : `${fmt(base)}–${fmt(base + speed)}`;
  $("streak-preview").textContent = streak ? `Keep a streak going for +${fmt(streak)} more per consecutive correct answer, up to +${fmt(streak * 5)}.` : "Streak bonuses are off. Correct answers still build your streak.";
}

async function saveSettings() {
  $("save-settings").disabled = true;
  $("save-settings").textContent = "Saving settings…";
  try {
    const { settings } = await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}/settings`, {
      method: "PUT",
      body: {
        questionsPerRound: Number($("s-count").value),
        secondsPerQuestion: Number($("s-secs").value),
        basePoints: Number($("s-base").value),
        speedBonus: Number($("s-bonus").value),
        streakBonus: Number($("s-streak").value),
        shuffleQuestions: $("s-shq").value === "yes",
        shuffleOptions: $("s-sho").value === "yes"
      }
    });
    quiz.settings = settings;
    fillSettings();   // shows any value the server brought back into range
    toast("Settings saved");
  } catch (err) {
    toast(err.message);
  } finally {
    $("save-settings").disabled = false;
    $("save-settings").textContent = "Save game settings";
  }
}

/* ---------- import and export ---------- */

function exportQuiz() {
  const { id, ...file } = quiz;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (quiz.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quiz") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(ev, mode) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file is not valid JSON");
  }
  const preview = normalise(data);
  try {
    if (mode === "new") {
      const created = await api("/api/admin/quizzes", { method: "POST", body: { data } });
      await loadQuizzes(created.id);
      toast(`Imported "${created.title}" with ${created.questions.length} questions`);
    } else {
      if (!await askDialog({ title: "Replace this quiz's content?", message: `Replace the ${quiz.questions.length} questions in “${quiz.title}” with the ${preview.questions.length} in ${file.name}? This also replaces the game settings.`, confirmLabel: "Replace quiz", danger: true })) return;
      await api(`/api/admin/quizzes/${encodeURIComponent(quiz.id)}/import`, { method: "PUT", body: data });
      await loadQuizzes(quiz.id);
      toast(`Replaced with ${preview.questions.length} questions`);
    }
  } catch (err) {
    toast("Import failed: " + err.message);
  }
}

/* ---------- results ---------- */

async function loadGames() {
  $("game").classList.add("hidden");
  const box = $("games");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="sub waiting-dots">Loading games</p>`;
  let games;
  try {
    games = await api("/api/admin/games");
  } catch (err) {
    box.innerHTML = `<p class="sub">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!games.length) {
    box.innerHTML = `<div class="empty-state">${icon("trophy")}<h3>The next great rivalry is waiting.</h3><p>Host a game and its standings, player awards, and question results will appear here.</p><a class="btn" href="/host" style="margin-top:24px">Host your first game ${icon("arrow")}</a></div>`;
    return;
  }
  box.innerHTML = games.map(g => `
    <div class="qitem link" data-game="${escapeHtml(g.id)}" tabindex="0" role="button">
      <div class="head">
        <div style="flex:1">
          <div class="meta">
            <span class="pill">${escapeHtml(when(g.createdAt))}</span>
            <span class="pill">PIN ${escapeHtml(g.pin)}</span>
            <span class="pill${g.status === "running" || g.status === "lobby" ? " on" : ""}">${escapeHtml(g.status)}</span>
          </div>
          <p class="prompt">${escapeHtml(g.title)}</p>
          <p class="sub" style="margin:0">${fmt(g.players)} player${g.players === 1 ? "" : "s"} · ${g.played} of ${g.questions} questions played</p>
        </div>
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-game]").forEach(el => {
    el.onclick = () => showGame(el.dataset.game);
    el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showGame(el.dataset.game); } };
  });
}

async function showGame(id) {
  let r;
  try {
    r = await api(`/api/admin/games/${encodeURIComponent(id)}`);
  } catch (err) {
    return toast(err.message);
  }
  $("games").classList.add("hidden");
  const box = $("game");
  box.classList.remove("hidden");
  const secs = ms => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  box.innerHTML = `
    <div class="bar" style="margin-bottom:16px">
      <button class="quiet" id="back">← All games</button>
      <a class="btn ghost" href="/api/admin/games/${encodeURIComponent(r.id)}/results.csv">Download CSV</a>
      ${r.status === "running" || r.status === "lobby" ? "" : `<button class="danger" id="delete-game">Delete game</button>`}
    </div>
    <h2>${escapeHtml(r.title)}</h2>
    <p class="sub">${escapeHtml(when(r.createdAt))} · PIN ${escapeHtml(r.pin)} · ${escapeHtml(r.status)}</p>
    ${r.awards.length ? `<div class="awards" style="justify-content:flex-start;margin:16px 0">${r.awards.map(a => `
      <div class="award" style="animation:none"><div class="e">${escapeHtml(a.emoji)}</div><div class="t">${escapeHtml(a.title)}</div>
      <div class="w">${escapeHtml(a.avatar)} ${escapeHtml(a.nickname)}</div><div class="d">${escapeHtml(a.detail)}</div></div>`).join("")}</div>` : ""}
    <div class="card" style="margin:16px 0;overflow-x:auto" tabindex="0" role="region" aria-label="Player standings table">
      <h3>Standings</h3>
      <table>
        <caption class="sr-only">Player standings for ${escapeHtml(r.title)}</caption><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col" class="num">Score</th><th scope="col" class="num">Right</th><th scope="col" class="num">Best streak</th><th scope="col" class="num">Avg time</th></tr>
        ${r.standings.map(s => `
          <tr>
            <td class="rank">${s.rank}</td>
            <td>${escapeHtml(s.avatar)} ${escapeHtml(s.nickname)}</td>
            <td class="num">${fmt(s.score)}</td>
            <td class="num">${s.correct} / ${s.answered}</td>
            <td class="num">${s.bestStreak}</td>
            <td class="num">${secs(s.avgCorrectMs)}</td>
          </tr>`).join("") || `<tr><td></td><td class="sub">Nobody played.</td></tr>`}
      </table>
    </div>
    <div class="card" style="overflow-x:auto" tabindex="0" role="region" aria-label="Question results table">
      <h3>Questions</h3>
      <table>
        <caption class="sr-only">Question results for ${escapeHtml(r.title)}</caption><tr><th scope="col">No.</th><th scope="col">Question and answer</th><th scope="col" class="num">Right</th><th scope="col" class="num">Avg time</th></tr>
        ${r.questions.map((q, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>${escapeHtml(q.prompt)}<br><span class="sub">${escapeHtml(q.answer)}</span></td>
            <td class="num">${q.answered ? Math.round((q.correct / q.answered) * 100) + "%" : "—"}<br><span class="sub">${q.correct} / ${q.answered}</span></td>
            <td class="num">${secs(q.avgMs)}</td>
          </tr>`).join("") || `<tr><td></td><td class="sub">No questions were played.</td></tr>`}
      </table>
    </div>`;
  $("back").onclick = loadGames;
  $("delete-game")?.addEventListener("click", async () => {
    if (!await askDialog({ title: "Delete these game results?", message: "This game and all of its results will be permanently deleted.", confirmLabel: "Delete results", danger: true })) return;
    try {
      await api(`/api/admin/games/${encodeURIComponent(r.id)}`, { method: "DELETE" });
      toast("Game deleted");
      loadGames();
    } catch (err) {
      toast(err.message);
    }
  });
}

function when(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
