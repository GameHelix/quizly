/* What the admin panel shows about games already played: who won, how each
 * question went, and a CSV for the spreadsheet afterwards.
 */

import { UserError } from "./errors.js";
import { ranked } from "./play.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createResults(pool) {
  async function list(limit = 50) {
    const { rows } = await pool.query(`
      select g.id, g.pin, g.title, g.status, g.phase, g.current_index, g.created_at, g.finished_at,
             jsonb_array_length(g.round) as questions,
             (select count(*) from players p where p.game_id = g.id and not p.kicked) as players
      from games g order by g.created_at desc limit $1`, [limit]);
    return rows.map(g => ({
      id: g.id,
      pin: g.pin,
      title: g.title,
      status: g.status,
      createdAt: g.created_at,
      finishedAt: g.finished_at,
      questions: g.questions,
      played: closedCount(g),
      players: g.players
    }));
  }

  /* Standings and per-question numbers, counting only revealed questions. */
  async function get(id) {
    if (!UUID.test(String(id))) throw new UserError("There is no such game", 404);
    const { rows: [g] } = await pool.query("select * from games where id = $1", [id]);
    if (!g) throw new UserError("There is no such game", 404);
    const played = closedCount(g);
    const [{ rows: players }, { rows: stats }] = await Promise.all([
      pool.query(`
        select id, nickname, avatar, score, correct_count, correct_ms, joined_at, best_streak,
               (select count(*) from answers a where a.player_id = p.id and a.question_index < $2) as answered
        from players p where game_id = $1 and not kicked`, [g.id, played]),
      pool.query(`
        select a.question_index, count(*) as answered, count(*) filter (where a.correct) as correct,
               round(avg(a.elapsed_ms)) as avg_ms
        from answers a join players p on p.id = a.player_id and not p.kicked
        where a.game_id = $1 and a.question_index < $2 group by a.question_index`, [g.id, played])
    ]);
    const byIndex = new Map(stats.map(s => [s.question_index, s]));
    return {
      id: g.id,
      pin: g.pin,
      title: g.title,
      status: g.status,
      createdAt: g.created_at,
      finishedAt: g.finished_at,
      awards: g.awards ?? [],
      questions: g.round.slice(0, played).map((q, i) => {
        const s = byIndex.get(i);
        return {
          prompt: q.prompt,
          answer: q.options[q.answer],
          answered: s ? s.answered : 0,
          correct: s ? s.correct : 0,
          avgMs: s ? Number(s.avg_ms) : null
        };
      }),
      standings: ranked(players).map((p, i) => ({
        rank: i + 1,
        nickname: p.nickname,
        avatar: p.avatar,
        score: p.score,
        correct: p.correct_count,
        answered: p.answered,
        bestStreak: p.best_streak,
        avgCorrectMs: p.correct_count ? Math.round(p.correct_ms / p.correct_count) : null
      }))
    };
  }

  async function csv(id) {
    const r = await get(id);
    const rows = [["rank", "nickname", "score", "correct", "answered", "questions", "best_streak", "avg_correct_seconds"]];
    for (const s of r.standings) {
      rows.push([s.rank, s.nickname, s.score, s.correct, s.answered, r.questions.length, s.bestStreak,
        s.avgCorrectMs == null ? "" : (s.avgCorrectMs / 1000).toFixed(1)]);
    }
    // The BOM makes Excel read the file as UTF-8, so emoji and ə survive.
    return { pin: r.pin, body: "﻿" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n" };
  }

  async function remove(id) {
    if (!UUID.test(String(id))) throw new UserError("There is no such game", 404);
    const { rowCount } = await pool.query("delete from games where id = $1 and status not in ('lobby', 'running')", [id]);
    if (!rowCount) throw new UserError("Only finished games can be deleted", 409);
  }

  return { list, get, csv, remove };
}

/* Quotes what needs quoting, and keeps a nickname such as =HYPERLINK(…)
 * from running as a formula when the file is opened in a spreadsheet. */
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function closedCount(g) {
  if (g.current_index < 0) return 0;
  return g.phase === "question" ? g.current_index : g.current_index + 1;
}
