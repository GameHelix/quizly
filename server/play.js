/* The live game, kept in Postgres. Every request — a phone polling, a tap,
 * the host pressing Next — reads the game, applies the rules and writes the
 * result back. No process holds state between requests, which is what lets
 * it run on Vercel, where any instance may serve any request.
 *
 *   lobby → question → reveal → leaderboard → question → … → reveal → final
 *
 * Time is the only thing that moves by itself. A question's clock is two
 * stored timestamps; the first request to notice the deadline has passed
 * closes the question, and row locks make sure exactly one request does,
 * and that no answer slips in after the reveal.
 *
 * The server is the only authority: the correct answer never leaves it
 * before the reveal, and every point is worked out here.
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { AVATARS, cleanNickname, scoreFor, shuffle, streakBonusFor } from "../shared/quiz.js";
import { tx } from "./db.js";
import { GameError } from "./errors.js";

const LEAD_IN_MS = 3000;            // "get ready": every phone has the question before its options open
const GRACE_MS = 1500;              // answers sent before zero but still in flight are accepted this long after
export const LATENCY_MS = 600;      // how much of the network delay a phone may claim back (see fairElapsed)
const BOARD_SIZE = 20;              // rows in the public state, for the leaderboard screen
const CLOCK_SKEW_MS = 300;          // a phone's clock estimate may run this far ahead of ours
const VIEW_CACHE_MS = 500;          // how long one process reuses a public view
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPlay({ pool, quizzes, maxPlayers = 300, leadInMs = LEAD_IN_MS }) {
  const viewCache = new Map();   // pin → { at, view }
  // A phone asking for its own view more than twice a second gets the same
  // answer: a token is no licence to make the database work flat out.
  const meCache = new Map();     // player:status:phase:index → { at, view }

  /* ---------- finding games ---------- */

  /* The game a PIN belongs to. Finished games keep answering for two hours
   * so phones can still show the final screen. */
  async function find(pin) {
    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) return null;
    const { rows: [row] } = await pool.query(`
      select * from games
      where pin = $1 and (status in ('lobby', 'running') or finished_at > now() - interval '2 hours')
      order by created_at desc limit 1`, [pin]);
    return row ? hydrate(row) : null;
  }

  async function byId(id) {
    const { rows: [row] } = await pool.query("select * from games where id = $1", [id]);
    return row ? hydrate(row) : null;
  }

  /* find, closing the question first if its clock ran out since anyone looked. */
  async function current(pin) {
    const game = await find(pin);
    if (game && game.phase === "question" && Date.now() > game.deadline + GRACE_MS) {
      return (await settle(game)) ?? byId(game.id);
    }
    return game;
  }

  /* ---------- creating and joining ---------- */

  async function create({ quizId, category = "", joinBase }) {
    const quiz = await quizzes.get(quizId);
    const round = buildRound(quiz.questions, quiz.settings, typeof category === "string" ? category : "");
    if (!round.length) throw new GameError("no_questions");
    for (let attempt = 0; attempt < 20; attempt++) {
      const pin = String(randomInt(100000, 1000000));
      try {
        const { rows: [row] } = await pool.query(`
          insert into games (id, pin, quiz_id, title, join_url, settings, round)
          values ($1, $2, $3, $4, $5, $6, $7) returning *`,
          [randomUUID(), pin, quiz.id, quiz.title, `${joinBase}/?pin=${pin}`,
            JSON.stringify(quiz.settings), JSON.stringify(round)]);
        return hydrate(row);
      } catch (err) {
        if (err.code !== "23505") throw err;   // a live game holds that PIN: draw again
      }
    }
    throw new GameError("no_pin");
  }

  async function join(game, rawNickname, rawAvatar) {
    if (game.isOver) throw new GameError("game_over");
    const nickname = cleanNickname(rawNickname);
    if (!nickname) throw new GameError("bad_nickname");
    const avatar = AVATARS.includes(rawAvatar) ? rawAvatar : AVATARS[randomInt(AVATARS.length)];
    const token = randomBytes(24).toString("base64url");
    const id = randomUUID();
    let rowCount;
    try {
      ({ rowCount } = await pool.query(`
        insert into players (id, game_id, nickname, avatar, token_hash, joined_at)
        select $1, g.id, $3, $4, $5, $6 from games g
        where g.id = $2 and g.status in ('lobby', 'running') and not g.locked
          and (select count(*) from players where game_id = g.id and not kicked) < $7`,
        [id, game.id, nickname, avatar, hash(token), Date.now(), maxPlayers]));
    } catch (err) {
      if (err.code === "23505") throw new GameError("nickname_taken");
      throw err;
    }
    if (!rowCount) {
      const fresh = await byId(game.id);
      throw new GameError(!fresh || fresh.isOver ? "game_over" : fresh.locked ? "game_locked" : "game_full");
    }
    forget(game.pin);
    return { playerId: id, token, nickname, avatar };
  }

  /* The player an id and token belong to, kicked or not; null if they don't match. */
  async function player(game, playerId, token) {
    if (!UUID.test(String(playerId)) || typeof token !== "string" || token.length > 64) return null;
    const { rows: [p] } = await pool.query("select * from players where id = $1 and game_id = $2", [playerId, game.id]);
    if (!p) return null;
    const given = Buffer.from(hash(token));
    const stored = Buffer.from(p.token_hash);
    return given.length === stored.length && timingSafeEqual(given, stored) ? p : null;
  }

  /* ---------- the host's controls ---------- */

  /* The host's one button: whatever comes after the current screen. `from`
   * is the screen the host was looking at, so a double click or a second
   * host window finds the game already moved on and changes nothing. */
  async function next(game, from) {
    if (game.isOver) throw new GameError("game_over");
    if (from && (from.phase !== game.phase || from.index !== game.index)) return game;
    switch (game.phase) {
      case "lobby": return start(game);
      case "question": return (await settle(game)) ?? byId(game.id);
      case "reveal": return game.isLast ? finish(game) : advance(game, "leaderboard");
      case "leaderboard": return openQuestion(game, game.index + 1);
      default: throw new GameError("game_over");
    }
  }

  async function start(game) {
    const { rows: [n] } = await pool.query("select count(*) as n from players where game_id = $1 and not kicked", [game.id]);
    if (!n.n) throw new GameError("no_players");
    const opens = Date.now() + leadInMs;
    return transition(game, `
      update games set status = 'running', phase = 'question', current_index = 0,
                       opens_at = $2, deadline = $3, started_at = now()
      where id = $1 and phase = 'lobby' and status = 'lobby' returning *`,
      [game.id, opens, opens + game.limitMs]);
  }

  async function openQuestion(game, i) {
    const opens = Date.now() + leadInMs;
    return transition(game, `
      update games set phase = 'question', current_index = $2, opens_at = $3, deadline = $4
      where id = $1 and phase = 'leaderboard' and current_index = $2 - 1 returning *`,
      [game.id, i, opens, opens + game.limitMs]);
  }

  async function advance(game, phase) {
    return transition(game, `
      update games set phase = $3 where id = $1 and phase = $2 and current_index = $4 returning *`,
      [game.id, game.phase, phase, game.index]);
  }

  /* Ends the game now. Mid-question, the open question still counts. */
  async function end(game) {
    if (game.isOver) return game;
    if (game.phase === "lobby") {
      return transition(game, `
        update games set status = 'abandoned', finished_at = now()
        where id = $1 and status = 'lobby' returning *`, [game.id]);
    }
    return finish(game);
  }

  async function finish(game) {
    if (game.phase === "question") game = (await settle(game)) ?? await byId(game.id);
    if (game.isOver) return game;
    const { rows: players } = await pool.query("select * from players where game_id = $1 and not kicked", [game.id]);
    const awards = computeAwards(players, game.closedCount);
    return transition(game, `
      update games set phase = 'final', status = 'finished', finished_at = now(), awards = $2
      where id = $1 and status = 'running' returning *`, [game.id, JSON.stringify(awards)]);
  }

  async function kick(game, playerId) {
    if (!UUID.test(String(playerId))) throw new GameError("no_player");
    const { rowCount } = await pool.query(
      "update players set kicked = true where id = $1 and game_id = $2 and not kicked", [playerId, game.id]);
    if (!rowCount) throw new GameError("no_player");
    forget(game.pin);
    if (game.phase === "question") {
      const n = await answerCounts(pool, game.id, game.index);
      if (n.players > 0 && n.answered >= n.players) return (await settle(game)) ?? byId(game.id);
    }
    return byId(game.id);
  }

  /* Opens or closes the game to new players. */
  async function lock(game, locked) {
    return transition(game, `
      update games set locked = $2 where id = $1 and status in ('lobby', 'running') returning *`,
      [game.id, locked === true]);
  }

  /* Runs one conditional update. If another request changed the game
   * first, the update matches nothing and the game is returned as it now is. */
  async function transition(game, sql, params) {
    const { rows: [row] } = await pool.query(sql, params);
    forget(game.pin);
    return row ? hydrate(row) : byId(game.id);
  }

  /* ---------- answering ---------- */

  async function answer(game, p, index, choice, clientElapsed) {
    if (p.kicked) throw new GameError("kicked");
    if (game.phase !== "question" || index !== game.index) throw new GameError("not_open");
    const q = game.round[index];
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) throw new GameError("bad_choice");
    const serverElapsed = Date.now() - game.opensAt;
    if (serverElapsed < -CLOCK_SKEW_MS) throw new GameError("not_open_yet");
    if (serverElapsed > game.limitMs + GRACE_MS) throw new GameError("too_late");

    // A repeat is refused before it takes a lock: a flood of them must not
    // queue ahead of the reveal.
    const { rowCount: repeat } = await pool.query(
      "select 1 from answers where player_id = $1 and question_index = $2", [p.id, index]);
    if (repeat) throw new GameError("already_answered");

    const elapsedMs = fairElapsed(serverElapsed, clientElapsed, game.limitMs);
    const correct = choice === q.answer;
    const bonus = correct ? streakBonusFor(p.streak, game.settings) : 0;
    const points = scoreFor(correct, elapsedMs, game.limitMs, game.settings) + bonus;

    await tx(pool, async c => {
      // FOR SHARE: a reveal that starts now waits for this answer, and an answer
      // that starts after the reveal finds the question closed.
      const open = await c.query(
        "select 1 from games where id = $1 and phase = 'question' and current_index = $2 for share", [game.id, index]);
      if (!open.rowCount) throw new GameError("not_open");
      const inserted = await c.query(`
        insert into answers (game_id, player_id, question_index, choice, correct, points, bonus, elapsed_ms, answered_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
        [game.id, p.id, index, choice, correct, points, bonus, elapsedMs, Date.now()]);
      if (!inserted.rowCount) throw new GameError("already_answered");
    });
    forget(game.pin);
    meCache.delete(`${p.id}:${game.status}:${game.phase}:${game.index}`);
    // Everyone is in: no reason to make the room wait for the clock. Counted after
    // the commit, never inside it: when the last answers land together, each
    // transaction sees only its own, but whichever commits last sees them all.
    const counts = await answerCounts(pool, game.id, index);
    if (counts.answered >= counts.players) await settle(game);
    return { ok: true, index, choice };
  }

  /* ---------- the reveal ---------- */

  /* Closes the current question and banks its points: scores, streaks and
   * ranks for every player, in one transaction. Returns the revealed game,
   * or null if another request closed it first. Scores move only here, so
   * nothing on any screen can give an answer away while the clock runs. */
  async function settle(game) {
    const revealed = await tx(pool, async c => {
      const { rows: [row] } = await c.query(`
        update games set phase = 'reveal'
        where id = $1 and phase = 'question' and current_index = $2 returning *`, [game.id, game.index]);
      if (!row) return null;
      const i = row.current_index;
      const { rows: players } = await c.query(`
        select p.id, p.score, p.streak, p.best_streak, p.correct_count, p.correct_ms, p.joined_at,
               a.points as answer_points, a.correct as answer_correct, a.elapsed_ms as answer_ms
        from players p left join answers a on a.player_id = p.id and a.question_index = $2
        where p.game_id = $1 and not p.kicked`, [row.id, i]);
      if (!players.length) return hydrate(row);

      const before = ranks(players);
      for (const p of players) {
        p.last_points = p.answer_points ?? 0;
        p.score += p.last_points;
        p.streak = p.answer_correct ? p.streak + 1 : 0;
        p.best_streak = Math.max(p.best_streak, p.streak);
        if (p.answer_correct) {
          p.correct_count += 1;
          p.correct_ms += p.answer_ms;
        }
      }
      const after = ranks(players);
      const col = f => players.map(f);
      await c.query(`
        update players p set
          score = u.score, last_points = u.last_points, streak = u.streak, best_streak = u.best_streak,
          correct_count = u.correct_count, correct_ms = u.correct_ms,
          prev_rank = u.prev_rank, rank = u.rank, ranks = p.ranks || jsonb_build_object($1::text, u.rank)
        from unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::bigint[], $9::int[], $10::int[])
          as u(id, score, last_points, streak, best_streak, correct_count, correct_ms, prev_rank, rank)
        where p.id = u.id`,
        [i, col(p => p.id), col(p => p.score), col(p => p.last_points), col(p => p.streak), col(p => p.best_streak),
          col(p => p.correct_count), col(p => p.correct_ms),
          col(p => (i > 0 ? before.get(p.id) : null)), col(p => after.get(p.id))]);
      return hydrate(row);
    });
    forget(game.pin);
    return revealed;
  }

  /* ---------- what each screen sees ---------- */

  /* Everything anyone in the room may see: the projector, the leaderboard
   * screen and the shared half of every phone. No correct answer before the
   * reveal and nobody's choices — only how many have answered. */
  async function publicView(game) {
    const v = {
      id: game.id,   // results are behind the admin password; the id alone opens nothing
      pin: game.pin,
      title: game.title,
      status: game.status,
      phase: game.phase,
      index: game.index,
      total: game.round.length,
      joinUrl: game.joinUrl,
      locked: game.locked,
      now: Date.now()
    };
    if (game.status === "abandoned") return v;
    const [players, counts] = await Promise.all([
      activePlayers(game.id),
      game.phase === "question" || game.phase === "reveal" ? choiceCounts(game) : null
    ]);
    const q = game.round[game.index];
    v.players = players.length;
    if (game.phase === "lobby") v.roster = players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar }));
    if (game.phase === "question") {
      v.question = {
        prompt: q.prompt, options: q.options, category: q.category,
        opensAt: game.opensAt, deadline: game.deadline, limitMs: game.limitMs
      };
      v.answered = counts.reduce((a, b) => a + b, 0);
    }
    if (game.phase === "reveal") {
      v.question = { prompt: q.prompt, options: q.options, category: q.category };
      v.reveal = {
        answer: q.answer,
        explanation: q.explanation,
        counts,
        answered: counts.reduce((a, b) => a + b, 0),
        correct: counts[q.answer]
      };
    }
    if (game.closedCount > 0) v.leaderboard = board(players, BOARD_SIZE);
    if (game.phase === "final") v.awards = game.awards ?? [];
    return v;
  }

  /* publicView, reused for half a second within this process: sixty phones
   * polling every second cost the database a couple of queries, not sixty. */
  async function publicState(pin) {
    const hit = viewCache.get(pin);
    if (hit && Date.now() - hit.at < VIEW_CACHE_MS) return hit.view;
    const game = await current(pin);
    const view = game ? await publicView(game) : null;
    if (viewCache.size > 1000) viewCache.clear();
    viewCache.set(pin, { at: Date.now(), view });
    return view;
  }

  /* The private half of one phone: its own answer, its result once the
   * question is revealed, and where it stands. */
  async function playerView(game, p) {
    const key = `${p.id}:${game.status}:${game.phase}:${game.index}`;
    const hit = meCache.get(key);
    if (hit && Date.now() - hit.at < VIEW_CACHE_MS) return { ...hit.view, now: Date.now() };
    const view = await buildPlayerView(game, p);
    if (meCache.size > 5000) meCache.clear();
    meCache.set(key, { at: Date.now(), view });
    return view;
  }

  async function buildPlayerView(game, p) {
    const v = {
      pin: game.pin,
      status: game.status,
      phase: game.phase,
      index: game.index,
      now: Date.now()
    };
    if (p.kicked) return { ...v, kicked: true };
    v.me = { id: p.id, nickname: p.nickname, avatar: p.avatar, score: p.score, streak: p.streak };
    if (game.status === "abandoned") return v;

    // The phone's trail of dots: one per revealed question, right, wrong or unanswered.
    if (game.closedCount > 0) {
      const { rows } = await pool.query(
        "select question_index, correct from answers where player_id = $1 and question_index < $2", [p.id, game.closedCount]);
      v.history = Array.from({ length: game.closedCount }, () => null);
      for (const r of rows) v.history[r.question_index] = r.correct;
    }
    if (game.phase === "question" || game.phase === "reveal") {
      const { rows: [a] } = await pool.query(
        "select choice, correct, bonus from answers where player_id = $1 and question_index = $2", [p.id, game.index]);
      if (game.phase === "question") v.choice = a ? a.choice : null;
      else {
        v.result = {
          choice: a ? a.choice : null,
          correct: !!a?.correct,
          points: p.last_points,
          bonus: a?.correct ? a.bonus : 0
        };
      }
    }
    if (game.closedCount > 0 && game.phase !== "question") {
      const players = await activePlayers(game.id);
      const list = ranked(players);
      const at = list.findIndex(x => x.id === p.id);
      const ahead = at > 0 ? list[at - 1] : null;
      v.standing = {
        rank: at + 1,
        of: list.length,
        move: p.prev_rank && p.rank ? p.prev_rank - p.rank : 0,
        ahead: ahead ? { nickname: ahead.nickname, avatar: ahead.avatar, gap: ahead.score - p.score } : null
      };
      if (game.phase === "final") {
        v.final = {
          correct: p.correct_count,
          played: game.closedCount,
          bestStreak: p.best_streak,
          avgCorrectMs: p.correct_count ? Math.round(Number(p.correct_ms) / p.correct_count) : null,
          podium: board(players, 3),
          badges: badgesFor(p, at + 1, game.closedCount, game.awards ?? [])
        };
      }
    }
    return v;
  }

  /* ---------- small queries ---------- */

  async function activePlayers(gameId) {
    const { rows } = await pool.query(`
      select id, nickname, avatar, score, last_points, streak, rank, prev_rank, correct_ms, joined_at
      from players where game_id = $1 and not kicked order by joined_at, id`, [gameId]);
    return rows;
  }

  async function choiceCounts(game) {
    const counts = game.round[game.index].options.map(() => 0);
    const { rows } = await pool.query(`
      select a.choice, count(*) as n from answers a join players p on p.id = a.player_id and not p.kicked
      where a.game_id = $1 and a.question_index = $2 group by a.choice`, [game.id, game.index]);
    for (const r of rows) if (r.choice in counts) counts[r.choice] = r.n;
    return counts;
  }

  /* How many times key has been hit in its current window. */
  async function used(key) {
    const { rows: [r] } = await pool.query(
      "select count from rate_limits where key = $1 and reset_at > $2", [key.slice(0, 200), Date.now()]);
    return r ? r.count : 0;
  }

  /* Takes back one hit, for an attempt that turned out to be legitimate. */
  async function forgive(key) {
    await pool.query("update rate_limits set count = greatest(count - 1, 0) where key = $1", [key.slice(0, 200)]);
  }

  /* A fixed-window counter in the database, shared by every instance.
   * True while key has been hit at most max times in the window. */
  async function hit(key, max, windowMs) {
    const now = Date.now();
    const { rows: [r] } = await pool.query(`
      insert into rate_limits (key, count, reset_at) values ($1, 1, $2::bigint + $3::bigint)
      on conflict (key) do update set
        count = case when rate_limits.reset_at <= $2 then 1 else rate_limits.count + 1 end,
        reset_at = case when rate_limits.reset_at <= $2 then $2::bigint + $3::bigint else rate_limits.reset_at end
      returning count`, [key.slice(0, 200), now, windowMs]);
    if (Math.random() < 0.01) pool.query("delete from rate_limits where reset_at < $1", [now - 86_400_000]).catch(() => {});
    return r.count <= max;
  }

  function forget(pin) {
    viewCache.delete(pin);
  }

  return {
    find, current, create, join, player, next, end, kick, lock, answer,
    publicView, publicState, playerView, hit, used, forgive
  };
}

/* ---------- pure helpers ---------- */

/* The questions for one game: filtered to a category if one is given,
 * shuffled if the settings say so, options shuffled once per game so the
 * projector and every phone show them in the same order. */
export function buildRound(questions, settings, category = "") {
  let pool = category ? questions.filter(q => q.category === category) : questions.slice();
  if (settings.shuffleQuestions) pool = shuffle(pool);
  return pool.slice(0, settings.questionsPerRound).map(q => {
    const order = q.options.map((_, i) => i);
    const shown = settings.shuffleOptions ? shuffle(order) : order;
    return {
      id: q.id,
      category: q.category,
      difficulty: q.difficulty,
      prompt: q.prompt,
      options: shown.map(i => q.options[i]),
      answer: shown.indexOf(q.answer),
      explanation: q.explanation
    };
  });
}

/* How long an answer took. The server's own measure includes the trip from
 * the phone and, now and then, a cold start; the phone's measure does not,
 * but a phone can lie. Believe the phone by up to LATENCY_MS and no more. */
export function fairElapsed(serverElapsed, clientElapsed, limitMs) {
  const claimed = Number.isFinite(clientElapsed) ? clientElapsed : serverElapsed;
  const ms = Math.max(serverElapsed - LATENCY_MS, Math.min(claimed, serverElapsed));
  return Math.round(Math.min(limitMs, Math.max(0, ms)));
}

/* Highest score first; equal scores go to whoever was quicker on the
 * answers they got right, then to whoever joined first. */
export function ranked(players) {
  return players.slice().sort((a, b) =>
    b.score - a.score || a.correct_ms - b.correct_ms || a.joined_at - b.joined_at || (a.id < b.id ? -1 : 1));
}

function ranks(players) {
  return new Map(ranked(players).map((p, i) => [p.id, i + 1]));
}

function board(players, size) {
  return ranked(players).slice(0, size).map((p, i) => ({
    id: p.id,
    rank: i + 1,
    nickname: p.nickname,
    avatar: p.avatar,
    score: p.score,
    gained: p.last_points,
    move: p.prev_rank && p.rank ? p.prev_rank - p.rank : 0,
    streak: p.streak
  }));
}

/* The end-of-game awards, each to one player: the fastest average correct
 * answer, the longest streak and the biggest climb since half-time. */
export function computeAwards(players, played) {
  const list = ranked(players);
  const who = p => ({ playerId: p.id, nickname: p.nickname, avatar: p.avatar });
  const awards = [];

  const avg = p => p.correct_ms / p.correct_count;
  const minCorrect = Math.max(1, Math.ceil(played / 2));
  const fastest = list.filter(p => p.correct_count >= minCorrect)
    .reduce((best, p) => (!best || avg(p) < avg(best) ? p : best), null);
  if (fastest) {
    awards.push({ key: "fastest", emoji: "⚡", title: "Fastest finger", ...who(fastest),
      detail: `${(avg(fastest) / 1000).toFixed(1)}s per correct answer` });
  }

  const streaker = list.reduce((best, p) => (p.best_streak >= 3 && p.best_streak > (best?.best_streak ?? 0) ? p : best), null);
  if (streaker) {
    awards.push({ key: "streak", emoji: "🔥", title: "Longest streak", ...who(streaker),
      detail: `${streaker.best_streak} right in a row` });
  }

  if (played >= 4) {
    const half = String(Math.floor((played - 1) / 2));
    let best = null;
    let climb = 2;
    list.forEach((p, i) => {
      const then = p.ranks?.[half];
      if (then && then - (i + 1) > climb) {
        climb = then - (i + 1);
        best = p;
      }
    });
    if (best) {
      awards.push({ key: "comeback", emoji: "📈", title: "Comeback", ...who(best),
        detail: `up ${climb} places since half-time` });
    }
  }
  return awards;
}

function badgesFor(p, rank, played, awards) {
  const badges = [];
  if (rank === 1) badges.push({ emoji: "🏆", title: "Winner" });
  else if (rank === 2) badges.push({ emoji: "🥈", title: "Runner-up" });
  else if (rank === 3) badges.push({ emoji: "🥉", title: "Third place" });
  if (played >= 3 && p.correct_count === played) badges.push({ emoji: "💯", title: "Flawless" });
  for (const a of awards) {
    if (a.playerId === p.id) badges.push({ emoji: a.emoji, title: a.title, detail: a.detail });
  }
  if (p.best_streak >= 3 && !awards.some(a => a.key === "streak" && a.playerId === p.id)) {
    badges.push({ emoji: "🔥", title: "On fire", detail: `${p.best_streak} right in a row` });
  }
  return badges;
}

/* A games row plus the numbers every rule needs. */
function hydrate(row) {
  const round = row.round;
  const total = round.length;
  const index = row.current_index;
  const closedCount = index < 0 ? 0 : row.phase === "question" ? index : index + 1;
  return {
    id: row.id,
    pin: row.pin,
    quizId: row.quiz_id,
    title: row.title,
    status: row.status,
    phase: row.phase,
    index,
    opensAt: row.opens_at,
    deadline: row.deadline,
    joinUrl: row.join_url,
    settings: row.settings,
    round,
    awards: row.awards,
    locked: row.locked,
    limitMs: row.settings.secondsPerQuestion * 1000,
    isLast: index === total - 1,
    isOver: row.status === "finished" || row.status === "abandoned",
    closedCount
  };
}

async function answerCounts(c, gameId, index) {
  const { rows: [n] } = await c.query(`
    select (select count(*) from answers a join players p on p.id = a.player_id and not p.kicked
            where a.game_id = $1 and a.question_index = $2) as answered,
           (select count(*) from players where game_id = $1 and not kicked) as players`, [gameId, index]);
  return n;
}

function hash(token) {
  return createHash("sha256").update(token).digest("base64url");
}
