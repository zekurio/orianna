import { UserError } from "../commands/command.ts";

export interface ImageType {
  ext: string;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Enough leading bytes for {@link sniffImage} to tell every format apart. */
const SNIFF_BYTES = 12;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Largest image the bot downloads. Images over the configured limit are
 * scaled down until they fit, so this is well above it.
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
 */
export async function downloadImage(url: string, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new UserError(`That image is too large; the limit is ${formatKiB(maxBytes)}.`);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal });
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
