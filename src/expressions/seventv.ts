import { Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { refuse } from "../commands/command.ts";
import { downloadImage } from "./image.ts";

const API = "https://7tv.io/v3";
const API_TIMEOUT = Duration.seconds(15);
/** Emote IDs are ULIDs now; links from before that use 24-digit hex IDs. */
const EMOTE_ID = /^(?:[0-9A-Za-z]{26}|[0-9a-f]{24})$/;
const SITE_HOSTS = new Set(["7tv.app", "www.7tv.app", "old.7tv.app"]);

/** The parts of `GET /v3/emotes/<id>` the bot uses; 7TV sends a lot more. */
const SevenTvEmote = Schema.Struct({
  name: Schema.String,
  host: Schema.Struct({
    url: Schema.String,
    files: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        format: Schema.String,
        width: Schema.Number,
        size: Schema.Number,
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

/**
 * Looks up the emote, trying again a couple of times when 7TV or the network
 * stumbles. The timeout covers reading the answer too, so a body that stalls
 * can't hold the command up.
 */
const lookUpEmote = Effect.fnUntraced(
  function* (id: string) {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.retryTransient({ times: 2 }));
    const response = yield* client.get(`${API}/emotes/${id}`).pipe(
      Effect.catch((err) =>
        Effect.logWarning(`looking up 7TV emote ${id} failed: ${err.message}`).pipe(
          Effect.andThen(refuse("Couldn't reach 7TV.")),
        ),
      ),
    );
    if (response.status === 400 || response.status === 404) {
      return yield* refuse(`7TV has no emote \`${id}\`.`);
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* refuse(`7TV answered with HTTP ${response.status}.`);
    }

    return yield* HttpClientResponse.schemaBodyJson(SevenTvEmote)(response).pipe(
      Effect.catch((err) =>
        Effect.logWarning(`7TV sent an unexpected answer for emote ${id}: ${err.message}`).pipe(
          Effect.andThen(refuse("7TV sent an answer the bot doesn't understand; try again later.")),
        ),
      ),
    );
  },
  (effect, id) =>
    Effect.timeoutOrElse(effect, {
      duration: API_TIMEOUT,
      orElse: () =>
        Effect.logWarning(`looking up 7TV emote ${id} timed out`).pipe(
          Effect.andThen(refuse("Couldn't reach 7TV.")),
        ),
    }),
);

/** Downloads the emote's largest WebP, which keeps any animation, and its name. */
export const fetchSevenTvEmote = Effect.fn("fetchSevenTvEmote")(function* (id: string, maxBytes: number) {
  const emote = yield* lookUpEmote(id);
  // Fluxer refuses animated AVIF, and GIFs are many times the size of the WebP.
  const file = emote.host.files
    .filter((f) => f.format === "WEBP" && f.size <= maxBytes)
    .toSorted((a, b) => b.width - a.width)[0];
  if (!file) return yield* refuse(`7TV has no WebP of \`${emote.name}\` small enough to download.`);

  // `host.url` comes without a scheme, like `//cdn.7tv.app/emote/<id>`.
  const base = new URL(emote.host.url, "https://7tv.app");
  if (base.protocol !== "https:") {
    return yield* Effect.die(new Error(`unexpected 7TV host URL ${emote.host.url}`));
  }
  const image = yield* downloadImage(`${base.href}/${encodeURIComponent(file.name)}`, maxBytes);
  return { name: emote.name, image };
});
