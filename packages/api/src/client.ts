import { createHmac } from "node:crypto";

/**
 * The block one client holds: an IPv6 address's /64, since a single subscriber
 * is routed a whole /64 and can rotate through it; an IPv4 address as is.
 */
function network(ip: string): string {
  // IPv4-mapped IPv6 (`::ffff:192.0.2.1`) is the IPv4 client it maps
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("::");
  const groups = head === "" ? [] : head.split(":");
  if (tail !== undefined) {
    const after = tail === "" ? [] : tail.split(":");
    const missing = Math.max(0, 8 - groups.length - after.length);
    const zeros = Array<string>(missing).fill("0");
    groups.push(...zeros, ...after);
  }
  const words = groups.map((group) => Number.parseInt(group, 16));
  // the same mapping written in hex (`::ffff:c000:201`)
  if (
    words.length === 8 &&
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff
  ) {
    const [hi = 0, lo = 0] = words.slice(6);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const prefix = groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/**
 * The usage subject for a client: `ip:` and an HMAC keyed by `secret` of its
 * network. Never the IP itself, since IPs are personal data.
 */
export function clientSubject(ip: string | null, secret: string): string {
  // only a local or test request lacks the header: all of them share one subject
  if (ip === null) return "ip:unknown";
  return `ip:${createHmac("sha256", secret).update(network(ip)).digest("hex")}`;
}
