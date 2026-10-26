/* The quiz library: each quiz is a title, its round settings and its
 * questions, all in Postgres. Nothing is read from files at runtime. A quiz
 * file (data/questions.json is one) is only an import and export format.
 *
 * A game copies what it needs from its quiz when it is created. Editing or
 * deleting a quiz never reaches a game already being played, nor the
 * results of one that has finished.
 */

import { randomUUID } from "node:crypto";
import { cleanTitle, normalise, normaliseQuestion, normaliseSettings, questionProblem } from "../shared/quiz.js";
import { tx } from "./db.js";
import { UserError } from "./errors.js";

export const MAX_QUESTIONS = 500;

export function createQuizzes(pool) {
  /* Every quiz with its size and categories: what the host picks from. */
  async function list() {
    const { rows } = await pool.query(`
      select z.id, z.title, z.updated_at,
             count(q.id)::int as questions,
             coalesce(array_agg(distinct q.category) filter (where q.category is not null), '{}') as categories
      from quizzes z left join questions q on q.quiz_id = z.id
      group by z.id order by z.created_at, z.id`);
    return rows.map(z => ({
      id: z.id,
      title: z.title,
      questions: z.questions,
      categories: z.categories.sort(),
      updatedAt: z.updated_at
    }));
  }

  /* One quiz in the shape of a quiz file, plus its id. */
  async function get(id) {
    const { rows: [z] } = await pool.query("select * from quizzes where id = $1", [String(id)]);
    if (!z) throw new UserError("There is no such quiz", 404);
    const { rows } = await pool.query("select * from questions where quiz_id = $1 order by position, id", [z.id]);
    return {
      id: z.id,
      version: 1,
      title: z.title,
      settings: normaliseSettings(z.settings),
      questions: rows.map(r => ({
        id: r.id,
        category: r.category,
        difficulty: r.difficulty,
        prompt: r.prompt,
        options: r.options,
        answer: r.answer,
        explanation: r.explanation
      }))
    };
  }

  /* A new quiz: empty, or filled from a quiz file. */
  async function create({ title, data } = {}) {
    const quiz = data ? checkedFile(data) : { title: "", settings: normaliseSettings({}), questions: [] };
    const name = cleanTitle(title) || quiz.title || "Untitled quiz";
    const id = randomUUID().slice(0, 8);
    await tx(pool, async c => {
      await c.query("insert into quizzes (id, title, settings) values ($1, $2, $3)", [id, name, JSON.stringify(quiz.settings)]);
      await insertQuestions(c, id, quiz.questions);
    });
    return get(id);
  }

  async function rename(id, title) {
    const name = cleanTitle(title);
    if (!name) throw new UserError("The quiz needs a title");
    const { rowCount } = await pool.query("update quizzes set title = $2, updated_at = now() where id = $1", [String(id), name]);
    if (!rowCount) throw new UserError("There is no such quiz", 404);
    return get(id);
  }

  async function remove(id) {
    const { rowCount } = await pool.query("delete from quizzes where id = $1", [String(id)]);
    if (!rowCount) throw new UserError("There is no such quiz", 404);
  }

  async function saveSettings(id, raw) {
    const settings = normaliseSettings(raw);
    const { rowCount } = await pool.query("update quizzes set settings = $2, updated_at = now() where id = $1",
      [String(id), JSON.stringify(settings)]);
    if (!rowCount) throw new UserError("There is no such quiz", 404);
    return settings;
  }

  /* Creates the question if its id is new to the quiz, otherwise updates it in place. */
  async function saveQuestion(id, raw) {
    const q = normaliseQuestion(raw);
    const problem = questionProblem(q);
    if (problem) throw new UserError(problem);
    return tx(pool, async c => {
      const { rows: [z] } = await c.query("select id from quizzes where id = $1 for update", [String(id)]);
      if (!z) throw new UserError("There is no such quiz", 404);
      const { rows: [n] } = await c.query(`
        select count(*)::int as total, coalesce(max(position), 0) + 1 as next,
               bool_or(id = $2) as exists
        from questions where quiz_id = $1`, [z.id, q.id]);
      if (!n.exists && n.total >= MAX_QUESTIONS) throw new UserError(`A quiz holds at most ${MAX_QUESTIONS} questions`);
      await c.query(`
        insert into questions (quiz_id, id, position, category, difficulty, prompt, options, answer, explanation)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (quiz_id, id) do update set
          category = excluded.category, difficulty = excluded.difficulty, prompt = excluded.prompt,
          options = excluded.options, answer = excluded.answer, explanation = excluded.explanation,
          updated_at = now()`,
        [z.id, q.id, n.next, q.category, q.difficulty, q.prompt, JSON.stringify(q.options), q.answer, q.explanation]);
      await c.query("update quizzes set updated_at = now() where id = $1", [z.id]);
      return q;
    });
  }

  async function deleteQuestion(id, questionId) {
    const { rowCount } = await pool.query("delete from questions where quiz_id = $1 and id = $2", [String(id), String(questionId)]);
    if (!rowCount) throw new UserError("There is no such question", 404);
    await pool.query("update quizzes set updated_at = now() where id = $1", [String(id)]);
  }

  /* Swaps a quiz's questions and settings for those in a quiz file, or
   * changes nothing at all if any part of the file is invalid. */
  async function replace(id, data) {
    const quiz = checkedFile(data);
    await tx(pool, async c => {
      const { rowCount } = await c.query(`
        update quizzes set settings = $2, title = coalesce(nullif($3, ''), title), updated_at = now()
        where id = $1`, [String(id), JSON.stringify(quiz.settings), quiz.title]);
      if (!rowCount) throw new UserError("There is no such quiz", 404);
      await c.query("delete from questions where quiz_id = $1", [String(id)]);
      await insertQuestions(c, String(id), quiz.questions);
    });
    return get(id);
  }

  return { list, get, create, rename, remove, saveSettings, saveQuestion, deleteQuestion, replace };
}

async function insertQuestions(c, quizId, questions) {
  if (!questions.length) return;
  await c.query(`
    insert into questions (quiz_id, id, position, category, difficulty, prompt, options, answer, explanation)
    select $1, q.id, q.position, q.category, q.difficulty, q.prompt, q.options, q.answer, q.explanation
    from jsonb_to_recordset($2::jsonb) as q(id text, position int, category text, difficulty text,
                                            prompt text, options jsonb, answer int, explanation text)`,
    [quizId, JSON.stringify(questions.map((q, i) => ({ ...q, position: i + 1 })))]);
}

/* A quiz file, normalised and checked question by question. */
function checkedFile(data) {
  const quiz = normalise(data);
  if (!quiz.questions.length) throw new UserError("There are no questions in that file");
  if (quiz.questions.length > MAX_QUESTIONS) throw new UserError(`A quiz holds at most ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  quiz.questions.forEach((q, i) => {
    const problem = questionProblem(q);
    if (problem) throw new UserError(`Question ${i + 1} (${q.id}): ${problem}`);
    if (seen.has(q.id)) throw new UserError(`Two questions share the id ${q.id}`);
    seen.add(q.id);
  });
  return quiz;
}
