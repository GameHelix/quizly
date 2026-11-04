/* The standalone server, server/index.js, as `npm start` runs it: a reload
 * onto new code that refuses no one, a crashed worker replaced, a stop that
 * ends every live stream at once instead of making screens wait, and the
 * signals that arrive twice or too early.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { ROOT } from "../server/config.js";
import { PASSWORD, client, databaseUrl, resetDatabase } from "./helpers.js";

const url = databaseUrl("server");   // its own database: node --test runs this file beside the others
let server;
let pin;

before(async () => {
  await resetDatabase(url);
  server = await startServer();
  const admin = client(server.base);
  await admin("POST", "/api/auth/login", { password: PASSWORD });
  const quiz = (await admin("POST", "/api/admin/quizzes", { data: sample() })).data;
  pin = (await admin("POST", "/api/host/games", { quizId: quiz.id })).data.pin;
  assert.equal((await client(server.base)("POST", `/api/games/${pin}/players`, { nickname: "Stayer" })).status, 201);
});

after(() => server?.child.kill("SIGKILL"));

test("a reload hands every screen to a worker on the new code, and refuses no one", async () => {
  const first = server.pids();
  assert.equal(first.length, 1);
  const stream = await openStream();
  assert.equal((await stream.next()).players, 1);

  // Requests on new connections all the way through the reload: every one must be answered.
  const hammer = keepAsking(`/api/games/${pin}`);
  await pause(200);
  server.child.kill("SIGHUP");
  await stream.ended(5000);   // the old worker ends its streams once the new one is serving
  await until(() => server.pids().length === 2, 10_000, "a second worker never said it was running");
  const fresh = await openStream();
  assert.equal((await fresh.next()).players, 1, "the new worker serves the same game");
  await pause(300);
  const { ok, failed } = await hammer.stop();
  assert.ok(ok > 50, `requests kept flowing (${ok})`);
  assert.deepEqual(failed, [], "no request was refused or dropped during the reload");
  await until(() => !alive(first[0]), 10_000, "the old worker never exited");
  fresh.close();
});

test("a worker that crashes is replaced", async () => {
  const workers = server.pids();
  process.kill(workers.at(-1), "SIGKILL");
  await until(() => server.pids().length === workers.length + 1, 10_000, "no worker was started in its place");
  const r = await get("/api/health");
  assert.equal(r.status, 200);
});

test("two reloads close together leave one worker serving, and the supervisor standing", async () => {
  const workers = server.pids();
  server.child.kill("SIGHUP");
  await until(() => server.pids().length === workers.length + 1, 10_000, "the first reload never started a worker");
  await pause(700);   // the first retired worker is draining, or gone, when the second reload retires it again
  server.child.kill("SIGHUP");
  await until(() => server.pids().length === workers.length + 2, 10_000, "the second reload never started a worker");
  await until(() => server.pids().filter(alive).length === 1, 10_000, "more than one worker kept running");
  assert.equal(server.child.exitCode, null, "the supervisor is still running");
  assert.equal((await get("/api/health")).status, 200);
});

test("stopping ends every live stream at once and exits, even when the stop arrives twice", async () => {
  const stream = await openStream();
  await stream.next();
  const exited = new Promise(resolve => server.child.once("exit", code => resolve(code)));
  const asked = Date.now();
  // One Ctrl-C under npm reaches the supervisor twice: from the terminal and from npm.
  server.child.kill("SIGINT");
  server.child.kill("SIGINT");
  await stream.ended(1500);
  assert.ok(Date.now() - asked < 1500, `the stream ended at once (${Date.now() - asked} ms), not after it ran out`);
  const code = await Promise.race([exited, pause(4000).then(() => "still running")]);
  assert.equal(code, 0);
  assert.ok(Date.now() - asked < 4000, `the server was gone within ${Date.now() - asked} ms`);
  assert.ok(!server.pids().some(alive), "no worker was left behind");
});

test("a server waiting for its database stops when asked", async () => {
  // Nothing listens on this port: the worker waits for the database, retrying.
  const waiting = await startServer({ databaseUrl: `postgres://quizly:quizly@127.0.0.1:${await freePort()}/quizly`, ready: / waiting for the database/ });
  const exited = new Promise(resolve => waiting.child.once("exit", code => resolve(code)));
  waiting.child.kill("SIGTERM");
  const code = await Promise.race([exited, pause(4000).then(() => "still running")]);
  assert.equal(code, 0, "a stop asked while it starts is not lost");
});

/* ---------- helpers ---------- */

async function startServer({ databaseUrl = url, ready = / quizly is running / } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: databaseUrl,
      ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: "y".repeat(64)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const s = { child, base: `http://127.0.0.1:${port}`, log: "" };
  child.stdout.on("data", d => { s.log += d; });
  child.stderr.on("data", d => { s.log += d; });
  // The worker of each " quizly is running" line, in order.
  s.pids = () => [...s.log.matchAll(/ quizly is running .*worker=(\d+)/g)].map(m => Number(m[1]));
  await until(() => ready.test(s.log), 15_000, () => `the server did not start:\n${s.log}`);
  return s;
}

/* A live stream on a connection of its own, read one state at a time. */
async function openStream() {
  const res = await fetch(`${server.base}/api/games/${pin}/live`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const read = async ms => {
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(resolve, ms, { late: true }); });
    const chunk = await Promise.race([reader.read(), late]).catch(() => ({ done: true }));
    clearTimeout(timer);
    if (chunk.late) throw new Error(`nothing within ${ms} ms`);
    if (chunk.done) done = true;
    else buffer += decoder.decode(chunk.value, { stream: true });
  };
  return {
    async next(ms = 3000) {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (message.startsWith("data: ")) return JSON.parse(message.slice(6));
          continue;
        }
        if (done) throw new Error("the stream ended");
        await read(ms);
      }
    },
    /* Resolves once the server has ended the stream. */
    async ended(ms) {
      const by = Date.now() + ms;
      while (!done) await read(Math.max(1, by - Date.now()));
    },
    close: () => reader.cancel().catch(() => {})
  };
}

/* GETs path again and again, each on a new connection, until stopped. */
function keepAsking(path) {
  let stopped = false;
  let ok = 0;
  const failed = [];
  const loop = (async () => {
    while (!stopped) {
      const r = await get(path);
      if (r.status === 200) ok += 1;
      else failed.push(r.status || r.error);
      await pause(5);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { ok, failed };
    }
  };
}

function get(p) {
  return new Promise(resolve => {
    const req = http.get(`${server.base}${p}`, { agent: false }, res => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", err => resolve({ status: 0, error: err.code || err.message }));
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

async function until(ok, ms, message) {
  const by = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > by) throw new Error(typeof message === "function" ? message() : message);
    await pause(25);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sample() {
  return JSON.parse(readFileSync(path.join(ROOT, "data", "questions.json"), "utf8"));
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
