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
 * LISTEN needs a session of its own, which a pooler such as PgBouncer in
 * transaction mode cannot give: there it is accepted, and then hears
 * nothing. So it uses the direct URL, and rather than trust it, each
 * instance sends itself a NOTIFY the way announcements travel and waits to
 * hear it — when it starts listening, and every half minute after, which
 * also finds a connection that died without a word. Until it hears, or
 * while the connection is down, the feeds look for changes four times a
 * second, as they always did.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "./db.js";
import { log } from "./errors.js";

const CHANNEL = "quizly_games";
const GATHER_MS = 20;            // announcements wait this long for others to share their NOTIFY
const RETRY_MS = 2000;           // a dropped LISTEN connection is opened again after this
const DEAF_RETRY_MS = 60_000;    // …and one that heard nothing, after this
const LINGER_MS = 15_000;        // kept this long after the last feed stops, as streams are renewed every 25 s
const CHECK_MS = 3000;           // how long a check waits to hear its own NOTIFY
const HEARTBEAT_MS = 30_000;     // how often a listening connection is checked
const MAX_PAYLOAD = 7900;        // Postgres refuses a payload of 8,000 bytes

/* pool sends the announcements (and the checks); url is the direct
 * connection that LISTENs. onChange(pin, urgent) runs for every change
 * another instance announces, and onChange(null) when changes may have been
 * missed: the moment listening starts again after a gap. */
export function createChanges({ pool, url, onChange }) {
  const self = randomBytes(6).toString("base64url");   // this process: its own announcements come back to it
  const usable = Boolean(url);
  const pending = new Map();   // pin → urgent, waiting to be announced
  let timer = null;
  let wanted = false;          // some feed is open
  let client = null;           // the LISTEN connection, open or opening
  let ready = false;           // LISTEN is in place and has been heard through
  let linger = null;
  let retry = null;
  let beat = null;
  let check = null;            // { nonce, done } while a check waits
  let notifyFailing = false;
  let listenFailing = false;
  let deafWarned = false;
  let closed = false;

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
        notifyFailing = false;
      } catch (err) {
        if (!notifyFailing) log.error("could not announce a change", { err });
        notifyFailing = true;
      }
    }
  }

  function receive(payload) {
    const [from, list] = String(payload).split(" ");
    if (!list) return;
    if (from === self) {
      if (check && list === `?${check.nonce}`) check.done(true);   // our own check, heard
      return;
    }
    if (list.startsWith("?")) return;   // another instance's check
    for (const item of list.split(",")) {
      const urgent = item.startsWith("!");
      onChange(urgent ? item.slice(1) : item, urgent);
    }
  }

  /* Sends this instance a NOTIFY through the pool, the way announcements
   * travel, and resolves true once the LISTEN connection hears it. */
  function heard() {
    return new Promise(resolve => {
      const nonce = randomBytes(4).toString("hex");
      const timeout = setTimeout(() => check?.done(false), CHECK_MS);
      check = {
        nonce,
        done: ok => {
          clearTimeout(timeout);
          check = null;
          resolve(ok);
        }
      };
      pool.query("select pg_notify($1, $2)", [CHANNEL, `${self} ?${nonce}`]).catch(() => {});   // unsent: the wait runs out
    });
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
    if (!(await heard())) {
      if (client !== c) return;
      if (!deafWarned) {
        log.warn("LISTEN hears nothing, so the live feeds look for changes four times a second: " +
          "DATABASE_URL_UNPOOLED should be a direct connection to the database, not through a pooler");
      }
      deafWarned = true;
      return dropped(c, null, DEAF_RETRY_MS);
    }
    if (client !== c) return;
    ready = true;
    if (listenFailing) log.info("listening for changes again");
    listenFailing = false;
    clearInterval(beat);
    beat = setInterval(() => heartbeat(c), HEARTBEAT_MS);
    beat.unref?.();
    onChange(null);             // anything may have changed while nobody listened
  }

  async function heartbeat(c) {
    if (client !== c || !ready || check) return;
    if (!(await heard()) && client === c) dropped(c, new Error("missed its own heartbeat NOTIFY"));
  }

  /* The LISTEN connection failed, or heard nothing (err null): try again
   * after a while, and look four times a second meanwhile. */
  function dropped(c, err, wait = RETRY_MS) {
    if (client !== c) return;
    client = null;
    const was = ready;
    ready = false;
    clearInterval(beat);
    c.removeAllListeners("end");
    c.on("error", () => {});
    c.end().catch(() => {});
    if (err && !listenFailing) log.error("the connection that listens for changes failed", { err });
    if (err) listenFailing = true;
    if (was) onChange(null);    // the feeds look four times a second until it is back
    if (wanted && !closed) {
      retry = setTimeout(() => {
        retry = null;
        if (wanted && !client && !closed) connect();
      }, wait);
      retry.unref?.();
    }
  }

  function hangUp() {
    const c = client;
    client = null;
    ready = false;
    clearInterval(beat);
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
