import { UserError } from "../commands/command.ts";

export interface ImageType {
  ext: string;
  mime: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Detects the image format from its magic bytes. Fluxer accepts a few more
 * formats, but these are the ones that render everywhere.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 12) return null;
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

/** Downloads an attachment, refusing anything larger than `maxBytes`. */
export async function downloadImage(url: string, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new UserError(`That image is too large; the limit is ${formatKiB(maxBytes)}.`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge();

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLarge();
  return bytes;
}

export function formatKiB(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KiB`;
}
