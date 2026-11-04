/* Runs one stress scenario for scripts/stress-test.js. On this machine it
 * prepares a database of its own, starts the Quizly instances and slow-line
 * relays the scenario asks for, then the phone processes, and samplers that
 * watch the servers and the database while the games run. Against a --url it
 * starts only the phones. It returns what every process measured, merged.
 */

import { execFile, fork, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { ROOT } from "../../server/config.js";
import { createPool, migrateUrl } from "../../server/db.js";
import { createQuizzes } from "../../server/quizzes.js";
import { Hist } from "./hist.js";

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export const STRESS_DB = process.env.STRESS_DATABASE_URL || "postgres://quizly:quizly@localhost:5435/quizly_stress";
const PASSWORD = "stress-test-password-0123";   // production rules: 16 characters or more
const SECRET = "s".repeat(64);                  // shared, so every instance accepts the host's cookie
const PHONES_PER_PROCESS = 1250;

export async function runScenario(o) {
  const local = !o.url;
  const startedAt = Date.now();
  const children = [];
  const servers = [];
  const stormInfo = {};
  let samplers = [];
  try {
    let bases;
    let mobileBases = [];
    let quizId;
    let password = o.password;
    if (local) {
      quizId = await prepareDatabase(STRESS_DB);
      password = PASSWORD;
      for (let i = 0; i < o.instances; i++) servers.push(await startServer(await freePort(), o));
      // Two addresses per instance: the phones' sockets share out over both,
      // so one machine is not limited to one address's 16,384 outgoing ports.
      bases = servers.flatMap(s => [`http://127.0.0.1:${s.port}`, `http://[::1]:${s.port}`]);
      if (o.mobile > 0) {
        for (const s of servers) {
          const port = await freePort();
          children.push(await started(fork(path.join(ROOT, "scripts", "stress", "slownet.js"), [String(port), String(s.port)], { stdio: "ignore" })));
          mobileBases.push(`http://127.0.0.1:${port}`);
        }
      }
      samplers = [sampleServers(servers), await sampleDatabase(), await sampleContainer()];
    } else {
      bases = [o.url];
      mobileBases = bases;
      quizId = await findQuiz(o.url, password);
    }

    const phones = o.games * o.players;
    const processes = o.workers || Math.max(1, Math.min(8, Math.ceil(phones / PHONES_PER_PROCESS)));
    const workers = [];
    for (let w = 0; w < processes; w++) {
      const slots = Array.from({ length: o.games }, (_, i) => i).filter(i => i % processes === w);
      if (!slots.length) continue;
      const child = fork(path.join(ROOT, "scripts", "stress", "phones.js"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      children.push(child);
      workers.push(child);
      child.send({
        type: "start",
        cfg: {
          worker: w, slots, bases, mobileBases, password, quizId,
          route: "random", sameClock: local,
          players: o.players, questions: o.questions, joinWindowMs: o.join * 1000,
          answers: o.answers, away: o.away, slow: o.slow, mobile: o.mobile, ips: o.ips, storm: o.storm,
          soakUntil: o.soak ? startedAt + o.soak * 60_000 : 0
        }
      });
    }
    await Promise.all(workers.map(w => message(w, "ready")));

    // The storm hits once half the games have been in the chosen question for a few seconds.
    const opened = new Map();
    let stormed = false;
    const results = [];
    const done = Promise.all(workers.map(w => new Promise(resolve => {
      w.on("message", msg => {
        if (msg.type === "result") {
          results.push(msg);
          resolve();
        } else if (msg.type === "question" && o.storm !== "none" && !stormed) {
          opened.set(msg.index, (opened.get(msg.index) ?? 0) + 1);
          if (msg.index === o.stormAt - 1 && opened.get(msg.index) >= Math.ceil(o.games / 2)) {
            stormed = true;
            setTimeout(() => storm(o, workers, servers, stormInfo), 4000);
          }
        }
      });
      w.on("exit", resolve);
    })));
    for (const w of workers) w.send({ type: "go" });
    const limitMs = (o.join + o.questions * 45 + 90 + o.soak * 60) * 1000;
    const finished = await Promise.race([done.then(() => true), pause(limitMs).then(() => false)]);

    return {
      options: o,
      seconds: (Date.now() - startedAt) / 1000,
      timedOut: !finished,
      processes: workers.length,
      ...merge(results),
      servers: local ? summarizeServers(samplers[0].series) : null,
      serverSeries: local ? samplers[0].series : null,   // every second's CPU and memory, for --json
      database: local ? summarizeDatabase(samplers[1].series, samplers[2].series) : null,
      serverErrors: [...servers.flatMap(s => [...s.errors]).reduce((all, [k, n]) => all.set(k, (all.get(k) ?? 0) + n), new Map())]
        .sort((a, b) => b[1] - a[1]),
      storm: stormInfo
    };
  } finally {
    for (const s of samplers) await s.stop();
    for (const c of children) c.kill("SIGKILL");
    // A CPU profile is written as a process exits on its own: stop those servers as a deploy would.
    await Promise.all(servers.map(s => (o.profile ? stopped(s.child) : s.child.kill("SIGKILL"))));
  }
}

function stopped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise(resolve => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/* ---------- the storm ---------- */

/* "drop": every stream is cut at once, as when the venue's Wi-Fi blinks.
 * "restart": every instance is stopped as a deploy stops it, and started again.
 * "reload": every instance is sent SIGHUP, which starts a new worker on the
 * code and retires the old one only once the new one is serving (server/index.js). */
async function storm(o, workers, servers, info) {
  info.at = Date.now();
  for (const w of workers) w.send({ type: "storm", at: info.at });
  if (o.storm === "reload") {
    await Promise.all(servers.map(s => new Promise(resolve => {
      s.waiting.push(resolve);
      s.child.kill("SIGHUP");
    })));
    info.reloadedAfterMs = Date.now() - info.at;
    return;
  }
  if (o.storm !== "restart") return;
  await Promise.all(servers.map(async s => {
    const exited = new Promise(resolve => s.child.once("exit", resolve));
    s.child.kill("SIGTERM");
    await exited;
  }));
  info.downAfterMs = Date.now() - info.at;
  await Promise.all(servers.map(async (s, i) => {
    servers[i] = Object.assign(await startServer(s.port, o), { errors: s.errors });
  }));
  info.upAgainAfterMs = Date.now() - info.at;
}

/* ---------- this machine's Quizly ---------- */

/* A database of the stress tests' own, emptied of games and seeded with the
 * sample quiz: never the one `npm run dev` uses, and never a remote one. */
export async function prepareDatabase(url) {
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && process.env.ALLOW_STRESS_DB_RESET !== "1") {
    throw new Error(`refusing to empty the database on ${u.hostname}: STRESS_DATABASE_URL must point at this machine`);
  }
  const name = decodeURIComponent(u.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await client.query(`create database "${name.replace(/"/g, "")}"`);
  } finally {
    await client.end();
  }
  await migrateUrl(url);
  const pool = createPool(url);
  try {
    await pool.query("truncate games, rate_limits cascade");
    const quizzes = createQuizzes(pool);
    const data = JSON.parse(readFileSync(path.join(ROOT, "data", "questions.json"), "utf8"));
    const existing = (await quizzes.list()).find(q => q.title === data.title);
    return existing?.id ?? (await quizzes.create({ data })).id;
  } finally {
    await pool.end();
  }
}

/* One Quizly process as production runs it — the app's own pool size unless
 * --pool says otherwise, and production's 100 players a game unless the
 * scenario fills bigger ones — with nothing from .env: it can only reach the
 * stress database. */
function startServer(port, { pool, players, profile }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "::",
    DATABASE_URL: STRESS_DB,
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: SECRET,
    TRUST_PROXY: "1",   // as behind a proxy: a phone's address is the one X-Forwarded-For names
    MAX_PLAYERS: String(Math.max(100, players))
  };
  if (pool) env.PG_POOL_MAX = String(pool);
  const flags = profile ? ["--cpu-prof", `--cpu-prof-dir=${path.resolve(profile)}`] : [];
  const child = spawn(process.execPath, [...flags, path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const s = { port, child, errors: new Map(), waiting: [] };   // waiting: called when a (new) worker is serving
  return new Promise((resolve, reject) => {
    const lines = stream => {
      let rest = "";
      stream.on("data", chunk => {
        rest += chunk;
        const all = rest.split("\n");
        rest = all.pop();
        for (const line of all) {
          if (line.includes(" quizly is running")) {
            resolve(s);
            for (const done of s.waiting.splice(0)) done();
          }
          const error = errorKey(line);
          if (error) s.errors.set(error, (s.errors.get(error) ?? 0) + 1);
        }
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    child.once("exit", code => reject(new Error(`Quizly on port ${port} stopped (${code}) before it was running`)));
  });
}

/* "request failed: Error: timeout exceeded when trying to connect", from one of the server's log lines. */
function errorKey(line) {
  const m = / error (.+?)(?= \w+=|$)/.exec(line);
  if (!m) return null;
  const err = /err=("(?:[^"\\]|\\.)*")/.exec(line);
  let first = "";
  try {
    first = err ? JSON.parse(err[1]).split("\n")[0] : "";
  } catch {}
  return first ? `${m[1]}: ${first.slice(0, 140)}` : m[1];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "::", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function started(child) {
  return message(child, "ready").then(() => child);
}

function message(child, type) {
  return new Promise((resolve, reject) => {
    child.on("message", msg => {
      if (msg.type === type) resolve(msg);
      if (msg.type === "failed") reject(new Error(msg.error));
    });
    child.once("exit", code => reject(new Error(`a stress process stopped (${code}) before it was ${type}`)));
  });
}

async function findQuiz(url, password) {
  const login = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!login.ok) throw new Error(`could not sign in to ${url} (${login.status}): pass --password or set ADMIN_PASSWORD`);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const quizzes = await (await fetch(`${url}/api/host/quizzes`, { headers: { cookie } })).json();
  const quiz = quizzes.find(q => q.questions > 0);
  if (!quiz) throw new Error("no quiz with questions to play: import data/questions.json in the admin panel first");
  return quiz.id;
}

/* ---------- watching ---------- */

/* CPU and memory of every instance — its supervisor and its workers
 * together — once a second, from the CPU time each process has used. */
function sampleServers(servers) {
  const series = [];
  const last = new Map();
  const timer = setInterval(async () => {
    try {
      const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,time=,rss="]);
      const t = Date.now();
      const sums = new Map();   // instance → { cpu, rssMb }
      for (const line of stdout.trim().split("\n")) {
        const [pid, ppid, time, rss] = line.trim().split(/\s+/);
        const instance = servers.findIndex(s => String(s.child.pid) === pid || String(s.child.pid) === ppid);
        if (instance < 0) continue;
        const cpuMs = time.split(":").map(Number).reduce((acc, v) => acc * 60 + v, 0) * 1000;
        const prev = last.get(pid);
        last.set(pid, { cpuMs, t });
        const sum = sums.get(instance) ?? sums.set(instance, { cpu: 0, rssMb: 0, measured: false }).get(instance);
        sum.rssMb += Number(rss) / 1024;
        if (prev) {
          sum.cpu += ((cpuMs - prev.cpuMs) / (t - prev.t)) * 100;
          sum.measured = true;
        }
      }
      for (const [instance, { cpu, rssMb, measured }] of sums) if (measured) series.push({ instance, t, cpu, rssMb });
    } catch {}
  }, 1000);
  return { series, stop: () => clearInterval(timer) };
}

/* Transactions and rows a second, and connections, from the database's own counters. */
async function sampleDatabase() {
  const client = new pg.Client({ connectionString: STRESS_DB });
  await client.connect();
  const series = [];
  let prev = null;
  const read = async () => {
    const { rows: [r] } = await client.query(`
      select xact_commit + xact_rollback as tx, tup_returned + tup_fetched as read,
             tup_inserted + tup_updated + tup_deleted as written,
             (select count(*) from pg_stat_activity where datname = current_database()) as connections
      from pg_stat_database where datname = current_database()`);
    const t = Date.now();
    if (prev) {
      const s = (t - prev.t) / 1000;
      series.push({ t, tx: (r.tx - prev.tx) / s, read: (r.read - prev.read) / s, written: (r.written - prev.written) / s, connections: r.connections });
    }
    prev = { ...r, t };
  };
  await read();
  const timer = setInterval(() => read().catch(() => {}), 2000);
  return { series, stop: async () => { clearInterval(timer); await client.end(); } };
}

/* The database container's CPU, if it runs in this project's docker compose. */
async function sampleContainer() {
  let id = "";
  try {
    id = (await exec("docker", ["compose", "ps", "-q", "db"], { cwd: ROOT })).stdout.trim();
  } catch {}
  const series = [];
  let stopped = !id;
  (async () => {
    while (!stopped) {
      try {
        const { stdout } = await exec("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}", id]);
        series.push({ t: Date.now(), cpu: parseFloat(stdout) });
      } catch {}
      await pause(2000);
    }
  })();
  return { series, stop: () => { stopped = true; } };
}

/* ---------- merging ---------- */

function merge(results) {
  const hists = {};
  const counters = {};
  for (const r of results) {
    for (const [k, h] of Object.entries(r.hists)) (hists[k] ??= new Hist()).merge(new Hist(h));
    for (const [k, v] of Object.entries(r.counters)) counters[k] = (counters[k] ?? 0) + v;
  }
  return { hists, counters, generator: results.map(r => r.generator) };
}

function summarizeServers(series) {
  const byInstance = new Map();
  for (const s of series) (byInstance.get(s.instance) ?? byInstance.set(s.instance, []).get(s.instance)).push(s);
  return [...byInstance].sort(([a], [b]) => a - b).map(([instance, list]) => ({
    instance,
    cpuAvg: avg(list.map(s => s.cpu)),
    cpuMax: Math.max(...list.map(s => s.cpu)),
    secondsOver90: list.filter(s => s.cpu > 90).length,
    rssFirst: list[0].rssMb,
    rssMax: Math.max(...list.map(s => s.rssMb)),
    rssLast: list.at(-1).rssMb
  }));
}

function summarizeDatabase(series, container) {
  if (!series.length) return null;
  const busy = series.filter(s => s.tx > 5);   // the seconds the games were running, not the setup around them
  const pickFrom = busy.length ? busy : series;
  return {
    txAvg: avg(pickFrom.map(s => s.tx)),
    txMax: Math.max(...series.map(s => s.tx)),
    readAvg: avg(pickFrom.map(s => s.read)),
    writtenAvg: avg(pickFrom.map(s => s.written)),
    connectionsMax: Math.max(...series.map(s => s.connections)),
    containerCpuAvg: container.length ? avg(container.map(s => s.cpu)) : null,
    containerCpuMax: container.length ? Math.max(...container.map(s => s.cpu)) : null
  };
}

const avg = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
