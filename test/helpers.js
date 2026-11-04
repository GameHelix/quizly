/* Starts the real app on a random port against a throwaway database.
 *
 * TEST_DATABASE_URL names it (default: quizly_test in the docker compose
 * Postgres). Its public schema is dropped and rebuilt on every run, so the
 * helper refuses any host but this machine unless ALLOW_TEST_DB_RESET=1.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import pg from "pg";
import { createApp } from "../server/app.js";
import { createAuth } from "../server/auth.js";
import { ROOT } from "../server/config.js";
import { createPool, migrate } from "../server/db.js";
import { createPlay } from "../server/play.js";
import { createQuizzes } from "../server/quizzes.js";
import { createResults } from "../server/results.js";

export const PASSWORD = "test-password-123";
const DEFAULT_URL = "postgres://quizly:quizly@localhost:5435/quizly_test";

/* The test database, or a sibling of it for a test file that must not share
 * one: node --test runs the files side by side. */
export function databaseUrl(suffix = "") {
  const url = new URL(process.env.TEST_DATABASE_URL || DEFAULT_URL);
  if (suffix) url.pathname = `${url.pathname}_${suffix}`;
  return url.toString();
}

export async function startTestApp({ leadInMs = 0 } = {}) {
  const url = databaseUrl();
  await resetDatabase(url);
  const pool = createPool(url);
  await migrate(pool);
  await pool.end();
  return startInstance(url, { leadInMs });
}

/* One instance of the app on a database that is already set up — a second
 * one stands for another instance behind the load balancer. listen: false is
 * an instance that cannot hear announcements (a pooled URL only); liveTickMs and quietLookMs
 * are how often its feeds look for changes without one. */
export async function startInstance(url, { leadInMs = 0, listen = true, listenUrl, liveTickMs, quietLookMs } = {}) {
  const pool = createPool(url);
  const quizzes = createQuizzes(pool);
  const config = {
    publicUrl: "", trustProxy: false, port: 0,
    adminPassword: PASSWORD, sessionSecret: "x".repeat(64), maxPlayers: 300
  };
  const context = {
    config, pool, quizzes,
    play: createPlay({ pool, quizzes, maxPlayers: 300, leadInMs, listenUrl: listen ? listenUrl ?? url : "", liveTickMs, quietLookMs }),
    results: createResults(pool),
    auth: createAuth({ password: PASSWORD, secret: config.sessionSecret })
  };
  const server = createServer(createApp(context));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.port = server.address().port;

  return {
    base,
    url,
    context,
    sample: () => JSON.parse(readFileSync(path.join(ROOT, "data", "questions.json"), "utf8")),
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await context.play.close();
      await pool.end();
    }
  };
}

/* A tiny HTTP client: JSON in and out, a cookie jar, the status alongside the body. */
export function client(base) {
  let cookie = "";
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

export async function resetDatabase(url) {
  const target = new URL(url);
  if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname) && process.env.ALLOW_TEST_DB_RESET !== "1") {
    throw new Error(`refusing to reset ${target.hostname}: tests drop the schema. Set ALLOW_TEST_DB_RESET=1 if you mean it.`);
  }
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = new pg.Client({ connectionString: admin.toString() });
  await server.connect();
  try {
    await server.query(`create database ${pg.escapeIdentifier(target.pathname.slice(1))}`);
  } catch (err) {
    if (err.code !== "42P04") throw err;   // already exists
  } finally {
    await server.end();
  }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("drop schema if exists public cascade; create schema public;");
  await db.end();
}
