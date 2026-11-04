/* The checks a stress run must pass, and the report that shows them. The
 * targets are what a room notices, not what a server log notices. */

const ROOM = [
  "Next → phone shows it",
  "Next → phone shows it (4G)",
  "Next → phone shows it (slow line)",
  "first → last phone on a new screen",
  "clock out → phone shows the reveal",
  "push delay",
  "stream open → first state",
  "answer time charged beyond the phone's own",
  "back after the storm"
];
const REQUESTS = ["join", "me", "answer", "poll", "host next", "host end", "host create", "host look"];

const n = v => Math.round(v).toLocaleString("en-US");
const pct = v => `${(v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 1)}%`;

export function checks(r) {
  const c = r.counters;
  const get = key => c[key] ?? 0;
  const stormy = r.options.storm !== "none";
  const lost = Object.entries(c)
    .filter(([k]) => /: 5\d\d/.test(k) || (!stormy && (/no response|dropped/.test(k))))
    .reduce((a, [, v]) => a + v, 0);
  const sent = get("answers sent");
  const accepted = get("answers accepted");
  const next = r.hists["Next → phone shows it"];
  const list = [
    { name: "every join succeeded", ok: get("joins ok") === get("joins tried"), detail: `${n(get("joins ok"))} of ${n(get("joins tried"))}` },
    { name: "99.9% of the answers sent were accepted", ok: sent > 0 && accepted / sent >= 0.999, detail: `${n(accepted)} of ${n(sent)} (${pct(sent ? accepted / sent : 0)})` },
    { name: "99% of phones show Next's screen within 500 ms", ok: !!next?.n && next.pct(99) <= 500,
      detail: next?.n ? `p99 ${n(next.pct(99))} ms${r.options.slow ? " (slow lines apart)" : ""}` : "nothing measured" },
    { name: "no screen fell back to polling", ok: get("screens that fell back to polling") === 0, detail: n(get("screens that fell back to polling")) },
    { name: stormy ? "no server error (5xx)" : "no server error and no lost request", ok: lost === 0, detail: n(lost) },
    { name: "scores add up and ranks run 1…N", ok: get("scores that do not add up") === 0 && get("games with broken ranks") === 0,
      detail: `${n(get("scores that add up"))} scores, ${n(get("games ranked 1…N"))} games checked` },
    { name: "every phone that joined reached the final screen", ok: get("phones that reached the final screen") === get("joins ok"),
      detail: `${n(get("phones that reached the final screen"))} of ${n(get("joins ok"))}` }
  ];
  if (stormy) {
    const back = r.hists["back after the storm"];
    list.push({ name: "every screen back within 10 s of the storm", ok: !!back?.n && back.max <= 10_000 && get("screens not back after the storm") === 0,
      detail: back?.n ? `slowest ${(back.max / 1000).toFixed(1)} s, ${n(get("screens not back after the storm"))} never` : "storm never hit" });
  }
  if (r.serverErrors) {
    const logged = r.serverErrors.reduce((a, [, v]) => a + v, 0);
    list.push({ name: "the server logged no errors", ok: logged === 0, detail: n(logged) });
  }
  if (r.timedOut) list.push({ name: "the run finished in time", ok: false, detail: "timed out" });
  return list;
}

/* Whether the phone processes kept up: a generator that is itself behind
 * sends late and measures late, and the numbers say more about it than about Quizly. */
export function trustworthy(r) {
  return r.generator.length > 0 && r.generator.every(g => g.cpu <= 85 && g.loopP99 <= 100);
}

