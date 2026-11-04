/* Runs Quizly: the API and the static client on one port. This is
 * `npm run dev`, `npm start` and the container's command (Dockerfile).
 *
 * The app runs in a worker process under a small supervisor (node:cluster),
 * so it can be replaced without a gap: send the supervisor SIGHUP after
 * updating the code (`kill -HUP <supervisor pid>`, or `systemctl reload`)
 * and it starts a worker on the new code, waits until it is taking requests,
 * and only then retires the old one. No screen is refused, and no answer is
 * lost. SIGTERM or Ctrl-C stops everything; a worker that crashes is
 * replaced.
 *
 * A worker that stops ends every live stream at once, so screens reconnect
 * straight away instead of waiting out their stream, and it hangs up each
 * connection after answering on it, so the next request goes to the new
 * worker.
 */

import cluster from "node:cluster";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.js";
import { migrateUrl } from "./db.js";
import { log } from "./errors.js";
import { IN_CONTAINER, lanAddress } from "./net.js";

const STOP_MS = 5000;       // a stopping worker waits this long for requests in flight, then goes anyway
const LINGER_MS = 1000;     // a worker retired by a reload keeps serving this long (see serve)
const RESTART_MS = 1000;    // a worker that keeps crashing is replaced after this
const SAME_SIGNAL_MS = 1000;   // a stop asked again within this is the same request: npm and the terminal both pass Ctrl-C on
const DB_WAIT_MS = 120_000;    // a starting worker waits this long for the database
const STOP = "quizly:stop";
const RETIRE = "quizly:retire";   // stop, with a new worker already serving

if (cluster.isPrimary) supervise();
else await serve();

/* ---------- the supervisor ---------- */

function supervise() {
  // Made up once, here: every worker, and the next one after a reload, must
  // accept the same password and the cookies the others signed.
  const config = loadConfig();
  process.env.ADMIN_PASSWORD = config.adminPassword;
  process.env.SESSION_SECRET = config.sessionSecret;
  if (config.generatedPassword) {
    log.warn("ADMIN_PASSWORD is not set, so this run uses a generated one", { password: config.adminPassword });
  }
  // Each worker takes connections from the port itself. The port stays open
  // as long as one worker is listening on it.
  cluster.schedulingPolicy = cluster.SCHED_NONE;

  let stopping = 0;          // when the stop was asked for
  let reloading = false;
  let restart = null;        // a crashed worker's replacement, waiting to start
  let lastCrash = 0;
  const alive = new Set();
  const retiring = new Set();
  const tell = (w, msg) => {
    // A worker can exit between the decision and the send: the callback takes
    // the error, which would otherwise be thrown at the supervisor a moment later.
    if (!w.isDead() && w.isConnected()) w.send(msg, () => {});
  };

  /* A worker that dies after it was serving is replaced; one that dies
   * before it ever listened has bad code or no database, and is not. */
  function start(env) {
    const worker = cluster.fork(env);
    alive.add(worker);
    worker.on("error", () => {});   // a send to a worker on its way out; tell() has already moved on
    worker.once("listening", () => {
      worker.serving = true;
    });
    worker.once("exit", (code, signal) => {
      alive.delete(worker);
      const asked = retiring.delete(worker) || stopping;
      if (stopping && !alive.size) process.exit(0);
      if (asked) return;
      if (worker.serving) {
        log.error("the worker stopped unexpectedly; starting another", { code, signal });
        // At once the first time; a worker that keeps crashing is replaced more slowly.
        const wait = Date.now() - lastCrash < 10_000 ? RESTART_MS : 0;
        lastCrash = Date.now();
        clearTimeout(restart);
        restart = setTimeout(() => {
          restart = null;
          if (!stopping && !alive.size) start();
        }, wait);
      } else if (!alive.size && !restart) {
        log.error("the worker could not start", { code, signal });
        process.exit(1);
      }
    });
    return worker;
  }

  process.on("SIGHUP", () => {
    if (stopping || reloading) return;
    reloading = true;
    clearTimeout(restart);   // the new worker takes the place of one still waiting to be restarted
    restart = null;
    const old = [...alive];
    log.info("reloading: starting a worker on the current code");
    const fresh = start(envFiles());
    const failed = () => {
      reloading = false;
      log.error("reload failed: the new worker did not start, so the old one carries on");
      if (!alive.size && !stopping) start();
    };
    fresh.once("exit", failed);
    fresh.once("listening", () => {
      fresh.off("exit", failed);
      reloading = false;
      for (const w of old) {
        retiring.add(w);
        tell(w, RETIRE);
      }
    });
  });

  const stopAll = () => {
    if (stopping) {
      if (Date.now() - stopping < SAME_SIGNAL_MS) return;   // the same Ctrl-C, passed on twice
      for (const w of alive) w.process.kill("SIGKILL");     // asked again: do not wait
      process.exit(1);
    }
    stopping = Date.now();
    clearTimeout(restart);
    log.info("shutting down");
    if (!alive.size) process.exit(0);
    for (const w of alive) tell(w, STOP);
    // A worker stuck on a dead database must not hold the stop up for ever.
    setTimeout(() => {
      for (const w of alive) w.process.kill("SIGKILL");
      process.exit(0);
    }, LINGER_MS + STOP_MS + 5000).unref();
  };
  process.on("SIGTERM", stopAll);
  process.on("SIGINT", stopAll);

  start();
}

