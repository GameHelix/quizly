/* `npm run stress-test -- --games 25`, or the whole evaluation: `npm run stress-test -- --suite all`
 *
 * Many whole games at once, with simulated phones that behave as the browser
 * does (scripts/stress/phones.js), judged by what a room would notice: every
 * join and every answer gets in, 99% of phones show the host's next screen
 * within half a second, no screen gives up on its stream and falls back to
 * polling, the scores add up, and after a storm every screen is back within
 * ten seconds. scripts/load-test.js plays one game; this plays many.
 *
 * Without --url it runs on this machine: Quizly as production runs it (one
 * process per --instances, requests spread over them at random as Vercel
 * spreads them), against a database of its own — quizly_stress in the docker
 * compose Postgres (`docker compose up -d`), emptied of games each run — while
 * it watches the servers' CPU and memory and the database's transactions.
 * Everything shares one machine, so its numbers are the floor, not the ceiling.
 *
 *   --games       games at once                                     (default 10)
 *   --players     phones per game; production allows 100            (default 100)
 *   --questions   questions per game                                (default 3)
 *   --join        seconds over which the phones join                (default 20)
 *   --instances   Quizly processes                                  (default 1)
 *   --pool        database connections per process                  (default the app's own: 5)
 *   --answers     human | burst (most tap within 2 s) | late (half wait for the last seconds)
 *   --away        share of phones that lock their screen once       (default 0.15)
 *   --slow        share of phones that read their stream slowly     (default 0)
 *   --mobile      share of phones on a 4G-like line                 (default 0)
 *   --ips         unique | shared (every phone behind one address)  (default unique)
 *   --storm       none | drop (every stream cut at once) | restart (every instance restarted)
 *   --storm-at    the question the storm hits, from 1               (default 2)
 *   --soak        minutes of games back to back                     (default 0)
 *   --workers     phone processes                                   (default one per 1,250 phones)
 *   --url         a running Quizly instead; needs --allow-remote and --password or ADMIN_PASSWORD.
 *                 It plays real games there: delete them in the admin panel afterwards.
 *   --suite       the evaluation, scenario after scenario: all, or a list such as ladder,storms,burst
 *   --json        write the full results to this file
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { format, passed, summary } from "./stress/report.js";
import { runScenario, STRESS_DB } from "./stress/run.js";

const { values: a } = parseArgs({
  options: {
    games: { type: "string", default: "10" },
    players: { type: "string", default: "100" },
    questions: { type: "string", default: "3" },
    join: { type: "string", default: "20" },
    instances: { type: "string", default: "1" },
    pool: { type: "string", default: "" },
    answers: { type: "string", default: "human" },
    away: { type: "string", default: "0.15" },
    slow: { type: "string", default: "0" },
    mobile: { type: "string", default: "0" },
    ips: { type: "string", default: "unique" },
    storm: { type: "string", default: "none" },
    "storm-at": { type: "string", default: "2" },
    soak: { type: "string", default: "0" },
    workers: { type: "string", default: "" },
    url: { type: "string", default: "" },
    "allow-remote": { type: "boolean", default: false },
    password: { type: "string", default: process.env.ADMIN_PASSWORD || "" },
    suite: { type: "string", default: "" },
    json: { type: "string", default: "" },
    label: { type: "string", default: "" }
  }
});

const base = {
  label: a.label || undefined,
  games: Number(a.games),
  players: Number(a.players),
  questions: Number(a.questions),
  join: Number(a.join),
  instances: Number(a.instances),
  pool: Number(a.pool) || 0,
  answers: a.answers,
  away: Number(a.away),
  slow: Number(a.slow),
  mobile: Number(a.mobile),
  ips: a.ips,
  storm: a.storm,
  stormAt: Number(a["storm-at"]),
  soak: Number(a.soak),
  workers: Number(a.workers) || 0,
  url: a.url.replace(/\/+$/, ""),
  password: a.password
};

if (base.url && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base.url) && !a["allow-remote"]) {
  console.error(`${base.url} is not this machine. A stress test there plays real games, costs what the platform charges for
them, may look like an attack to its firewall, and cannot empty its database afterwards. Add --allow-remote if that is
what you mean, and start small: production lets one address join at most 300 phones in ten minutes.`);
  process.exit(1);
}
if (base.url && ["restart"].includes(base.storm)) {
  console.error("--storm restart restarts instances on this machine; it cannot restart a remote one");
  process.exit(1);
}

/* The evaluation. The ladder climbs until a step fails; the scenarios after
 * it run at the largest step that passed, so each one tests its own thing
 * rather than the load alone. */
