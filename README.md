# Quizly

A live, presenter-paced quiz in the style of Kahoot. The presenter puts the host
screen on the projector; the room joins on their phones by scanning a QR code or
typing a PIN; everyone sees the same question at the same moment; the server keeps
score; a leaderboard follows every question and a podium closes the game.

Built for rooms of fifty or sixty people and tested well past that (see
[Capacity](#capacity)). Plain HTML, CSS and JavaScript in the browser — no build
step, no framework — an Express API, and Postgres.

**Live:** https://quizly-lemon-tau.vercel.app — the host screen is at `/host`, the admin
panel at `/admin`. Vercel project `quizly` in the PRE team; database on Neon.

## What is in it

- **Host screen** (`/host`) — pick a quiz, show the QR code, PIN and the names
  arriving, then run the game with one button: Next, the space bar, Enter, → or a
  presentation clicker. `F` for full screen, `M` for sound, `L` to lock the game.
- **Phones** (`/`) — join with the PIN (the QR code fills it in), pick a nickname and
  an avatar, answer, see each result, your rank and how far you are behind the person
  ahead. A refresh or a locked screen loses nothing.
- **Live leaderboard** (`/board#PIN`) — for a second screen: the QR code while people
  join, then standings that slide into their new order after every question.
- **Admin** (`/admin`) — a library of quizzes: write and edit questions, settings per
  quiz, import and export quiz files, and the results of every game played, with a CSV
  for the spreadsheet afterwards.
- **Gamification** — a speed bonus, answer streaks with a growing bonus (🔥), rank
  movement (▲▼), a 3-2-1 lead-in, sound cues, haptics on Android, confetti, a podium
  that rises third–second–first, end-of-game awards (⚡ fastest finger, 🔥 longest
  streak, 📈 comeback since half-time) and badges on each phone (🏆 💯 …). After each
  question the projector names the fastest right answer and the leaderboard the biggest
  climber; each phone shows where its points came from (correct, speed, streak, time),
  how the room did ("Only 20% got it right. A tricky one!"), and who it is chasing and
  who is chasing it.
- **Calm by design** — made for a lunch-and-learn: a miss reads "Good try! Now you know"
  in calm colours, the phone's clock never turns red or buzzes, and ranks are named only
  at the top: the projector lists the top five, and a phone further down hears "Top half"
  or "Keep going!" instead of "38th of 50".

## Interface and game experience

All pages share the Quizly playroom style: forest green and lime, local variable
fonts, original SVG artwork, and consistent navigation that also works on phones.
The player lobby explains the next step; round progress and three- and five-answer
streak challenges follow the player's actual game state. Answer selection locks
visibly, reveals label the correct answer, and explanations reinforce learning.
Players can also answer with A–F or 1–6 on a keyboard.

The host setup leads into a lobby with a copyable invite link, QR code, player
roster, and controls for sound, locking, and full screen. The presenter layout fits
the viewport without shrinking in response to decorative entrance animations.
The quiz studio includes question search, category filters, keyboard-accessible
tabs, live scoring previews, and game results with keyboard-scrollable tables.
Help, quiz naming, and confirmations use dialogs with focus trapping and Escape
support. Motion effects and haptics respect reduced-motion preferences. Font
licenses are included in `client/fonts/`.

## Layout

```
api/index.js          Vercel's entry point: exports the Express app
server/               the API
  app.js              routes, security headers, error handling
  play.js             the live game: joining, the clock, answers, scoring, the reveal, awards
  quizzes.js          the quiz library
  results.js          past games, standings, CSV
  auth.js             admin sign-in: a signed HttpOnly cookie
  db.js               Postgres pool and migrations
  migrations/         SQL, applied in order by `npm run build` / `npm run db:migrate`
  config.js, net.js, errors.js, index.js (the standalone server)
shared/quiz.js        rules both sides use: validation, scoring, streaks, nicknames
client/               the browser: four pages, their scripts, the stylesheet, the favicon
data/questions.json   a ready-made AI quiz in the import format — not read at runtime
scripts/              build, migrate, seed, load-test, abuse-test
test/                 rules and full-API tests (node --test)
neon.js               the Neon project's branch policy, applied with `neon deploy`
vercel.json           build, rewrites, region and security headers for Vercel
assets/               presentation images; not part of the app and not deployed
```

## How it works

Every quiz, game, player and answer lives in Postgres. Nothing is kept in a server's
memory between requests, which is what lets it run as a Vercel Function: any instance
can answer any request.

Every screen holds one long request open, `/api/games/:pin/live`, and the server sends the
game's shared state down it the moment anything changes: a join, an answer, the host's
Next, a clock running out. Each function instance keeps one small feed per game that
reads a single short row four times a second and builds the state again only when it
changed, so sixty phones cost the database a few tiny queries a second. A stream ends
after 25 seconds, inside the function's 30-second limit, and the screen opens the next at
once. A phone fetches its own private view (its answer, its result, its rank) only when
the game moves to a new screen.

Where a network holds such a response back, the screen **polls** the same state
(`/api/games/:pin`) about once a second instead. That state is the same for everyone,
so Vercel's CDN answers most polls from cache (`s-maxage=1`), and each function instance
also reuses it for half a second.

**Timing is fair even though no network is instant.** A question opens with a
three-second lead-in, and its clock is two absolute timestamps. Every screen corrects for
its own clock's error against the server's and counts down to the same instant, so the
options open on every phone at once whenever that phone heard of the question.
Points are worked out on the server from the server's clock; a phone may claim back up to
0.6 s of network delay, never more.

**The correct answer never leaves the server before the reveal** — not to phones, not to
the projector. Scores only change at the reveal, so nothing on any screen gives an answer
away while the clock runs. The first request to notice that a question's time is up closes
it; row locks make sure exactly one request does, and that no answer slips in afterwards.

## Running it locally

Needs Node 22.9 or later, and a Postgres: a Neon branch, or Docker for a local one.

```
cp .env.example .env               # then set ADMIN_PASSWORD and SESSION_SECRET
neon env pull                      # Neon: writes DATABASE_URL and DATABASE_URL_UNPOOLED into .env
# or: docker compose up -d         # a local Postgres on localhost:5435, as .env.example says
npm install
npm run db:seed                    # migrates, then imports data/questions.json as "AI Quiz"
npm run dev                        # http://localhost:3000
```

`npm test` drops and rebuilds the schema of its own database, so it runs against the
Docker one (`docker compose up -d`) and refuses any other host.

Open `/host` and sign in with `ADMIN_PASSWORD`. The QR code on a laptop points at the
laptop's address on the network, so phones on the same Wi-Fi can join — if the network
allows devices to reach each other, which office and guest networks often do not. For an
event, deploy it.

## Deploying to Vercel with Neon

1. Import the repository in Vercel (framework preset: **Other** — `vercel.json` sets
   everything else).
2. Attach the Neon database (Storage → Neon). It sets `DATABASE_URL`, the pooled connection
   (host ending `-pooler`) that the app uses, and `DATABASE_URL_UNPOOLED`, the direct one that
   migrations use: PgBouncer's transaction pooling cannot hold the session a migration needs.
3. Add `ADMIN_PASSWORD` (16+ characters: `openssl rand -base64 24`) and `SESSION_SECRET`
   (`openssl rand -hex 32`) for Production.
4. Deploy. The build assembles the static site and applies the migrations.
5. Import a quiz: Admin → Import & export → *Import as a new quiz* with
   `data/questions.json`, or run `npm run db:seed` locally with the production
   `DATABASE_URL`.

Functions run in `cle1` (Cleveland), next to a Neon database in AWS `us-east-2`: each
request makes several database round trips, so the function belongs beside the database,
not beside the audience. If the database is moved, move `regions` in `vercel.json` with it.

QR codes point at the project's production domain. Set `PUBLIC_URL` to use a custom one.

## Running the session

The day before:
- Deploy, sign in at `/admin`, import or check the quiz and its settings (questions per
  game, seconds per question).
- Rehearse against the live URL: `npm run load-test -- --url https://… --players 60`
  plays a whole game with sixty simulated phones and checks every score. Delete the test
  game from Admin → Results afterwards.

On the day:
- Deploy before people arrive and do not redeploy during the session.
- Sign in on the presenter's laptop early: the session lasts 12 hours, so nothing in the room
  can lock it out mid-game. Keep a phone hotspot in mind if the venue Wi-Fi struggles —
  phones on mobile data reach the game just as well.
- Open `/admin` a few minutes early: Neon wakes a sleeping database on the first query.
- On the presenter's laptop open `/host`, create the game, press `F`.
- Once everyone is in, press `L` to lock the game so nobody can add made-up players, then
  Start. Click a name in the lobby or on the scoreboard to remove it.
- Afterwards: Admin → Results has the standings and a CSV.

## Quiz files

A quiz is imported and exported as JSON — `data/questions.json` is one:

```json
{
  "version": 1,
  "title": "AI Quiz",
  "settings": {
    "questionsPerRound": 10, "secondsPerQuestion": 15,
    "shuffleQuestions": true, "shuffleOptions": true,
    "basePoints": 500, "speedBonus": 500, "streakBonus": 100
  },
  "questions": [{
    "id": "q01", "category": "Basics", "difficulty": "easy",
    "prompt": "In AI tools, what is a “prompt”?",
    "options": ["…", "…", "…", "…"],
    "answer": 0,
    "explanation": "Shown after the reveal."
  }]
}
```

`answer` is the index into `options`, counted from zero. Two to six options. Options are
shuffled once per game, so the projector and every phone show them in the same order.

**Scoring.** A correct answer is worth `basePoints + speedBonus × time left ÷ time
allowed`, plus `streakBonus` for each consecutive correct answer before it (at most five
times): with the defaults, 500–1000 points, and +100, +200, … for a streak.

## Capacity

Measured on a laptop with `npm run load-test` (local Postgres, no CDN, so every poll
reaches the server) — whole games of simulated phones that join over a few seconds, poll
once a second, answer at human speed, and in part drop out or reload mid-game:

| phones | requests | failures | slowest endpoint p99 | answers in, every question |
|---|---|---|---|---|
| 60  | 13,801 (73/s)  | 0 | 12 ms | 60/60 |
| 150 | 16,972 (5 questions)  | 0 | 11 ms | 150/150 |
| 250 | 28,595 (5 questions)  | 0 | 11 ms | 250/250 |

In every run each phone's final score matched the points its reveals reported, and ranks
ran 1…N with no gaps.

Those runs polled. With live streams (the default; `--poll` still tests the polling path),
60 phones played a 3-question game locally with 992 requests in 46 s (22/s), 4,492 states
pushed, no failures and 60/60 answers on every question; in real browsers a phone showed
the host's next screen 80–290 ms after the key press, and the reveal 180 ms after the last
answer.

The same 60-phone game against the live deployment, run from Baku (the function and the
database sit in Ohio, the CDN edge in Stockholm): 12,216 requests, no failures, 60/60
answers on every question; polls 71 ms at the median, answers 224 ms (340 ms p99) — the
distance, not the server. A full game in real browsers (Chromium, and WebKit as on an
iPhone) ran without a console error, and the abuse suite passed all 34 checks there too. `npm run abuse-test` passes 34 checks: forged and edited cookies,
cross-site requests, token reuse across players, SQL injection, script injection in
nicknames, prototype pollution, path traversal, oversized and malformed bodies, races
(25 simultaneous answers from one phone → one counts; 30 simultaneous Next presses → one
step; 20 simultaneous joins with one nickname → one wins), PIN and password guessing,
and 2,000 polls at 13,000+ a second with the health check staying under 35 ms.

## Security

- Admin and host routes need the admin password: a signed, HttpOnly, SameSite=Lax cookie.
  State-changing requests must come from the app's own origin.
- A player is a random 192-bit token, stored hashed and sent in a header, never a URL.
- Strict Content-Security-Policy (scripts from the app only), no framing, `nosniff`.
  Everything shown is escaped; nicknames are cleaned of control and direction characters.
- Rate limits, shared by every instance, written for a room where everyone shares one
  address: 20 wrong passwords per 15 minutes, 30 wrong PINs and 300 probes of missing games
  per 10 minutes, and 300 successful joins per 10 minutes. Only failures and successes count,
  so nobody can use up the room's allowance with requests that fail on purpose.
- At most `MAX_PLAYERS` (100) per game, and the host can lock a game and remove anyone.
- CSV exports cannot run as spreadsheet formulas.
- `.env` and secrets are ignored by git and by Vercel uploads.

## Scripts

| | |
|---|---|
| `npm run dev` | the app with auto-reload, on `PORT` (3000) |
| `npm start` | the app, for any Node host that is not Vercel |
| `npm run build` | assembles `public/` for the CDN and applies migrations (Vercel's build) |
| `npm run db:migrate` | applies migrations to `DATABASE_URL` |
| `npm run db:seed [-- file.json]` | imports a quiz file as a new quiz |
| `npm test` | rules and API tests against `TEST_DATABASE_URL` (default: the compose Postgres) |
| `npm run load-test -- --url … --players 60` | plays a whole game with simulated phones |
| `npm run abuse-test -- --url …` | attacks the app and checks it holds |
