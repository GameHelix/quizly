/* Where phones should go to join, which is what the QR code encodes.
 *
 * PUBLIC_URL wins when it is set. Otherwise it is the address the host
 * screen was opened on, with one exception: "localhost" means nothing to a
 * phone, so on a laptop it is swapped for the laptop's address on the LAN.
 */

import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

const IN_CONTAINER = existsSync("/.dockerenv");

export function joinBase(config, headers, encrypted) {
  if (config.publicUrl) return config.publicUrl;
  const forwarded = name => (config.trustProxy ? String(headers[name] || "").split(",")[0].trim() : "");
  const proto = forwarded("x-forwarded-proto") || (encrypted ? "https" : "http");
  const host = forwarded("x-forwarded-host") || headers.host || `localhost:${config.port}`;
  let url;
  try {
    url = new URL(`${proto === "https" ? "https" : "http"}://${host}`);
  } catch {
    url = new URL(`http://localhost:${config.port}`);
  }
  if (isLoopback(url.hostname) && !IN_CONTAINER) {
    const lan = lanAddress();
    if (lan) url.hostname = lan;
  }
  return url.origin;
}

/* Browsers send Origin on every WebSocket handshake and on cross-site and
 * state-changing requests. A request without one is a same-origin read or
 * not from a browser at all, and the admin cookie alone covers those. */
export function isSameOrigin(headers, config) {
  const origin = headers.origin;
  if (!origin) return true;
  if (config.publicUrl && origin === config.publicUrl) return true;
  try {
    const host = (config.trustProxy && headers["x-forwarded-host"]) || headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");
}

/* The first private IPv4 address on a real interface: Wi-Fi or Ethernet. */
export function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(docker|br-|veth|utun|awdl|llw|bridge|vmnet|vboxnet)/.test(name)) continue;
      candidates.push(a.address);
    }
  }
  return candidates.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) ?? candidates[0] ?? null;
}
