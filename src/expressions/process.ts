import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/** How many `magick` runs may go at once; the rest wait their turn. */
const MAX_RUNNING = 2;
/** Beyond this many waiting, the bot says it's busy instead of queueing more. */
const MAX_WAITING = 8;

/** Errors that come from how ImageMagick is set up rather than from the image. */
const SETUP_PROBLEM = /no (?:decode|encode) delegate|delegate failed|not authorized|security policy/i;
const SETUP_TROUBLE = "The bot isn't set up to process this kind of image; an admin should check its logs.";
/** Formats the bot reads and writes, by ImageMagick's name for them. */
const NEEDED_FORMATS = { read: ["PNG", "JPEG", "GIF", "WEBP", "AVIF"], write: ["PNG", "WEBP"] };

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
  /** As shown, with any EXIF orientation applied. */
  width: number;
  height: number;
  frames: number;
  /** False when EXIF says to turn or flip the image before showing it. */
  upright: boolean;
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

  constructor(
    message: string,
    /** Down to how ImageMagick is set up, not to the image. */
    readonly setup: boolean,
  ) {
    super(message);
  }
}

/**
 * Checks that `magick` runs and handles the formats the bot needs. Returns
 * what's wrong, if anything.
 */
export async function checkImageMagick(): Promise<string[]> {
  let output: string;
  try {
    // `-list` has to come first, so without the limits, which only matter for images.
    output = new TextDecoder().decode(
      await magick(new Uint8Array(), ["-list", "format"], { limits: false }),
    );
  } catch (err) {
    return [`ImageMagick doesn't work: ${(err as Error).message}`];
  }
  // Lines like `     WEBP* rw+   WebP Image Format (libwebp 1.6.0)`.
  const modes = new Map(
    [...output.matchAll(/^\s*([A-Z0-9]+)\*?\s+([r-])([w-])/gm)].map((m) => [m[1]!, m[2]! + m[3]!]),
  );
  return [
    ...NEEDED_FORMATS.read
      .filter((format) => modes.get(format)?.[0] !== "r")
      .map((format) => `ImageMagick can't read ${format}`),
    ...NEEDED_FORMATS.write
      .filter((format) => modes.get(format)?.[1] !== "w")
      .map((format) => `ImageMagick can't write ${format}`),
  ];
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
  const [count, w, h, orientation = "Undefined"] = output.split("\n")[0]!.split(" ");
  const [frames, width, height] = [count, w, h].map(Number);
  if (!(frames! >= 1 && width! >= 1 && height! >= 1)) {
    console.warn(`magick described an image as ${JSON.stringify(output)}`);
    throw new UserError("Couldn't read that image; it may be damaged.");
  }
  // Processing applies the orientation (see render), so measure the result.
  const turned = SIDEWAYS.has(orientation);
  return {
    type,
    width: turned ? height! : width!,
    height: turned ? width! : height!,
    frames: frames!,
    upright: orientation === "Undefined" || orientation === "TopLeft",
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
 * that needs none of this, and that Fluxer takes as it is, is returned
 * unchanged. Animations come out as WebP, everything else as PNG.
 */
export async function cutImage(
  image: Uint8Array,
  info: ImageInfo,
  { count, size, maxBytes }: CutOptions,
): Promise<ProcessedImage[]> {
  if (count === 1 && info.upright && image.length <= maxBytes && !isAvifSequence(image)) {
    return [{ image, type: info.type }];
  }

  const regions = cut(info, count);
  // Small pieces keep their size; they aren't scaled up.
  let side = Math.min(size, Math.max(...regions.map((r) => Math.max(r.width, r.height))));
  for (let attempt = 1; ; attempt++) {
    const pieces = await render(image, info, regions, side);
    const largest = Math.max(...pieces.map((p) => p.image.length));
    if (largest <= maxBytes) return pieces;

    // The file size follows the area, so shrink the sides by the square root.
    const next = Math.floor(side * Math.sqrt(maxBytes / largest) * 0.9);
    if (attempt === FIT_ATTEMPTS || next < MIN_SIDE) {
      throw new UserError(
        `At ${side} px across, the image still comes to ${formatKiB(largest)}; ` +
          `the limit is ${formatKiB(maxBytes)}. A shorter animation or a simpler picture might fit.`,
      );
    }
    side = next;
  }
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

/**
 * Crops and scales every piece in one `magick` run, so the image is decoded
 * once. Each piece is written to a file of its own.
 */
async function render(
  image: Uint8Array,
  info: ImageInfo,
  regions: Region[],
  side: number,
): Promise<ProcessedImage[]> {
  const animated = info.frames > 1;
  const type = animated ? WEBP : PNG;
  const dir = await mkdtemp(join(tmpdir(), "orianna-"));
  const files = regions.map((_, i) => join(dir, `${i}.${type.ext}`));
  try {
    await magickOrExplain(image, [
      input(info.type),
      // The pieces carry no EXIF orientation, so apply it to the pixels.
      "-auto-orient",
      // Animation frames may only hold what changed; make each a full picture first.
      "-coalesce",
      ...(animated ? ["-quality", WEBP_QUALITY] : []),
      "-write",
      "mpr:source",
      "+delete",
      ...regions.flatMap((r, i) => [
        "(",
        "mpr:source",
        "-crop",
        `${r.width}x${r.height}+${r.left}+${r.top}`,
        "+repage",
        "-resize",
        `${side}x${side}>`,
        "-write",
        `${type.ext}:${files[i]}`,
        "+delete",
        ")",
      ]),
      "null:",
    ]);
    return await Promise.all(files.map(async (file) => ({ image: await Bun.file(file).bytes(), type })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads stdin with the sniffed coder, so ImageMagick never guesses the format. */
function input(type: ImageType): string {
  return `${type.ext}:-`;
}

/** Runs `magick`, turning its failures into a UserError that says whose problem it is. */
async function magickOrExplain(image: Uint8Array, args: string[]): Promise<Uint8Array> {
  try {
    return await magick(image, args);
  } catch (err) {
    if (!(err instanceof MagickError)) throw err;
    if (err.setup) {
      console.error("magick failed because of how it's set up:", err.message);
      throw new UserError(SETUP_TROUBLE);
    }
    console.warn("magick failed:", err.message);
    throw new UserError("Couldn't process that image; it may be damaged or too large.");
  }
}

let running = 0;
const waiting: (() => void)[] = [];

/** Waits for a free `magick` slot and returns the function that gives it back. */
async function takeSlot(): Promise<() => void> {
  if (running < MAX_RUNNING) {
    running++;
  } else if (waiting.length >= MAX_WAITING) {
    throw new UserError("The bot is busy with other images; try again in a minute.");
  } else {
    // A slot that frees up is handed straight over, so `running` stays as it is.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  return () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
}

/** Runs `magick` with the image on stdin and returns what it writes to stdout. */
async function magick(
  image: Uint8Array,
  args: string[],
  { limits = true } = {},
): Promise<Uint8Array> {
  const release = await takeSlot();
  try {
    let proc;
    try {
      proc = Bun.spawn(["magick", ...(limits ? LIMITS : []), ...args], {
        stdin: image,
        stdout: "pipe",
        stderr: "pipe",
        timeout: MAGICK_TIMEOUT_MS,
      });
    } catch (err) {
      throw new MagickError(`couldn't run magick: ${(err as Error).message}`, true);
    }
    const [output, errors, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode) throw new MagickError(`magick was stopped with ${proc.signalCode}`, false);
    if (code !== 0) {
      const message = errors.trim() || `exited with ${code}`;
      throw new MagickError(message, SETUP_PROBLEM.test(message));
    }
    return output;
  } finally {
    release();
  }
}
