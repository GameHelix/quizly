/* Runs Quizly as one ordinary Node process: the API and the static client
 * on one port. This is `npm run dev` and `npm start`, and the way to run it
 * on any machine that is not Vercel.
 */

import { createServer } from "node:http";
import { createApp, createContext } from "./app.js";
import { loadConfig } from "./config.js";
import { migrateUrl } from "./db.js";
import { log } from "./errors.js";
import { lanAddress } from "./net.js";

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
    players: `http://${lan ?? "localhost"}:${config.port}`
  });
  if (config.generatedPassword) {
    log.warn("ADMIN_PASSWORD is not set, so this run uses a generated one", { password: config.adminPassword });
  }
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info("shutting down", { signal });
    setTimeout(() => process.exit(0), 5000).unref();
    server.close(() => context.pool.end().finally(() => process.exit(0)));
    server.closeIdleConnections();
  });
}
