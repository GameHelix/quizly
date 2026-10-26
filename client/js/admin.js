import { loadQuiz, loadDefaults, saveQuiz, clearLocal, hasLocalEdits, normalise, escapeHtml } from "../../shared/quiz.js";

let quiz = null;
let editingId = null;   // id being edited, or "__new__", or null

const $ = id => document.getElementById(id);
const listEl = $("list");
const editorEl = $("editor");

init();

async function init() {
  try {
    quiz = await loadQuiz();
  } catch (err) {
    document.querySelector(".wrap").innerHTML =
      `<h1>Could not load questions.json</h1><p>${escapeHtml(err.message)}</p>
       <p class="note">Serve the folder over http rather than opening the file directly:
       <code>npx serve .</code> or <code>python3 -m http.server</code>.</p>`;
    return;
  }
  wireTabs();
  wireButtons();
  fillSettings();
  renderList();
}

function wireTabs() {
  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("nav.tabs button").forEach(x => x.classList.toggle("on", x === b));
      ["questions", "settings", "data"].forEach(t =>
        $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    };
  });
}

function wireButtons() {
  $("add").onclick = () => { editingId = "__new__"; renderEditor(); };
  $("filter").onchange = renderList;
  $("save-settings").onclick = saveSettings;
  $("export").onclick = exportJson;
  $("import").onchange = importJson;
  $("reset").onclick = async () => {
    if (!confirm("Discard local edits and reload the shipped questions?")) return;
    clearLocal();
    quiz = await loadDefaults();
    fillSettings();
    renderList();
    toast("Back to the shipped questions");
  };
}

/* ---------- questions ---------- */

function categories() {
  return [...new Set(quiz.questions.map(q => q.category))].sort();
}