export function format(r) {
  const o = r.options;
  const out = [];
  const line = (s = "") => out.push(s);
  const phones = o.games * o.players;
  line(`━━ ${o.label ?? `${n(phones)} phones`} ━━`);
  line([
    `${o.games} game${o.games === 1 ? "" : "s"} × ${o.players} = ${n(phones)} phones`,
    o.url ? o.url : `${o.instances} instance${o.instances === 1 ? "" : "s"}${o.pool ? `, pool ${o.pool}` : ""}`,
    `${o.questions} question${o.questions === 1 ? "" : "s"}`,
    `answers ${o.answers}`,
    o.away ? `${pct(o.away)} lock their screen` : null,
    o.mobile ? `${pct(o.mobile)} on 4G` : null,
    o.slow ? `${pct(o.slow)} slow readers` : null,
    o.ips === "shared" ? "one shared address" : null,
    o.storm !== "none" ? `storm: ${o.storm} in question ${o.stormAt}` : null,
    o.soak ? `soak ${o.soak} min` : null,
    `${n(r.seconds)} s`
  ].filter(Boolean).join(" · "));
  line();
  const table = (title, names) => {
    const rows = names.filter(k => r.hists[k]?.n);
    if (!rows.length) return;
    line(`${title.padEnd(44)} ${"count".padStart(8)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}  ms`);
    for (const k of rows) {
      const h = r.hists[k];
      line(`  ${k.padEnd(42)} ${n(h.n).padStart(8)} ${[50, 95, 99].map(p => n(h.pct(p)).padStart(7)).join(" ")} ${n(h.max).padStart(7)}`);
    }
  };
  table("what the room felt", ROOM);
  table("requests", REQUESTS);
  line();
  const refusals = Object.entries(r.counters).filter(([k]) => k.includes(": ")).sort((a, b) => b[1] - a[1]);
  if (refusals.length) line(`refused or failed: ${refusals.map(([k, v]) => `${k} ×${n(v)}`).join(" · ")}`);
  const notes = ["screens that fell back to polling", "phones that locked their screen", "answers not sent: the phone's clock had run out",
    "screens a phone never got its own view of", "questions the host screen never saw close", "games the host could not finish",
    "games that could not be created", "screens not back after the storm"].filter(k => r.counters[k]);
  if (notes.length) line(notes.map(k => `${k}: ${n(r.counters[k])}`).join(" · "));
  for (const s of r.servers ?? []) {
    line(`server ${s.instance + 1}: CPU avg ${n(s.cpuAvg)}%, max ${n(s.cpuMax)}%, ${s.secondsOver90} s over 90% · memory ${n(s.rssFirst)} → ${n(s.rssMax)} MB (end ${n(s.rssLast)})`);
  }
  if (r.database) {
    const d = r.database;
    line(`database: ${n(d.txAvg)} transactions/s (max ${n(d.txMax)}) · ${n(d.readAvg)} rows read/s · ${n(d.writtenAvg)} written/s · ` +
      `${d.connectionsMax} connections${d.containerCpuAvg != null ? ` · container CPU avg ${n(d.containerCpuAvg)}%, max ${n(d.containerCpuMax)}%` : ""}`);
  }
  if (r.serverErrors?.length) line(`server log: ${r.serverErrors.slice(0, 4).map(([k, v]) => `${k} ×${n(v)}`).join(" · ")}`);
  if (r.storm?.at) {
    line(`storm at ${new Date(r.storm.at).toISOString().slice(11, 19)}` +
      (r.storm.upAgainAfterMs ? ` · servers down after ${(r.storm.downAfterMs / 1000).toFixed(1)} s, up again after ${(r.storm.upAgainAfterMs / 1000).toFixed(1)} s` : "") +
      (r.storm.reloadedAfterMs ? ` · new workers serving after ${(r.storm.reloadedAfterMs / 1000).toFixed(1)} s` : ""));
  }
  const g = r.generator;
  line(`phone processes: ${g.length} · CPU max ${n(Math.max(0, ...g.map(x => x.cpu)))}% of a core · event-loop delay p99 max ${n(Math.max(0, ...g.map(x => x.loopP99)))} ms` +
    (trustworthy(r) ? " · kept up" : " · BEHIND: the phones themselves were a bottleneck, so the numbers are pessimistic"));
  line();
  const list = checks(r);
  for (const c of list) line(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(52)} ${c.detail}`);
  const passed = list.filter(c => c.ok).length;
  line();
  line(`verdict: ${passed === list.length ? "PASS" : "FAIL"} (${passed} of ${list.length} checks)`);
  return out.join("\n");
}

export function passed(r) {
  return checks(r).every(c => c.ok);
}

/* One row per scenario, for the end of a suite. */
export function summary(rows) {
  const out = [];
  out.push(`${"scenario".padEnd(34)} ${"phones".padStart(7)}  verdict  ${"Next→phone p99".padStart(14)}  ${"answers in".padStart(10)}  ${"polling".padStart(7)}  ${"server CPU max".padStart(14)}  ${"DB tx/s".padStart(7)}`);
  for (const { label, r, skipped } of rows) {
    if (skipped) {
      out.push(`${label.padEnd(34)} ${"".padStart(7)}  skipped: ${skipped}`);
      continue;
    }
    const c = r.counters;
    const next = r.hists["Next → phone shows it"];
    const cpu = r.servers?.length ? `${n(Math.max(...r.servers.map(s => s.cpuMax)))}%` : "–";
    out.push([
      label.padEnd(34),
      n(r.options.games * r.options.players).padStart(7),
      ` ${(passed(r) ? "PASS" : "FAIL").padEnd(7)}`,
      (next?.n ? `${n(next.pct(99))} ms` : "–").padStart(14),
      pct(c["answers sent"] ? (c["answers accepted"] ?? 0) / c["answers sent"] : 0).padStart(10),
      n(c["screens that fell back to polling"] ?? 0).padStart(7),
      cpu.padStart(14),
      (r.database ? n(r.database.txAvg) : "–").padStart(7)
    ].join("  "));
  }
  return out.join("\n");
}
