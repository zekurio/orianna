import { downloadFile } from "../download.ts";

export interface ImageType {
  ext: string;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Enough leading bytes for {@link sniffImage} to tell every format apart. */
const SNIFF_BYTES = 12;

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
 * {@link downloadFile} says which hosts the bot connects to.
 */
export function downloadImage(url: string, maxBytes: number, trusted: readonly string[] = []) {
  return downloadFile(url, {
    noun: "image",
    maxBytes,
    trusted,
    check: { bytes: SNIFF_BYTES, problem: (head) => (sniffImage(head) ? undefined : UNSUPPORTED_IMAGE) },
  });
}
