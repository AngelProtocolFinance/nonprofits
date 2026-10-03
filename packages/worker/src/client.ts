const encode = (text: string) => new TextEncoder().encode(text);

// one import per isolate per secret value: a rotated secret gets a fresh key
let hmac: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (hmac?.secret !== secret) {
    const key = crypto.subtle.importKey(
      "raw",
      encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    hmac = { secret, key };
  }
  return hmac.key;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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
  const prefix = groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/**
 * The usage subject for a client: `ip:` and an HMAC keyed by `secret` of its
 * network, plus the calling zone when another zone's Worker sent the request
 * (Cloudflare may give every such request one shared IP). Never the IP itself,
 * since IPs are personal data.
 */
export async function clientSubject(
  client: { ip: string | null; worker: string | null },
  secret: string,
): Promise<string> {
  // only a local or test request lacks the header: all of them share one subject
  if (client.ip === null) return "ip:unknown";
  // a newline can't occur in an IP or a header value, so no two clients collide
  const identity =
    client.worker === null
      ? network(client.ip)
      : `${network(client.ip)}\n${client.worker}`;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encode(identity),
  );
  return `ip:${hex(mac)}`;
}
