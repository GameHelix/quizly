/* The HTTP API, and in local and standalone runs the static client too. On
 * Vercel the CDN serves the client and every /api/* request is rewritten to
 * api/index.js, which exports this same app.
 *
 *   /api/games/:pin…    the room: phones, the projector, the leaderboard screen
 *   /api/host/…         running a game (admin cookie)
 *   /api/admin/…        quizzes and results (admin cookie)
 *   /api/auth/…         signing in and out
 */

import path from "node:path";
import express from "express";
import QRCode from "qrcode";
import { COOKIE, createAuth } from "./auth.js";
import { ROOT } from "./config.js";
import { createPool } from "./db.js";
import { GameError, UserError, log } from "./errors.js";
import { isSameOrigin, joinBase } from "./net.js";
import { createPlay } from "./play.js";
import { createQuizzes } from "./quizzes.js";
import { createResults } from "./results.js";

const STREAM_MS = 25_000;   // a live stream's length: inside the function's 30 s limit on Vercel (vercel.json)
const PING_MS = 10_000;     // a comment this often, so a screen can tell a quiet game from a dead line
const JOINS_PER_ADDRESS = 3000;   // in ten minutes: thirty full rooms behind one office's address

/* Everything a request needs, built once per process (per warm instance on Vercel). */
export function createContext(config) {
  const pool = createPool(config.databaseUrl);
  const quizzes = createQuizzes(pool);
  return {
    config,
    pool,
    quizzes,
    play: createPlay({ pool, quizzes, maxPlayers: config.maxPlayers }),
    results: createResults(pool),
    auth: createAuth({ password: config.adminPassword, secret: config.sessionSecret })
  };
}