const LADDER = [
  { key: "room", label: "one room of 60", games: 1, players: 60 },
  { key: "1k", label: "1,000 phones", games: 10 },
  { key: "2.5k", label: "2,500 phones", games: 25 },
  { key: "5k", label: "5,000 phones", games: 50 },
  { key: "10k", label: "10,000 phones", games: 100 }
];
const AT_SIZE = [
  { key: "shared-ip", label: "4 rooms behind one address", games: 4, ips: "shared", questions: 1, fixed: true },
  { key: "instances", label: "same load over 4 instances", instances: 4 },
  { key: "burst", label: "answer burst", answers: "burst" },
  { key: "drop", label: "every stream cut at once", storm: "drop" },
  { key: "restart", label: "server restart mid-game", storm: "restart" },
  { key: "mobile", label: "half on 4G, late answers", mobile: 0.5, slow: 0.05, answers: "late" },
  { key: "soak", label: "soak, 10 minutes", soak: 10, questions: 3, scale: 0.4 }
];
const GROUPS = {
  ladder: ["room", "1k", "2.5k", "5k", "10k"],
  limits: ["shared-ip"],
  storms: ["drop", "restart"],
  network: ["mobile"],
  all: [...LADDER, ...AT_SIZE].map(s => s.key)
};

async function main() {
  if (!a.suite) {
    const r = await runScenario(base);
    console.log(format(r));
    if (a.json) writeFileSync(a.json, JSON.stringify(r, null, 2));
    process.exit(passed(r) ? 0 : 1);
  }

  const wanted = new Set(a.suite.split(",").flatMap(k => GROUPS[k.trim()] ?? [k.trim()]));
  const rows = [];
  const results = [];
  let largestPassing = null;
  let ladderFailed = false;
  for (const step of LADDER.filter(s => wanted.has(s.key))) {
    if (ladderFailed) {
      rows.push({ label: step.label, skipped: "a smaller step failed" });
      continue;
    }
    const r = await runScenario({ ...base, ...step });
    console.log(format(r) + "\n");
    rows.push({ label: step.label, r });
    results.push(r);
    if (passed(r)) {
      if (step.key !== "room") largestPassing = step;
    } else if (step.key !== "room") ladderFailed = true;
  }
  const at = largestPassing?.games ?? 10;
  for (const s of AT_SIZE.filter(s => wanted.has(s.key))) {
    const games = s.fixed ? s.games : Math.max(1, Math.round(at * (s.scale ?? 1)));
    const r = await runScenario({ ...base, ...s, games, label: `${s.label} (${(games * (s.players ?? base.players)).toLocaleString("en-US")} phones)` });
    console.log(format(r) + "\n");
    rows.push({ label: s.label, r });
    results.push(r);
  }
  console.log(summary(rows));
  if (a.json) writeFileSync(a.json, JSON.stringify(results, null, 2));
}

main().catch(err => {
  if (/ECONNREFUSED/.test(String(err?.code ?? err?.message ?? err)) || err?.errors?.some?.(e => e.code === "ECONNREFUSED")) {
    console.error(`could not reach the stress database (${STRESS_DB}): start it with \`docker compose up -d\``);
  } else {
    console.error(err);
  }
  process.exit(1);
});
