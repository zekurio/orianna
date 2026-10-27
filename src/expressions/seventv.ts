import Type from "typebox";
import Value from "typebox/value";
import { UserError } from "../commands/command.ts";
import { downloadImage } from "./image.ts";

const API = "https://7tv.io/v3";
const API_TIMEOUT_MS = 15_000;
/** Emote IDs are ULIDs now; links from before that use 24-digit hex IDs. */
const EMOTE_ID = /^(?:[0-9A-Za-z]{26}|[0-9a-f]{24})$/;
const SITE_HOSTS = new Set(["7tv.app", "www.7tv.app", "old.7tv.app"]);

/** The parts of `GET /v3/emotes/<id>` the bot uses; 7TV sends a lot more. */
const SevenTvEmote = Type.Object({
  name: Type.String(),
  host: Type.Object({
    url: Type.String(),
    files: Type.Array(
      Type.Object({
        name: Type.String(),
        format: Type.String(),
        width: Type.Number(),
        size: Type.Number(),
      }),
    ),
  }),
});

/**
 * Picks the emote ID out of a 7TV link: an emote page
 * (`https://7tv.app/emotes/<id>`) or one of its files on the CDN
 * (`https://cdn.7tv.app/emote/<id>/4x.webp`).
 */
export function sevenTvEmoteId(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase();
  const [section, id] = pathname.split("/").filter(Boolean);
  const matches =
    (SITE_HOSTS.has(host) && section === "emotes") ||
    (host === "cdn.7tv.app" && section === "emote");
  return matches && id && EMOTE_ID.test(id) ? id : undefined;
}

/** Downloads the emote's largest WebP, which keeps any animation, and its name. */
export async function fetchSevenTvEmote(
  id: string,
  maxBytes: number,
): Promise<{ name: string; image: Uint8Array }> {
  let response: Response;
  try {
    response = await fetch(`${API}/emotes/${id}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (err) {
    console.warn(`looking up 7TV emote ${id} failed:`, err);
    throw new UserError("Couldn't reach 7TV.");
  }
  if (response.status === 400 || response.status === 404) {
    throw new UserError(`7TV has no emote \`${id}\`.`);
  }
  if (!response.ok) throw new UserError(`7TV answered with HTTP ${response.status}.`);

  const emote: unknown = await response.json().catch(() => undefined);
  if (!Value.Check(SevenTvEmote, emote)) {
    console.warn(`7TV sent an unexpected answer for emote ${id}:`, emote);
    throw new UserError("7TV sent an answer the bot doesn't understand; try again later.");
  }
  // Fluxer refuses animated AVIF, and GIFs are many times the size of the WebP.
  const file = emote.host.files
    .filter((f) => f.format === "WEBP" && f.size <= maxBytes)
    .sort((a, b) => b.width - a.width)[0];
  if (!file) throw new UserError(`7TV has no WebP of \`${emote.name}\` small enough to download.`);

  // `host.url` comes without a scheme, like `//cdn.7tv.app/emote/<id>`.
  const base = new URL(emote.host.url, "https://7tv.app");
  if (base.protocol !== "https:") throw new Error(`unexpected 7TV host URL ${emote.host.url}`);
  const image = await downloadImage(`${base.href}/${encodeURIComponent(file.name)}`, maxBytes);
  return { name: emote.name, image };
}
