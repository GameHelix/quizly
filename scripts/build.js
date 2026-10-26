/* `npm run build`, which is also Vercel's build command:
 *   1. assembles public/ — what the CDN serves — from client/ plus shared/
 *   2. brings the database schema up to date
 * There is nothing to compile: the browser runs client/ as written.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../server/config.js";
import { migrateUrl } from "../server/db.js";

const out = path.join(ROOT, "public");
rmSync(out, { recursive: true, force: true });
cpSync(path.join(ROOT, "client"), out, { recursive: true });
cpSync(path.join(ROOT, "shared"), path.join(out, "shared"), { recursive: true });
for (const page of ["index.html", "host.html", "board.html", "admin.html", "404.html", "favicon.ico", "shared/quiz.js"]) {
  if (!existsSync(path.join(out, page))) throw new Error(`build: public/${page} is missing`);
}
console.log("build: public/ assembled from client/ and shared/");

if (process.env.DATABASE_URL) {
  const applied = await migrateUrl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  console.log(applied.length ? `build: migrations applied: ${applied.join(", ")}` : "build: database schema is up to date");
} else if (process.env.VERCEL) {
  throw new Error("build: DATABASE_URL is not set — attach the Neon database to this Vercel project");
} else {
  console.log("build: DATABASE_URL is not set, so migrations were skipped");
}
