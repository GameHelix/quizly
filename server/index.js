/* Runs Quizly as one ordinary Node process: the API and the static client
 * on one port. This is `npm run dev` and `npm start`, and the way to run it
 * on any machine that is not Vercel.
 *
 * The app runs in a worker process under a small supervisor (node:cluster)
 * that holds the port, so the app can be replaced without a gap: send the
 * supervisor SIGHUP after updating the code (`kill -HUP <pid>`, or
 * `systemctl reload`) and it starts a worker on the new code, waits until it
 * is taking requests, and only then retires the old one. No screen is ever
 * refused, and no answer is lost. SIGTERM or Ctrl-C stops everything; a
 * worker that crashes is replaced.
 *
 * A worker that stops ends every live stream at once, so screens reconnect
 * straight away instead of waiting out their stream, and it hangs up each
 * connection after answering on it, so the next request goes to the new
 * worker.
 */

import cluster from "node:cluster";
import { createServer } from "node:http";
import { createApp, createContext } from "./app.js";
import { loadConfig } from "./config.js";
import { migrateUrl } from "./db.js";
import { log } from "./errors.js";
import { lanAddress } from "./net.js";

const STOP_MS = 5000;       // a stopping worker waits this long for requests in flight, then goes anyway
const LINGER_MS = 1000;     // a worker retired by a reload keeps its idle connections this long (see serve)
const RESTART_MS = 1000;    // a crashed worker is replaced after this
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
  // Each worker takes connections from the port itself; the supervisor only holds it open.
  cluster.schedulingPolicy = cluster.SCHED_NONE;

  let stopping = false;
  let reloading = false;
  const alive = new Set();
  const retiring = new Set();
  const tell = (w, msg = STOP) => {
    try {
      w.send(msg);
    } catch {
      // already on its way out
    }
  };

  /* A worker that dies after it was serving is replaced; one that dies
   * before it ever listened has bad code or no database, and is not. */
  function start() {
    const worker = cluster.fork();
    alive.add(worker);
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
        setTimeout(() => stopping || start(), RESTART_MS);
      } else if (!alive.size) {
        log.error("the worker could not start", { code, signal });
        process.exit(1);
      }
    });
    return worker;
  }

  process.on("SIGHUP", () => {
    if (stopping || reloading) return;
    reloading = true;
    const old = [...alive];
    log.info("reloading: starting a worker on the current code");
    const fresh = start();
    const failed = () => {
      reloading = false;
      log.error("reload failed: the new worker did not start, so the old one carries on");
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
      // asked twice: do not wait
      for (const w of alive) w.process.kill("SIGKILL");
      process.exit(1);
    }
    stopping = true;
    log.info("shutting down");
    if (!alive.size) process.exit(0);
    for (const w of alive) tell(w);
  };
  process.on("SIGTERM", stopAll);
  process.on("SIGINT", stopAll);

  start();
}

/* ---------- a worker: the app itself ---------- */

async function serve() {
  const config = loadConfig();
  const applied = await migrateUrl(config.migrationUrl);
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
      players: `http://${lan ?? "localhost"}:${config.port}`,
      pid: process.pid
    });
  });

  const stop = async retired => {
    if (context.stopping) return;
    context.stopping = true;   // every answer from now on hangs up its connection after itself
    let closed = false;
    server.close(() => {
      closed = true;
    });
    await context.play.close();   // every live stream ends now
    // Connections fall idle as their streams end. A screen reconnects over the
    // one it holds and is told there to move on ("Connection: close"); after a
    // reload, a moment is left for that, as closing a connection just as a
    // request arrives on it loses the request. Whatever is still idle then is closed.
    if (retired) await new Promise(resolve => setTimeout(resolve, LINGER_MS));
    for (const by = Date.now() + STOP_MS; !closed && Date.now() < by;) {
      server.closeIdleConnections();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.closeAllConnections();
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.on("message", msg => (msg === STOP || msg === RETIRE) && stop(msg === RETIRE));
  process.on("SIGTERM", () => stop(false));
  process.on("SIGINT", () => {});   // Ctrl-C reaches the supervisor too, and it says what to do
}
