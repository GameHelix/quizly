/* Everything the server takes from the environment, read in one place.
 * See .env.example for what each variable does.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";

  let adminPassword = env.ADMIN_PASSWORD || "";
  let generatedPassword = false;
  if (!adminPassword) {
    if (production) throw new Error("ADMIN_PASSWORD must be set in production");
    adminPassword = randomBytes(6).toString("base64url");
    generatedPassword = true;
  }
  if (production && adminPassword.length < 16) throw new Error("ADMIN_PASSWORD must be at least 16 characters in production");

  // Every instance must verify cookies the others signed, so production needs a fixed secret.
  let sessionSecret = env.SESSION_SECRET || "";
  if (!sessionSecret) {
    if (production) throw new Error("SESSION_SECRET must be set in production (openssl rand -hex 32)");
    sessionSecret = randomBytes(32).toString("hex");
  }
  if (production && sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters in production");

  // The address the QR code sends phones to, and the link preview's image.
  const publicUrl = (env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (publicUrl && !/^https?:\/\/[^/\s]+$/.test(publicUrl)) {
    throw new Error("PUBLIC_URL must look like https://quiz.example.com — scheme and host, no path");
  }

  return {
    port: int(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    databaseUrl: env.DATABASE_URL || "",
    // Migrations need a session of their own, which a pooler such as PgBouncer in
    // transaction mode does not give: they use the direct URL when there is one.
    migrationUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || "",
    // So does LISTEN, which tells every instance when a game changes (changes.js).
    listenUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || "",
    adminPassword,
    generatedPassword,
    sessionSecret,
    publicUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY) ?? false,
    maxPlayers: int(env.MAX_PLAYERS, 100)
  };
}

/* Express's "trust proxy": a hop count, true/false, or a list of addresses.
 * Unset means off: set it behind a proxy, and only there. */
function parseTrustProxy(v) {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
