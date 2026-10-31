import { Duration, Effect, Option, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { refuse, UserError } from "./commands/command.ts";
import { checkPublicHost, RefusedHost } from "./expressions/address.ts";

const DOWNLOAD_TIMEOUT = Duration.seconds(15);
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface DownloadOptions {
  /** What the file is, in messages to the member, e.g. "image". */
  noun: string;
  maxBytes: number;
  /** Origins that skip the public internet check; see {@link downloadFile}. */
  trusted?: readonly string[];
  /**
   * Looks at the first `bytes` bytes as soon as they arrive, or at the whole
   * file when it's shorter, and returns why the file is refused, if it is.
   */
  check?: { bytes: number; problem(head: Uint8Array): string | undefined };
}

/**
 * Downloads an attached or linked file, refusing anything larger than
 * `maxBytes`. Every failure is a UserError the member can read.
 *
 * The bot only connects to hosts on the public internet, at every redirect,
 * so a member can't use it to look around its own machine or network. A host
 * with the same origin as a URL in `trusted` skips that check.
 */
export const downloadFile = Effect.fn("downloadFile")(function* (
  url: string,
  { noun, maxBytes, trusted = [], check }: DownloadOptions,
) {
  const tooLarge = () =>
    new UserError({ message: `That ${noun} is too large; the limit is ${formatKiB(maxBytes)}.` });

  return yield* Effect.gen(function* () {
    const response = yield* fetchPublic(url, trusted);
    if (response.status < 200 || response.status >= 300) {
      return yield* refuse(`Couldn't download the ${noun} (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers["content-length"]);

    const chunks: Uint8Array[] = [];
    let length = 0;
    let checked = false;
    // The check comes before the declared size, so a link to a web page is
    // refused for what it is rather than for its size.
    const checkHead = () =>
      Effect.suspend(() => {
        checked = true;
        const problem = check?.problem(concat(chunks, length));
        if (problem) return refuse(problem);
        return declared > maxBytes ? Effect.fail(tooLarge()) : Effect.void;
      });

    if (!check) yield* checkHead();
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.gen(function* () {
        chunks.push(chunk);
        length += chunk.length;
        if (!checked && length >= check!.bytes) yield* checkHead();
        if (length > maxBytes) return yield* Effect.fail(tooLarge());
      }),
    );
    if (!checked) yield* checkHead();
    return concat(chunks, length);
  }).pipe(
    Effect.timeoutOrElse({
      duration: DOWNLOAD_TIMEOUT,
      orElse: () => refuse(`Downloading the ${noun} timed out.`),
    }),
    Effect.catchIf(
      (err) => !(err instanceof UserError),
      (err) =>
        Effect.logWarning(`downloading ${url} failed: ${err.message}`).pipe(
          Effect.andThen(refuse(`Couldn't download the ${noun}.`)),
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
