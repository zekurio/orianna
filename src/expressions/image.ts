import { Duration, Effect, Option, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { refuse, UserError } from "../commands/command.ts";
import { checkPublicHost, RefusedHost } from "./address.ts";

export interface ImageType {
  ext: string;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Enough leading bytes for {@link sniffImage} to tell every format apart. */
const SNIFF_BYTES = 12;
const DOWNLOAD_TIMEOUT = Duration.seconds(15);
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Largest image the bot downloads, unless the configured limit is higher.
 * Images over that limit are scaled down until they fit, so this is well
 * above the default.
 */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export const UNSUPPORTED_IMAGE = "The image must be a PNG, JPEG, GIF, WebP or AVIF file.";

/**
 * Detects the image format from its magic bytes. Fluxer accepts a few more
 * formats, but these are the ones that render everywhere.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length < SNIFF_BYTES) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") {
    return { ext: "png", mime: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return { ext: "gif", mime: "image/gif" };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) {
    return { ext: "avif", mime: "image/avif" };
  }
  return null;
}

/** An animated AVIF, which Fluxer refuses. */
export function isAvifSequence(bytes: Uint8Array): boolean {
  return bytes.length >= SNIFF_BYTES && ascii(bytes, 4, 12) === "ftypavis";
}

/**
 * Downloads an attached or linked image, refusing anything larger than
 * `maxBytes`. The magic bytes are checked as soon as they arrive, so a link to
 * a web page or any other non-image is dropped without downloading the rest.
 *
 * The bot only connects to hosts on the public internet, at every redirect,
 * so a member can't use it to look around its own machine or network. A host
 * with the same origin as a URL in `trusted` skips that check.
 */
export const downloadImage = Effect.fn("downloadImage")(function* (
  url: string,
  maxBytes: number,
  trusted: readonly string[] = [],
) {
  const tooLarge = () =>
    new UserError({ message: `That image is too large; the limit is ${formatKiB(maxBytes)}.` });

  return yield* Effect.gen(function* () {
    const response = yield* fetchPublic(url, trusted);
    if (response.status < 200 || response.status >= 300) {
      return yield* refuse(`Couldn't download the image (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers["content-length"]);

    const chunks: Uint8Array[] = [];
    let length = 0;
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.suspend(() => {
        const sniffed = length >= SNIFF_BYTES;
        chunks.push(chunk);
        length += chunk.length;
        if (!sniffed && length >= SNIFF_BYTES) {
          if (!sniffImage(concat(chunks, length))) return refuse(UNSUPPORTED_IMAGE);
          if (declared > maxBytes) return Effect.fail(tooLarge());
        }
        return length > maxBytes ? Effect.fail(tooLarge()) : Effect.void;
      }),
    );
    if (length < SNIFF_BYTES) return yield* refuse(UNSUPPORTED_IMAGE);
    return concat(chunks, length);
  }).pipe(
    Effect.timeoutOrElse({
      duration: DOWNLOAD_TIMEOUT,
      orElse: () => refuse("Downloading the image timed out."),
    }),
    Effect.catchIf(
      (err) => !(err instanceof UserError),
      (err) =>
        Effect.logWarning(`downloading ${url} failed: ${err.message}`).pipe(
          Effect.andThen(refuse("Couldn't download the image.")),
        ),
    ),
  );
});

/**
 * Fetches `url` and follows redirects one at a time, so it can check each
 * hop. A refused hop fails with RefusedHost, and the member sees a failed
 * download, the same as for a host that doesn't answer.
 */
const fetchPublic = Effect.fnUntraced(function* (url: string, trusted: readonly string[]) {
  const client = yield* HttpClient.HttpClient;
  const trustedOrigins = new Set(trusted.map((t) => new URL(t).origin));
  let next = yield* parseUrl(url);
  for (let redirects = 0; ; redirects++) {
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return yield* new RefusedHost({ message: `refusing ${next.protocol} link ${next.href}` });
    }
    if (!trustedOrigins.has(next.origin)) yield* checkPublicHost(next.hostname);

    const response: HttpClientResponse.HttpClientResponse = yield* client
      .get(next.href)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const location = response.headers["location"];
    if (!REDIRECTS.has(response.status) || location === undefined) return response;
    yield* cancelBody(response);
    if (redirects === MAX_REDIRECTS) {
      return yield* new RefusedHost({ message: `more than ${MAX_REDIRECTS} redirects` });
    }
    next = yield* parseUrl(location, next);
  }
});

/** Lets go of a body the bot won't read. */
function cancelBody(response: HttpClientResponse.HttpClientResponse) {
  return Option.match(HttpClientResponse.toWeb(response), {
    onNone: () => Effect.void,
    onSome: (web) => Effect.ignore(Effect.tryPromise(async () => web.body?.cancel())),
  });
}

function parseUrl(url: string, base?: URL) {
  return Effect.try({
    try: () => new URL(url, base),
    catch: () => new RefusedHost({ message: `${url} is not a link` }),
  });
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function formatKiB(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KiB`;
}
