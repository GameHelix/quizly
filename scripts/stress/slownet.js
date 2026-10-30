/* A phone's mobile network, for `npm run stress-test -- --mobile 0.5`: a TCP
 * relay between simulated phones and one Quizly instance that delivers every
 * chunk, either way, half a round trip late give or take some jitter, and now
 * and then much later, as when a lost packet has to be sent again. Chunks
 * never overtake each other.
 *
 *   node scripts/stress/slownet.js <listen port> <target port> [rtt ms] [jitter ms] [stall share] [stall ms]
 */

import net from "node:net";

const [listen, target, rtt = 150, jitter = 80, stallShare = 0.02, stallMs = 400] = process.argv.slice(2).map(Number);

net.createServer(phone => {
  const server = net.connect(target, "127.0.0.1");
  late(phone, server);
  late(server, phone);
}).listen(listen, "127.0.0.1", () => process.send?.({ type: "ready" }));

/* One direction of a connection. Everything waits in one queue drained by one
 * timer: two timers due in the same millisecond may fire in either order,
 * which would scramble the HTTP inside. */
function late(from, to) {
  const queue = [];   // [when it lands, a chunk, or "end" or "close"]
  let due = 0;        // when the last one lands: the next may not land before it
  let timer = null;
  const drain = () => {
    timer = null;
    while (queue.length && queue[0][0] <= Date.now()) {
      const [, item] = queue.shift();
      if (item === "close") to.destroy();
      else if (to.destroyed) continue;
      else if (item === "end") to.end();
      else to.write(item);
    }
    if (queue.length) timer = setTimeout(drain, queue[0][0] - Date.now());
  };
  const send = item => {
    let ms = rtt / 2 + (Math.random() * 2 - 1) * (jitter / 2);
    if (Math.random() < stallShare) ms += stallMs;
    due = Math.max(due, Date.now() + Math.max(0, ms));
    queue.push([due, item]);
    timer ??= setTimeout(drain, due - Date.now());
  };
  from.on("data", chunk => send(chunk));
  from.on("end", () => send("end"));
  from.on("close", () => send("close"));
  from.on("error", () => {});
}
