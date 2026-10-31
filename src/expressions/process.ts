import { join } from "node:path";
import { Context, Data, Duration, Effect, FileSystem, Layer, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { refuse, type UserError } from "../commands/command.ts";
import { formatKiB } from "../download.ts";
import { type ImageType, isAvifSequence, sniffImage, UNSUPPORTED_IMAGE } from "./image.ts";

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
const MAGICK_TIMEOUT = Duration.seconds(90);
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

class MagickError extends Data.TaggedError("MagickError")<{
  readonly message: string;
  /** Down to how ImageMagick is set up, not to the image. */
  readonly setup: boolean;
}> {}

export interface CutOptions {
  count: number;
  /** Longest side of a piece, in pixels; larger pieces are scaled down to it. */
  size: number;
  maxBytes: number;
}

const makeImageMagick = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const slots = yield* Semaphore.make(MAX_RUNNING);
  /** Runs going on or waiting for a slot. */
  let queued = 0;

  /** Waits for a free `magick` slot, or says the bot is busy when too many already wait. */
  function withSlot<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | UserError, R> {
    return Effect.suspend((): Effect.Effect<A, E | UserError, R> => {
      if (queued >= MAX_RUNNING + MAX_WAITING) {
        return refuse("The bot is busy with other images; try again in a minute.");
      }
      queued++;
      return slots.withPermits(1)(effect).pipe(Effect.ensuring(Effect.sync(() => queued--)));
    });
  }

  /**
   * Runs `magick` with the image on stdin and returns what it writes to
   * stdout. A run that takes too long is killed.
   */
  function magick(image: Uint8Array, args: string[], { limits = true } = {}) {
    const run = Effect.gen(function* () {
      const proc = yield* ChildProcess.make("magick", [...(limits ? LIMITS : []), ...args], {
        stdin: Stream.make(image),
      }).pipe(
        Effect.mapError((err) => new MagickError({ message: `couldn't run magick: ${err.message}`, setup: true })),
      );
      const [output, errors, code] = yield* Effect.all(
        [Stream.mkUint8Array(proc.stdout), Stream.mkString(Stream.decodeText(proc.stderr)), proc.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((err) => new MagickError({ message: err.message, setup: false })));
      if (code !== 0) {
        const message = errors.trim() || `exited with ${code}`;
        return yield* new MagickError({ message, setup: SETUP_PROBLEM.test(message) });
      }
      return output;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: MAGICK_TIMEOUT,
        orElse: () => Effect.fail(new MagickError({ message: "magick took too long and was stopped", setup: false })),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return withSlot(run);
  }

  /** Runs `magick`, turning its failures into a UserError that says whose problem it is. */
  function magickOrExplain(image: Uint8Array, args: string[]) {
    return magick(image, args).pipe(
      Effect.catchTag("MagickError", (err) =>
        err.setup
          ? Effect.logError(`magick failed because of how it's set up: ${err.message}`).pipe(
              Effect.andThen(refuse(SETUP_TROUBLE)),
            )
          : Effect.logWarning(`magick failed: ${err.message}`).pipe(
              Effect.andThen(refuse("Couldn't process that image; it may be damaged or too large.")),
            ),
      ),
    );
  }

  /**
   * Checks that `magick` runs and handles the formats the bot needs. Returns
   * what's wrong, if anything.
   */
  const check = Effect.gen(function* () {
    // `-list` has to come first, so without the limits, which only matter for images.
    const output = new TextDecoder().decode(
      yield* magick(new Uint8Array(), ["-list", "format"], { limits: false }),
    );
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
  }).pipe(Effect.catch((err) => Effect.succeed([`ImageMagick doesn't work: ${err.message}`])));

  /** Reads the format, size and frame count without decoding the pixels. */
  const inspect = Effect.fn("ImageMagick.inspect")(function* (image: Uint8Array) {
    const type = sniffImage(image);
    if (!type) return yield* refuse(UNSUPPORTED_IMAGE);

    // Animations print one line per frame, each with the frame count.
    const output = new TextDecoder().decode(
      yield* magickOrExplain(image, ["-ping", input(type), "-format", "%n %W %H %[orientation]\\n", "info:"]),
    );
    const [count, w, h, orientation = "Undefined"] = output.split("\n")[0]!.split(" ");
    const [frames, width, height] = [count, w, h].map(Number);
    if (!(frames! >= 1 && width! >= 1 && height! >= 1)) {
      yield* Effect.logWarning(`magick described an image as ${JSON.stringify(output)}`);
      return yield* refuse("Couldn't read that image; it may be damaged.");
    }
    // Processing applies the orientation (see render), so measure the result.
    const turned = SIDEWAYS.has(orientation);
    const info: ImageInfo = {
      type,
      width: turned ? height! : width!,
      height: turned ? width! : height!,
      frames: frames!,
      upright: orientation === "Undefined" || orientation === "TopLeft",
    };
    return info;
  });

  /**
   * Cuts the image into `count` pieces along its long side, then scales the
   * pieces down, all by the same amount, until each fits in `maxBytes`. An image
   * that needs none of this, and that Fluxer takes as it is, is returned
   * unchanged. Animations come out as WebP, everything else as PNG.
   */
  const cutImage = Effect.fn("ImageMagick.cut")(function* (
    image: Uint8Array,
    info: ImageInfo,
    { count, size, maxBytes }: CutOptions,
  ) {
    if (count === 1 && info.upright && image.length <= maxBytes && !isAvifSequence(image)) {
      const unchanged: ProcessedImage[] = [{ image, type: info.type }];
      return unchanged;
    }

    const regions = cut(info, count);
    // Small pieces keep their size; they aren't scaled up.
    let side = Math.min(size, Math.max(...regions.map((r) => Math.max(r.width, r.height))));
    for (let attempt = 1; ; attempt++) {
      const pieces = yield* render(image, info, regions, side);
      const largest = Math.max(...pieces.map((p) => p.image.length));
      if (largest <= maxBytes) return pieces;

      // The file size follows the area, so shrink the sides by the square root.
      const next = Math.floor(side * Math.sqrt(maxBytes / largest) * 0.9);
      if (attempt === FIT_ATTEMPTS || next < MIN_SIDE) {
        return yield* refuse(
          `At ${side} px across, the image still comes to ${formatKiB(largest)}; ` +
            `the limit is ${formatKiB(maxBytes)}. A shorter animation or a simpler picture might fit.`,
        );
      }
      side = next;
    }
  });

  /**
   * Crops and scales every piece in one `magick` run, so the image is decoded
   * once. Each piece is written to a file of its own, in a directory that is
   * removed afterwards.
   */
  function render(image: Uint8Array, info: ImageInfo, regions: Region[], side: number) {
    return Effect.gen(function* () {
      const animated = info.frames > 1;
      const type = animated ? WEBP : PNG;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orianna-" }).pipe(Effect.orDie);
      const files = regions.map((_, i) => join(dir, `${i}.${type.ext}`));
      yield* magickOrExplain(image, [
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
      return yield* Effect.forEach(files, (file) =>
        fs.readFile(file).pipe(
          Effect.orDie,
          Effect.map((bytes): ProcessedImage => ({ image: bytes, type })),
        ),
      );
    }).pipe(Effect.scoped);
  }

  return { check, inspect, cut: cutImage };
});

/** Decodes and encodes images with ImageMagick's `magick`, a few at a time. */
export class ImageMagick extends Context.Service<ImageMagick>()("orianna/ImageMagick", {
  make: makeImageMagick,
}) {
  static readonly layer = Layer.effect(ImageMagick, makeImageMagick);
}

/**
 * How many roughly square pieces an image is cut into: one, unless it is at
 * least twice as wide as it is tall or the other way round.
 */
export function pieceCount({ width, height }: ImageInfo, max: number): number {
  const ratio = Math.max(width / height, height / width);
  return ratio < SPLIT_RATIO ? 1 : Math.min(max, Math.round(ratio));
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

/** Reads stdin with the sniffed coder, so ImageMagick never guesses the format. */
function input(type: ImageType): string {
  return `${type.ext}:-`;
}

