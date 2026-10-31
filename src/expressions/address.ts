import { isIP } from "node:net";
import { Data, Effect, Result } from "effect";
import { Dns, Host, NetAddress } from "effect/net";

interface Address {
  family: 4 | 6;
  value: bigint;
}

/** The top 96 bits of IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses. */
const IPV4_IN_IPV6 = [0xffffn, 0x64ff9bn << 64n];

/**
 * Ranges that aren't on the public internet, from the IANA special-purpose
 * address registries. {@link parseAddress} turns IPv4 written inside IPv6
 * into plain IPv4, so it meets the IPv4 ranges.
 */
const NOT_PUBLIC = [
  "0.0.0.0/8", // this network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // 6to4 relays
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/3", // multicast, reserved and broadcast
  // Everything outside global unicast, 2000::/3: unspecified, loopback,
  // unique-local, link-local, multicast and the rest.
  "::/3",
  "4000::/2",
  "8000::/1",
  "2001::/23", // IETF protocol assignments, Teredo among them
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4
  "3fff::/20", // documentation
].map((range) => {
  const [text, bits] = range.split("/");
  const { family, value } = parseAddress(text!)!;
  const shift = BigInt((family === 4 ? 32 : 128) - Number(bits));
  return { family, shift, prefix: value >> shift };
});

/** Whether `address`, an IPv4 or IPv6 address, is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  return !NOT_PUBLIC.some(
    (range) => parsed.family === range.family && parsed.value >> range.shift === range.prefix,
  );
}

/** The bot won't connect to a link's host. */
export class RefusedHost extends Data.TaggedError("RefusedHost")<{ readonly message: string }> {}

/**
 * Fails unless every address `hostname` resolves to is public, so a link
 * can't reach the bot's own machine or the network it's on. Takes a URL's
 * `hostname`, where an IPv6 address is in brackets.
 */
export const checkPublicHost = Effect.fnUntraced(function* (hostname: string) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  let addresses = [host];
  if (!isIP(host)) {
    const name = Host.domainNameFromString(host);
    if (Result.isFailure(name)) {
      return yield* new RefusedHost({ message: `${hostname} is not a host name` });
    }
    const found = yield* (yield* Dns.Dns).lookup(name.success, undefined);
    addresses = found.map(NetAddress.formatIp);
  }
  const refused = addresses.find((a) => !isPublicAddress(a));
  if (refused !== undefined || addresses.length === 0) {
    return yield* new RefusedHost({
      message: `${hostname} resolves to ${refused ?? "nothing"}, which isn't public`,
    });
  }
});

/**
 * Reads an address into a number. IPv4 inside IPv6, mapped or behind NAT64,
 * comes out as IPv4 so that it meets the same ranges.
 */
function parseAddress(text: string): Address | null {
  const address = text.replace(/%.*$/, "");
  const family = isIP(address);
  if (family === 4) return { family, value: ipv4Value(address) };
  if (family !== 6) return null;

  const value = ipv6Value(address);
  if (IPV4_IN_IPV6.includes(value >> 32n)) return { family: 4, value: value & 0xffffffffn };
  return { family: 6, value };
}

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n);
}

function ipv6Value(address: string): bigint {
  // A dotted IPv4 tail, as in `::ffff:127.0.0.1`, stands for the last two groups.
  const tail = /\d+\.\d+\.\d+\.\d+$/.exec(address);
  let hex = address;
  if (tail) {
    const v4 = ipv4Value(tail[0]);
    hex = `${address.slice(0, tail.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const [head, rest] = hex.split("::");
  const all =
    rest === undefined
      ? groups(head)
      : [
          ...groups(head),
          ...Array<string>(8 - groups(head).length - groups(rest).length).fill("0"),
          ...groups(rest),
        ];
  return all.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}
