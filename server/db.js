/* Postgres through node-postgres. One small pool per process, which on
 * Vercel means per warm function instance. Neon's connection pooler sits
 * in front of the database, so many instances never exhaust it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT } from "./config.js";
import { log } from "./errors.js";

// bigint (int8) as a JS number: counts and epoch milliseconds both fit.
pg.types.setTypeParser(20, Number);

const MIGRATIONS_DIR = path.join(ROOT, "server", "migrations");

export function createPool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is not set — see .env.example");
  const pool = new pg.Pool({
    connectionString: strictTls(connectionString),
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000
  });
  pool.on("error", err => log.error("idle database connection failed", { err }));
  return pool;
}

/* Neon hands out URLs with sslmode=require. node-postgres reads that as
 * verify-full today but has announced it will weaken to libpq's meaning
 * (encrypt, don't verify) in v9; asking for verify-full keeps today's check. */
function strictTls(connectionString) {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

/* Runs the migrations over a pool of their own on the given URL — the
 * direct one on Neon — and closes it again. */
export async function migrateUrl(connectionString) {
  const pool = createPool(connectionString);
  try {
    return await migrate(pool);
  } finally {
    await pool.end();
  }
}

/* Runs fn(client) in a transaction and returns what it returns. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* Applies server/migrations/*.sql in name order, each once, all in one
 * transaction: a failure leaves the schema as it was. An advisory lock
 * keeps two deploys from racing. */
export async function migrate(pool) {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  return tx(pool, async c => {
    await c.query("select pg_advisory_xact_lock(727274)");
    await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await c.query("select name from schema_migrations")).rows.map(r => r.name));
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await c.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await c.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
    return applied;
  });
}
