import { UserError } from "../commands/command.ts";
import { formatKiB, type ImageType, isAvifSequence, sniffImage, UNSUPPORTED_IMAGE } from "./image.ts";

// Images are decoded and encoded by ImageMagick's `magick`, which the Nix
// package puts on the bot's PATH.

/** Applied before the image is read, so a hostile file can't exhaust the machine. */
const LIMITS = [
  ["width", "8192"],
  ["height", "8192"],
  ["list-length", "1000"],
  ["memory", "512MiB"],
  ["disk", "1GiB"],
  ["time", "60"],
].flatMap(([name, value]) => ["-limit", name!, value!]);
/** Backstop in case `-limit time` doesn't stop it. */
const MAGICK_TIMEOUT_MS = 90_000;

const PNG: ImageType = { ext: "png", mime: "image/png" };
const WEBP: ImageType = { ext: "webp", mime: "image/webp" };
const WEBP_QUALITY = "75";

/** Images at least this many times wider than tall, or taller than wide, are cut up. */
const SPLIT_RATIO = 2;
/** Smallest side the bot scales an image down to before giving up on fitting it. */
const MIN_SIDE = 32;
const FIT_ATTEMPTS = 4;
/** EXIF orientations that swap width and height. */
const SIDEWAYS = new Set(["LeftTop", "RightTop", "RightBottom", "LeftBottom"]);

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
  frames: number;
}

export interface ProcessedImage {
  image: Uint8Array;
  type: ImageType;
}

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

class MagickError extends Error {
  override name = "MagickError";
}

/** Reads the format, size and frame count without decoding the pixels. */
export async function inspectImage(image: Uint8Array): Promise<ImageInfo> {
  const type = sniffImage(image);
  if (!type) throw new UserError(UNSUPPORTED_IMAGE);

  // Animations print one line per frame, each with the frame count.
  const output = new TextDecoder().decode(
    await magickOrExplain(image, [
      "-ping",
      input(type),
      "-format",
      "%n %W %H %[orientation]\\n",
      "info:",
    ]),
  );
  const [count, w, h, orientation] = output.split("\n")[0]!.split(" ");
  const [frames, width, height] = [count, w, h].map(Number);
  if (!(frames! >= 1 && width! >= 1 && height! >= 1)) {
    console.warn(`magick described an image as ${JSON.stringify(output)}`);
    throw new UserError("Couldn't read that image; it may be damaged.");
  }
  // Photos taken sideways are turned upright before they're cut; see render.
  const turned = SIDEWAYS.has(orientation ?? "");
  return {
    type,
    width: turned ? height! : width!,
    height: turned ? width! : height!,
    frames: frames!,
  };
}

/**
 * How many roughly square pieces an image is cut into: one, unless it is at
 * least twice as wide as it is tall or the other way round.
 */
export function pieceCount({ width, height }: ImageInfo, max: number): number {
  const ratio = Math.max(width / height, height / width);
  return ratio < SPLIT_RATIO ? 1 : Math.min(max, Math.round(ratio));
}

export interface CutOptions {
  count: number;
  /** Longest side of a piece, in pixels; larger pieces are scaled down to it. */
  size: number;
  maxBytes: number;
}

/**
 * Cuts the image into `count` pieces along its long side, then scales the
 * pieces down, all by the same amount, until each fits in `maxBytes`. An image
 * that needs neither, and that Fluxer takes as it is, is returned unchanged.
 * Animations come out as WebP, everything else as PNG.
 */
export async function cutImage(
  image: Uint8Array,
  info: ImageInfo,
  { count, size, maxBytes }: CutOptions,
): Promise<ProcessedImage[]> {
  if (count === 1 && image.length <= maxBytes && !isAvifSequence(image)) {
    return [{ image, type: info.type }];
  }

  const regions = cut(info, count);
  let side = Math.min(size, Math.max(...regions.map((r) => Math.max(r.width, r.height))));
  let largest = 0;
  for (let attempt = 0; attempt < FIT_ATTEMPTS && side >= MIN_SIDE; attempt++) {
    const pieces: ProcessedImage[] = [];
    largest = 0;
    for (const region of regions) {
      const piece = await render(image, info, region, side);
      largest = Math.max(largest, piece.image.length);
      if (piece.image.length > maxBytes) break;
      pieces.push(piece);
    }
    if (pieces.length === regions.length) return pieces;
    // The file size follows the area, so shrink the sides by the square root.
    side = Math.floor(side * Math.sqrt(maxBytes / largest) * 0.9);
  }
  throw new UserError(
    `Even scaled down, the image comes to ${formatKiB(largest)}; the limit is ${formatKiB(maxBytes)}. ` +
      "A shorter animation or a simpler picture might fit.",
  );
}

/** Splits the long side into `count` parts that differ by a pixel at most. */
function cut({ width, height }: ImageInfo, count: number): Region[] {
  const wide = width >= height;
  const length = wide ? width : height;
  return Array.from({ length: count }, (_, i) => {
    const start = Math.round((i * length) / count);
    const end = Math.round(((i + 1) * length) / count);
    return wide
      ? { left: start, top: 0, width: end - start, height }
      : { left: 0, top: start, width, height: end - start };
  });
}

async function render(
  image: Uint8Array,
  info: ImageInfo,
  region: Region,
  side: number,
): Promise<ProcessedImage> {
  const animated = info.frames > 1;
  const type = animated ? WEBP : PNG;
  const data = await magickOrExplain(image, [
    input(info.type),
    // The pieces carry no EXIF orientation, so apply it to the pixels.
    "-auto-orient",
    // Animation frames may only hold what changed; make each a full picture first.
    "-coalesce",
    "-crop",
    `${region.width}x${region.height}+${region.left}+${region.top}`,
    "+repage",
    "-resize",
    `${side}x${side}>`,
    ...(animated ? ["-quality", WEBP_QUALITY] : []),
    `${type.ext}:-`,
  ]);
  return { image: data, type };
}

/** Reads stdin with the sniffed coder, so ImageMagick never guesses the format. */
function input(type: ImageType): string {
  return `${type.ext}:-`;
}

/** Runs `magick`, turning a failure to handle the image into a UserError. */
async function magickOrExplain(image: Uint8Array, args: string[]): Promise<Uint8Array> {
  try {
    return await magick(image, args);
  } catch (err) {
    if (!(err instanceof MagickError)) throw err;
    console.warn("magick failed:", err.message);
    throw new UserError("Couldn't process that image; it may be damaged or too large.");
  }
}

/** Runs `magick` with the image on stdin and returns what it writes to stdout. */
async function magick(image: Uint8Array, args: string[]): Promise<Uint8Array> {
  const proc = Bun.spawn(["magick", ...LIMITS, ...args], {
    stdin: image,
    stdout: "pipe",
    stderr: "pipe",
    timeout: MAGICK_TIMEOUT_MS,
  });
  const [output, errors, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new MagickError(errors.trim() || `exited with ${code}`);
  return output;
}
