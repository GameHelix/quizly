# AI Quiz — static version

Plain HTML, CSS and ES modules. No build step, no dependencies.

```
questions.json   the question bank and round settings — the only data file
store.js         load / save / normalise / scoring helpers
index.html       player
quiz.js          player logic
admin.html       admin panel
admin.js         admin logic
styles.css       shared styles
```

## Running it

The pages fetch `questions.json`, so a browser opened on `file://` will block it.
Serve the folder:

```
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed address. `index.html` is the quiz, `admin.html` is the panel.

## How the data flows

`questions.json` is the source of truth. The admin panel writes edits to
`localStorage` under `ai-quiz:data:v1`, which overrides the file for that browser
only. Use **Import & export → Download questions.json** to turn your edits back
into a file, and **Discard local edits** to go back to the shipped bank.

That override exists so the panel is useful before you have a backend. It is the
first thing to remove when you wire one up.

## Question shape

```json
{
  "id": "q01",
  "category": "Fundamentals",
  "difficulty": "easy",
  "prompt": "What does the \"GPT\" in GPT stand for?",
  "options": ["…", "…", "…", "…"],
  "answer": 1,
  "explanation": "Shown after the reveal."
}
```

`answer` is the index into `options`, counted from zero, and refers to the
original order — option shuffling happens at play time and does not move it.
Two to six options are supported.

Settings: `questionsPerRound`, `secondsPerQuestion`, `shuffleQuestions`,
`shuffleOptions`, `basePoints`, `speedBonus`. Score for a correct answer is
`basePoints + speedBonus × (time remaining ÷ time allowed)`, so a fast answer is
worth `basePoints + speedBonus` and one at the buzzer is worth `basePoints`.

## Porting to Next.js

Everything that touches storage lives in `store.js`. Replace `loadQuiz`,
`loadDefaults`, `saveQuiz` and `clearLocal` with calls to your API routes and the
rest of the app is unchanged. `shuffle`, `scoreFor` and `normalise` are pure and
move across as they are.

A reasonable first schema:

```
Question(id, category, difficulty, prompt, options[], answerIndex, explanation)
Setting(key, value)              — or a single JSON column
Session(id, code, state, currentIndex, startedAt)
Answer(sessionId, userId, questionId, pickedIndex, points, answeredAt)
```

Three things the static version cannot do, which are the reason to build the
Next.js app:

- **A shared scoreboard.** Scoring here is per browser. You need `Answer` rows
  server-side and a leaderboard query.
- **Presenter-driven pacing.** Here each player moves at their own speed. A
  `Session` row with `currentIndex`, pushed over SSE or websockets, gives you the
  Kahoot behaviour where everyone sees the same question at once.
- **Authentication on the admin panel.** `admin.html` is currently open to anyone
  who knows the path. Put it behind auth before it goes anywhere public.

Also worth doing server-side: keep `answerIndex` out of the payload sent to
players until the reveal, and score the answer on the server. In this version the
correct answers are in the client bundle, which is fine for a room at lunch and
not fine for anything that counts.

## The bank

18 questions in four categories: Fundamentals, Applied, Risk, Governance.
Difficulty is tagged but not yet used for selection — a `where difficulty = …`
filter is an easy addition in the admin panel.