/* The variables in the env files this process was started with
 * (--env-file=…, as `npm start` passes .env): read again on a reload, so a
 * new worker sees an edited .env. */
function envFiles() {
  const env = {};
  for (const arg of process.execArgv) {
    const file = /^--env-file(?:-if-exists)?=(.+)$/.exec(arg)?.[1];
    if (!file || !existsSync(file)) continue;
    try {
      // An empty value would undo what the supervisor made up (a generated password).
      for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (value !== "") env[key] = value;
    } catch (err) {
      log.warn("could not read an env file for the new worker", { file, err });
    }
  }
  return env;
}

/* ---------- a worker: the app itself ---------- */

async function serve() {
  // Asked to stop before it is ready (the supervisor's message or SIGTERM can
  // come while it waits for the database): remembered, and done once it can be.
  let asked = null;
  let stop = retired => {
    asked ??= { retired };
  };
  process.on("message", msg => (msg === STOP || msg === RETIRE) && stop(msg === RETIRE));
  process.on("SIGTERM", () => stop(false));
  process.on("SIGINT", () => {});   // Ctrl-C reaches the supervisor too, and it says what to do
  process.on("SIGHUP", () => {});   // a reload is the supervisor's; a stray SIGHUP must not end this worker

  const config = loadConfig();
  const applied = await waitForDatabase(config, () => asked);
  if (asked) process.exit(0);
  const { createApp, createContext } = await import("./app.js");
  const context = createContext(config);
  if (applied.length) log.info("database migrated", { applied });

  const server = createServer(createApp(context));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.listen(config.port, config.host, () => {
    const lan = lanAddress();
    log.info("quizly is running", {
      host: `http://localhost:${config.port}/host`,
      admin: `http://localhost:${config.port}/admin`,
      // Inside a container its own address means nothing to a phone; PUBLIC_URL is the one to set.
      players: config.publicUrl || `http://${(!IN_CONTAINER && lan) || "localhost"}:${config.port}`,
      supervisor: process.ppid,   // the one to send SIGHUP to
      worker: process.pid
    });
  });

  stop = async retired => {
    if (context.stopping) return;
    context.stopping = true;   // every answer from now on hangs up its connection after itself
    setTimeout(() => process.exit(0), LINGER_MS + STOP_MS + 3000).unref();   // whatever happens below
    let closed = false;
    const close = () => server.close(() => {
      closed = true;
    });
    // After a reload the new worker is already serving: this one keeps taking
    // requests for a moment, each answered with "Connection: close", so that a
    // screen moving over on a connection it holds is never cut off mid-request.
    // Stopping for good, it takes none from now on.
    if (!retired) close();
    context.play.endStreams();   // every live stream ends now; changes are still announced while it drains
    if (retired) {
      await new Promise(resolve => setTimeout(resolve, LINGER_MS));
      close();
    }
    for (const by = Date.now() + STOP_MS; !closed && Date.now() < by;) {
      server.closeIdleConnections();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.closeAllConnections();
    await context.close().catch(() => {});
    process.exit(0);
  };
  if (asked) stop(asked.retired);
}

/* Brings the schema up to date, waiting for a database that is not there
 * yet — a server that starts during a failover, or before its database —
 * instead of failing at once. Gives up after DB_WAIT_MS, or when asked to stop. */
async function waitForDatabase(config, stopped) {
  const by = Date.now() + DB_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await migrateUrl(config.migrationUrl);
    } catch (err) {
      if (stopped()) return [];
      if (Date.now() > by) throw err;
      if (attempt === 0) log.warn("waiting for the database", { err: err.message });
      const until = Date.now() + Math.min(5000, 500 * 2 ** attempt);
      while (Date.now() < until && !stopped()) await new Promise(resolve => setTimeout(resolve, 100));
      if (stopped()) return [];
    }
  }
}
