/* The admin password guards the admin panel and the host screen. Logging in
 * sets a signed, HttpOnly cookie. The server keeps no session table, so any
 * instance can check the cookie, and it survives restarts and redeploys as
 * long as SESSION_SECRET stays the same. Login attempts are rate limited in
 * the database (see play.hit), since instances share no memory.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "quizly_admin";
const TTL_MS = 12 * 60 * 60 * 1000;

export function createAuth({ password, secret }) {
  const mac = s => createHmac("sha256", secret).update(s).digest();
  const sign = exp => mac(`admin:${exp}`).toString("base64url");

  return {
    TTL_MS,

    /* Compares HMACs rather than the strings, so neither the length nor
     * the content of the password leaks through timing. */
    checkPassword(input) {
      return typeof input === "string" && input.length <= 200 && timingSafeEqual(mac(input), mac(password));
    },

    issue() {
      const exp = Date.now() + TTL_MS;
      return `${exp}.${sign(exp)}`;
    },

    isAdmin(req) {
      const [exp, sig] = String(readCookie(req.headers.cookie, COOKIE) || "").split(".");
      if (!exp || !sig || !(Number(exp) > Date.now())) return false;
      const good = Buffer.from(sign(exp));
      const given = Buffer.from(sig);
      return given.length === good.length && timingSafeEqual(given, good);
    }
  };
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