export function createApp({ config, pool, quizzes, play, results, auth }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("json escape", true);
  app.use(securityHeaders);

  const api = express.Router();
  api.use(express.json({ limit: "512kb" }));
  api.use((req, res, next) => {
    // State-changing requests must come from our own pages.
    if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req.headers, config)) {
      throw new UserError("Cross-site request refused", 403);
    }
    res.set("Cache-Control", "no-store");
    next();
  });

  const admin = (req, res, next) => (auth.isAdmin(req) ? next() : next(new UserError("Sign in first", 401)));
  const limited = async (key, max, windowMs) => {
    if (!(await play.hit(key, max, windowMs))) throw new GameError("slow_down");
  };

  /* ---------- health and auth ---------- */

  api.get("/health", async (req, res) => {
    await pool.query("select 1");
    res.json({ ok: true });
  });

  api.get("/auth/me", (req, res) => res.json({ admin: auth.isAdmin(req) }));

  // Every attempt is counted before the password is checked, so a burst sent all
  // at once cannot slip past the limit; a right password is then given back, so
  // the presenter's own sign-ins never use up an address a whole room may share.
  api.post("/auth/login", async (req, res) => {
    const key = `login:${req.ip}`;
    await limited(key, 20, 15 * 60_000);
    if (!auth.checkPassword(req.body?.password)) throw new UserError("That password is not right", 401);
    await play.forgive(key);
    res.cookie(COOKIE, auth.issue(), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: auth.TTL_MS, path: "/" });
    res.json({ ok: true });
  });

  api.post("/auth/logout", (req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  /* ---------- the room ---------- */

  // The shared state every screen polls. Identical for everyone, so the CDN
  // may answer for a second: sixty phones cost the server about one request a second.
  api.get("/games/:pin", async (req, res) => {
    const view = await play.publicState(req.params.pin);
    if (!view) {
      await limited(`pinget:${req.ip}`, 300, 10 * 60_000);   // PIN probing
      throw new GameError("no_game");
    }
    res.set("Cache-Control", "public, max-age=0, s-maxage=1").json(view);
  });

  // The same state pushed down one long response the moment it changes, so
  // every screen moves with the game instead of a poll and a cache behind it.
  // A stream ends after STREAM_MS and the screen opens the next one at once.
  api.get("/games/:pin/live", async (req, res) => {
    if (!(await play.find(req.params.pin))) {
      await limited(`pinget:${req.ip}`, 300, 10 * 60_000);
      throw new GameError("no_game");
    }
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const write = text => {
      if (!res.writableEnded && !res.destroyed) res.write(text);
    };
    const close = () => {
      if (!res.writableEnded) res.end();
    };
    // Escaped like every JSON response here (app.set("json escape")).
    const stop = play.watch(req.params.pin, view => (view
      ? write(`data: ${JSON.stringify({ ...view, now: Date.now() }).replace(/[<>&]/g, c => `\\u00${c.charCodeAt(0).toString(16)}`)}\n\n`)
      : close()));
    const ping = setInterval(() => write(": ping\n\n"), PING_MS);
    const done = setTimeout(close, STREAM_MS);
    const finish = () => {
      stop();
      clearInterval(ping);
      clearTimeout(done);
    };
    res.on("close", finish);
    if (res.destroyed || req.socket?.destroyed) finish();   // the screen left while the game was looked up
  });

  api.get("/games/:pin/qr.svg", async (req, res) => {
    const game = await play.find(req.params.pin);
    if (!game || game.isOver) {
      await limited(`pinget:${req.ip}`, 300, 10 * 60_000);
      throw new GameError("no_game");
    }
    const svg = await QRCode.toString(game.joinUrl, {
      type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#14161aff", light: "#ffffffff" }
    });
    res.set("Cache-Control", "public, max-age=300, s-maxage=3600").type("image/svg+xml").send(svg);
  });

  api.post("/games/:pin/players", async (req, res) => {
    const game = await play.current(req.params.pin);
    if (!game) {
      await limited(`pin:${req.ip}`, 30, 10 * 60_000);   // PIN guessing
      throw new GameError("no_game");
    }
    // A whole office, school or mobile network shares one address, so only
    // joins that succeed count — requests that fail on purpose cannot use up
    // the room's allowance — and the ceiling is thirty full rooms, not three.
    // Each game has its own guards: the player cap, the lock and the kick.
    const key = `join:${req.ip}`;
    if ((await play.used(key)) >= JOINS_PER_ADDRESS) throw new GameError("slow_down");
    const joined = await play.join(game, req.body?.nickname, req.body?.avatar);
    await play.hit(key, JOINS_PER_ADDRESS, 10 * 60_000);
    res.status(201).json(joined);
  });

  // One phone's own view. The token proves who it is; it travels in a
  // header, never in the URL, so it stays out of logs and caches.
  api.get("/games/:pin/players/:id", async (req, res) => {
    const { game, player } = await signedIn(req, req.params.id);
    res.json(await play.playerView(game, player));
  });

  api.post("/games/:pin/answers", async (req, res) => {
    const { game, player } = await signedIn(req, req.body?.playerId);
    res.json(await play.answer(game, player, req.body?.index, req.body?.choice, req.body?.elapsedMs));
  });

  async function signedIn(req, playerId) {
    const game = await play.current(req.params.pin);
    if (!game) throw new GameError("no_game");
    const token = /^Bearer (.+)$/.exec(req.get("authorization") || "")?.[1];
    const player = await play.player(game, playerId, token);
    if (!player) throw new GameError("not_in_game");
    return { game, player };
  }

  /* ---------- hosting ---------- */

  api.get("/host/quizzes", admin, async (req, res) => res.json(await quizzes.list()));

  api.post("/host/games", admin, async (req, res) => {
    const game = await play.create({
      quizId: req.body?.quizId,
      category: req.body?.category,
      joinBase: joinBase(config, req.headers, req.secure)
    });
    log.info("game created", { pin: game.pin, quiz: game.title, questions: game.round.length });
    res.status(201).json(await play.publicView(game));
  });

  api.get("/host/games/:pin", admin, async (req, res) => {
    res.json(await play.publicView(await hosted(req)));
  });

  api.post("/host/games/:pin/next", admin, async (req, res) => {
    const from = req.body?.from;
    const game = await play.next(await hosted(req), from && { phase: from.phase, index: from.index });
    res.json(await play.publicView(game));
  });

  api.post("/host/games/:pin/end", admin, async (req, res) => {
    const game = await play.end(await hosted(req));
    log.info(`game ${game.status}`, { pin: game.pin });
    res.json(await play.publicView(game));
  });

  api.post("/host/games/:pin/lock", admin, async (req, res) => {
    res.json(await play.publicView(await play.lock(await hosted(req), req.body?.locked)));
  });

  api.post("/host/games/:pin/kick", admin, async (req, res) => {
    res.json(await play.publicView(await play.kick(await hosted(req), req.body?.playerId)));
  });

  async function hosted(req) {
    const game = await play.current(req.params.pin);
    if (!game) throw new GameError("no_game");
    return game;
  }

  /* ---------- quizzes ---------- */

  api.get("/admin/quizzes", admin, async (req, res) => res.json(await quizzes.list()));
  api.post("/admin/quizzes", admin, async (req, res) => {
    res.status(201).json(await quizzes.create({ title: req.body?.title, data: req.body?.data }));
  });
  api.get("/admin/quizzes/:id", admin, async (req, res) => res.json(await quizzes.get(req.params.id)));
  api.patch("/admin/quizzes/:id", admin, async (req, res) => res.json(await quizzes.rename(req.params.id, req.body?.title)));
  api.delete("/admin/quizzes/:id", admin, async (req, res) => {
    await quizzes.remove(req.params.id);
    res.json({ ok: true });
  });
  api.put("/admin/quizzes/:id/settings", admin, async (req, res) => {
    res.json({ settings: await quizzes.saveSettings(req.params.id, req.body) });
  });
  api.put("/admin/quizzes/:id/questions/:qid", admin, async (req, res) => {
    if (req.body?.id !== req.params.qid) throw new UserError("The question id in the path and the body differ");
    res.json(await quizzes.saveQuestion(req.params.id, req.body));
  });
  api.delete("/admin/quizzes/:id/questions/:qid", admin, async (req, res) => {
    await quizzes.deleteQuestion(req.params.id, req.params.qid);
    res.json({ ok: true });
  });
  api.put("/admin/quizzes/:id/import", admin, async (req, res) => res.json(await quizzes.replace(req.params.id, req.body)));

  /* ---------- results ---------- */

  api.get("/admin/games", admin, async (req, res) => res.json(await results.list()));
  api.get("/admin/games/:id", admin, async (req, res) => res.json(await results.get(req.params.id)));
  api.get("/admin/games/:id/results.csv", admin, async (req, res) => {
    const { pin, body } = await results.csv(req.params.id);
    res.attachment(`quizly-${pin}-results.csv`).type("text/csv; charset=utf-8").send(body);
  });
  api.delete("/admin/games/:id", admin, async (req, res) => {
    await results.remove(req.params.id);
    res.json({ ok: true });
  });

  api.use(() => {
    throw new UserError("Not found", 404);
  });

  app.use("/api", api);

  /* ---------- the client, when no CDN serves it ---------- */

  const statics = { extensions: ["html"], setHeaders: res => res.set("Cache-Control", "no-cache") };
  app.use("/shared", express.static(path.join(ROOT, "shared"), statics));
  app.use(express.static(path.join(ROOT, "client"), statics));
  app.use((req, res) => {
    res.status(404).sendFile(path.join(ROOT, "client", "404.html"), err => {
      if (err && !res.headersSent) res.type("text/plain").send("Not found");
    });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "That is not valid JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That is too large" });
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: "Bad request" });
    log.error("request failed", { method: req.method, path: req.path, err });
    res.status(500).json({ error: "Something went wrong on the server" });
  });

  return app;
}

/* The same policy vercel.json gives the static files. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");

function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
}
