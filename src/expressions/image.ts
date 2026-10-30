import { UserError } from "../commands/command.ts";
import { checkPublicHost } from "./address.ts";

export interface ImageType {
  ext: string;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Enough leading bytes for {@link sniffImage} to tell every format apart. */
const SNIFF_BYTES = 12;
const DOWNLOAD_TIMEOUT_MS = 15_000;
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
export async function downloadImage(
  url: string,
  maxBytes: number,
  trusted: readonly string[] = [],
): Promise<Uint8Array> {
  const tooLarge = () =>
    new UserError(`That image is too large; the limit is ${formatKiB(maxBytes)}.`);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetchPublic(url, trusted, signal);
    if (!response.ok) {
      throw new UserError(`Couldn't download the image (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get("content-length"));

    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      const sniffed = length >= SNIFF_BYTES;
      chunks.push(chunk);
      length += chunk.length;
      if (!sniffed && length >= SNIFF_BYTES) {
        if (!sniffImage(concat(chunks, length))) throw new UserError(UNSUPPORTED_IMAGE);
        if (declared > maxBytes) throw tooLarge();
      }
      if (length > maxBytes) throw tooLarge();
    }
    if (length < SNIFF_BYTES) throw new UserError(UNSUPPORTED_IMAGE);
    return concat(chunks, length);
  } catch (err) {
    if (err instanceof UserError) throw err;
    console.warn(`downloading ${url} failed:`, err);
    throw new UserError(
      signal.aborted ? "Downloading the image timed out." : "Couldn't download the image.",
    );
  }
}

/**
 * Fetches `url` and follows redirects one at a time, so it can check each
 * hop. A refused hop throws a plain error, and the member sees a failed
 * download, the same as for a host that doesn't answer.
 */
async function fetchPublic(
  url: string,
  trusted: readonly string[],
  signal: AbortSignal,
): Promise<Response> {
  const trustedOrigins = new Set(trusted.map((t) => new URL(t).origin));
  let next = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`refusing ${next.protocol} link ${next.href}`);
    }
    if (!trustedOrigins.has(next.origin)) await checkPublicHost(next.hostname);

    const response = await fetch(next.href, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null) return response;
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    next = new URL(location, next);
  }
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