function renderList() {
  const sel = $("filter");
  const current = sel.value;
  sel.innerHTML = `<option value="">All categories</option>` +
    categories().map(c => `<option${c === current ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");

  const shown = current ? quiz.questions.filter(q => q.category === current) : quiz.questions;
  $("count").textContent = `${quiz.questions.length} in bank`;
  $("dirty").textContent = hasLocalEdits() ? "Local edits" : "Unedited";
  $("dirty").classList.toggle("on", hasLocalEdits());

  listEl.innerHTML = shown.length ? shown.map(q => `
    <div class="qitem">
      <div class="head">
        <div style="flex:1">
          <div class="meta">
            <span class="pill">${escapeHtml(q.category)}</span>
            <span class="pill">${escapeHtml(q.difficulty)}</span>
            <span class="pill">${escapeHtml(q.id)}</span>
          </div>
          <p class="prompt">${escapeHtml(q.prompt)}</p>
          <p class="sub" style="margin:0">Answer: ${escapeHtml(q.options[q.answer] ?? "—")}</p>
        </div>
        <div class="acts">
          <button class="ghost" data-edit="${escapeHtml(q.id)}">Edit</button>
          <button class="danger" data-del="${escapeHtml(q.id)}">Delete</button>
        </div>
      </div>
    </div>`).join("") : `<p class="sub">Nothing in this category.</p>`;

  listEl.querySelectorAll("[data-edit]").forEach(b => {
    b.onclick = () => { editingId = b.dataset.edit; renderEditor(); };
  });
  listEl.querySelectorAll("[data-del]").forEach(b => {
    b.onclick = () => {
      const q = quiz.questions.find(x => x.id === b.dataset.del);
      if (!confirm("Delete this question?\n\n" + q.prompt)) return;
      quiz.questions = quiz.questions.filter(x => x.id !== b.dataset.del);
      persist("Question deleted");
    };
  });
}

function blankQuestion() {
  const n = quiz.questions.length + 1;
  return {
    id: "q" + String(n).padStart(2, "0") + "-" + Math.random().toString(36).slice(2, 6),
    category: "General", difficulty: "medium",
    prompt: "", options: ["", "", "", ""], answer: 0, explanation: ""
  };
}

function renderEditor() {
  const q = editingId === "__new__" ? blankQuestion() : quiz.questions.find(x => x.id === editingId);
  if (!q) { editorEl.classList.add("hidden"); return; }

  editorEl.classList.remove("hidden");
  editorEl.innerHTML = `
    <h3>${editingId === "__new__" ? "New question" : "Editing " + escapeHtml(q.id)}</h3>
    <div class="field">
      <label for="e-prompt">Question</label>
      <textarea id="e-prompt">${escapeHtml(q.prompt)}</textarea>
    </div>
    <div class="grid2">
      <div class="field">
        <label for="e-cat">Category</label>
        <input id="e-cat" value="${escapeHtml(q.category)}">
      </div>
      <div class="field">
        <label for="e-diff">Difficulty</label>
        <select id="e-diff">
          ${["easy", "medium", "hard"].map(d =>
            `<option${d === q.difficulty ? " selected" : ""}>${d}</option>`).join("")}
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
      <textarea id="e-why">${escapeHtml(q.explanation)}</textarea>
    </div>
    <div class="bar">
      <button id="e-save">Save question</button>
      <button class="quiet" id="e-cancel">Cancel</button>
    </div>`;

  $("e-addopt").onclick = () => {
    const n = $("e-opts").children.length;
    if (n >= 6) return toast("Six options is the maximum");
    $("e-opts").insertAdjacentHTML("beforeend", optRow("", n, false));
  };
  $("e-cancel").onclick = () => { editingId = null; editorEl.classList.add("hidden"); };
  $("e-save").onclick = () => saveQuestion(q);
  editorEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function optRow(value, i, checked) {
  return `<div class="optrow">
    <input type="radio" name="correct" value="${i}"${checked ? " checked" : ""} aria-label="Correct answer">
    <input type="text" class="opt-text" value="${escapeHtml(value)}" placeholder="Option ${"ABCDEF"[i]}">
  </div>`;
}

function saveQuestion(q) {
  const options = [...editorEl.querySelectorAll(".opt-text")].map(i => i.value.trim()).filter(Boolean);
  const checked = editorEl.querySelector('input[name="correct"]:checked');
  const prompt = $("e-prompt").value.trim();

  if (!prompt) return toast("The question text is empty");
  if (options.length < 2) return toast("At least two options are needed");
  if (!checked) return toast("Mark which option is correct");
  const answer = Number(checked.value);
  if (answer >= options.length) return toast("The correct option is blank");

  const updated = {
    id: q.id,
    category: $("e-cat").value.trim() || "General",
    difficulty: $("e-diff").value,
    prompt, options, answer,
    explanation: $("e-why").value.trim()
  };

  const at = quiz.questions.findIndex(x => x.id === q.id);
  if (at >= 0) quiz.questions[at] = updated;
  else quiz.questions.push(updated);

  editingId = null;
  editorEl.classList.add("hidden");
  persist("Question saved");
}

/* ---------- settings ---------- */

function fillSettings() {
  const s = quiz.settings;
  $("s-count").value = s.questionsPerRound;
  $("s-secs").value = s.secondsPerQuestion;
  $("s-base").value = s.basePoints;
  $("s-bonus").value = s.speedBonus;
  $("s-shq").value = s.shuffleQuestions ? "yes" : "no";
  $("s-sho").value = s.shuffleOptions ? "yes" : "no";
}

function saveSettings() {
  quiz.settings = {
    questionsPerRound: Number($("s-count").value) || 5,
    secondsPerQuestion: Number($("s-secs").value) || 20,
    basePoints: Number($("s-base").value) || 0,
    speedBonus: Number($("s-bonus").value) || 0,
    shuffleQuestions: $("s-shq").value === "yes",
    shuffleOptions: $("s-sho").value === "yes"
  };
  persist("Settings saved");
}

/* ---------- data ---------- */

function exportJson() {
  const blob = new Blob([JSON.stringify(quiz, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "questions.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const parsed = normalise(JSON.parse(await file.text()));
    if (!parsed.questions.length) throw new Error("No questions in that file");
    quiz = parsed;
    fillSettings();
    persist("Imported " + parsed.questions.length + " questions");
  } catch (err) {
    toast("Import failed: " + err.message);
  }
  ev.target.value = "";
}

/* ---------- helpers ---------- */

function persist(msg) {
  saveQuiz(quiz);
  renderList();
  toast(msg);
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
