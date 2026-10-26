/* `npm run db:seed [-- path/to/quiz.json]`: imports a quiz file into the
 * database as a new quiz — data/questions.json unless another file is
 * named. Skips the import if a quiz with the same title already exists, so
 * running it twice is harmless; add --force to import a second copy.
 *
 * The admin panel's "Import a quiz file" does the same from the browser.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../server/config.js";
import { createPool, migrateUrl } from "../server/db.js";
import { createQuizzes } from "../server/quizzes.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const file = path.resolve(args.find(a => !a.startsWith("--")) ?? path.join(ROOT, "data", "questions.json"));

await migrateUrl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
const pool = createPool(process.env.DATABASE_URL);
try {
  const quizzes = createQuizzes(pool);
  const data = JSON.parse(readFileSync(file, "utf8"));
  const existing = (await quizzes.list()).find(q => q.title === (data.title || "").trim());
  if (existing && !force) {
    console.log(`"${existing.title}" is already in the database (${existing.questions} questions) — nothing imported. Use --force for a second copy.`);
  } else {
    const quiz = await quizzes.create({ data });
    console.log(`imported "${quiz.title}": ${quiz.questions.length} questions, id ${quiz.id}`);
  }
} finally {
  await pool.end();
}
