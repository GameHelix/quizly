/* Telling every instance at once that a game changed.
 *
 * Each process keeps a live feed for every game its screens follow
 * (play.js). On Vercel a game's phones are spread over many instances, and
 * each used to read the game four times a second to find out whether
 * anything had changed, so the database worked harder with every instance.
 * Now the instance that changes a game says so with a Postgres NOTIFY, and
 * every instance with a feed open LISTENs: a change reaches all of them
 * within milliseconds, and nobody reads a game that has not changed.
 *
 * Announcements gather for a few milliseconds and leave as one NOTIFY.
 * Postgres takes a lock at commit for every transaction that notifies, so
 * one NOTIFY per answer would queue the whole database behind it.
 *
 * LISTEN needs a session of its own, which Neon's pooler (PgBouncer in
 * transaction mode) cannot give, so it uses the direct URL. Without one, or
 * while that connection is down, the feeds look for changes four times a
 * second, as they always did.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "./db.js";
import { log } from "./errors.js";

const CHANNEL = "quizly_games";
const GATHER_MS = 20;        // announcements wait this long for others to share their NOTIFY
const RETRY_MS = 2000;       // a dropped LISTEN connection is opened again after this
const LINGER_MS = 15_000;    // kept this long after the last feed stops, as streams are renewed every 25 s
const MAX_PAYLOAD = 7900;    // Postgres refuses a payload of 8,000 bytes

/* onChange(pin, urgent) runs for every change another instance announces,
 * and onChange(null) when changes may have been missed: the moment
 * listening starts again after a gap. */
export function createChanges({ pool, url, onChange }) {
  const self = randomBytes(6).toString("base64url");   // this process: its own announcements come back to it
  const usable = canListen(url);
  const pending = new Map();   // pin → urgent, waiting to be announced
  let timer = null;
  let wanted = false;          // some feed is open
  let client = null;           // the LISTEN connection, open or opening
  let ready = false;           // LISTEN is in place
  let linger = null;
  let retry = null;
  let failing = false;
  let closed = false;

  if (url && !usable) log.warn("live feeds will look for changes four times a second: LISTEN needs DATABASE_URL_UNPOOLED, the direct URL");

  function announce(pin, urgent = false) {
    if (!usable || closed) return;
    pending.set(pin, urgent || pending.get(pin) === true);
    if (urgent) {
      clearTimeout(timer);
      timer = setTimeout(flush, 0);
    } else {
      timer ??= setTimeout(flush, GATHER_MS);
    }
  }

  /* Sends what has gathered, as few NOTIFYs as the payload limit allows. */
  async function flush() {
    timer = null;
    if (!pending.size) return;
    const items = [...pending].map(([pin, urgent]) => (urgent ? `!${pin}` : pin));
    pending.clear();
    let payload = "";
    const sends = [];
    for (const item of items) {
      if (payload && payload.length + item.length + 1 > MAX_PAYLOAD) {
        sends.push(payload);
        payload = "";
      }
      payload += (payload ? "," : "") + item;
    }
    sends.push(payload);
    for (const list of sends) {
      try {
        await pool.query("select pg_notify($1, $2)", [CHANNEL, `${self} ${list}`]);
        failing = false;
      } catch (err) {
        if (!failing) log.error("could not announce a change", { err });
        failing = true;
      }
    }
  }

  function receive(payload) {
    const [from, list] = String(payload).split(" ");
    if (from === self || !list) return;
    for (const item of list.split(",")) {
      const urgent = item.startsWith("!");
      onChange(urgent ? item.slice(1) : item, urgent);
    }
  }

  /* Starts listening when the first feed opens; stops a while after the last one closes. */
  function want(on) {
    if (!usable || closed) return;
    wanted = on;
    clearTimeout(linger);
    linger = null;
    if (on) {
      if (!client && !retry) connect();
    } else {
      linger = setTimeout(() => {
        linger = null;
        if (!wanted) hangUp();
      }, LINGER_MS);
      linger.unref?.();
    }
  }

  async function connect() {
    const c = createClient(url);
    client = c;
    c.on("notification", msg => receive(msg.payload));
    c.on("error", err => dropped(c, err));
    c.on("end", () => dropped(c));
    try {
      await c.connect();
      await c.query(`listen ${CHANNEL}`);
    } catch (err) {
      return dropped(c, err);
    }
    if (client !== c) return;   // hung up while connecting
    ready = true;
    if (failing) log.info("listening for changes again");
    failing = false;
    onChange(null);             // anything may have changed while nobody listened
  }

  function dropped(c, err) {
    if (client !== c) return;
    client = null;
    const was = ready;
    ready = false;
    c.removeAllListeners("end");
    c.on("error", () => {});
    c.end().catch(() => {});
    if (!failing) log.error("the connection that listens for changes failed", { err: err ?? new Error("closed") });
    failing = true;
    if (was) onChange(null);    // the feeds look four times a second until it is back
    if (wanted && !closed) {
      retry = setTimeout(() => {
        retry = null;
        if (wanted && !client && !closed) connect();
      }, RETRY_MS);
      retry.unref?.();
    }
  }

  function hangUp() {
    const c = client;
    client = null;
    ready = false;
    if (!c) return;
    c.removeAllListeners("end");
    c.on("error", () => {});
    c.end().catch(() => {});
  }

  return {
    /* True while a change on another instance will be heard. */
    get listening() {
      return ready;
    },
    announce,
    want,
    /* Sends what is still gathering and stops listening. */
    async close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(linger);
      clearTimeout(retry);
      await flush();
      hangUp();
    }
  };
}

/* Neon's pooled hosts end in -pooler: PgBouncer in transaction mode passes a
 * NOTIFY on, but a LISTEN there hears nothing. */
function canListen(url) {
  if (!url) return false;
  try {
    return !new URL(url).hostname.includes("-pooler");
  } catch {
    return false;
  }
}
