import type { HTMLBundle } from "bun";

// The compiled bot serves the app's files itself instead of handing the
// bundle to Bun, which sends them uncompressed and without telling browsers
// to keep them. The script alone is about 850 KB, a fifth of that compressed,
// which matters on a phone. Each file is compressed once, in the background
// once the bot listens; until a compressed copy is ready, it goes as it is.
// Every file but the page has a hash in its name, so browsers keep it for good
// and only ask for the page again, which changes with each build.

/** What compresses; images and fonts already are. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

/** Best first. Brotli is smallest, and every browser that matters takes it. */
const ENCODINGS = ["br", "gzip"] as const;
type Encoding = (typeof ENCODINGS)[number];

type Bytes = Uint8Array<ArrayBuffer>;

interface Asset {
  readonly body: Bytes;
  readonly headers: Record<string, string>;
  readonly compressed: Partial<Record<Encoding, Bytes>>;
}

/** Off the main thread, so requests go on being answered meanwhile. */
function compress(body: Bytes, encoding: Encoding): Promise<Bytes> {
  // Bun's CompressionStream takes brotli, which the DOM's types don't know.
  const stream = new CompressionStream((encoding === "br" ? "brotli" : "gzip") as CompressionFormat);
  return new Response(new Blob([body]).stream().pipeThrough(stream)).bytes();
}

async function load(file: NonNullable<HTMLBundle["files"]>[number], cacheControl: string): Promise<Asset> {
  const body = await Bun.file(file.path).bytes();
  const contentType = file.headers["content-type"];
  return {
    body,
    headers: {
      "Content-Type": contentType,
      // Weak, since the bytes differ with the encoding.
      ETag: `W/"${file.headers.etag}"`,
      "Cache-Control": cacheControl,
      ...(COMPRESSIBLE.test(contentType) ? { Vary: "Accept-Encoding" } : {}),
    },
    compressed: {},
  };
}

/** Compresses the assets that compress: all with gzip first, which is quick, then with brotli. */
async function compressAll(assets: readonly Asset[]): Promise<void> {
  for (const encoding of ["gzip", "br"] as const) {
    for (const asset of assets) {
      if (!asset.headers.Vary) continue;
      const bytes = await compress(asset.body, encoding).catch(() => undefined);
      if (bytes && bytes.byteLength < asset.body.byteLength) asset.compressed[encoding] = bytes;
    }
  }
}

function respond(asset: Asset, req: Request): Response {
  if (req.headers.get("if-none-match") === asset.headers.ETag) {
    return new Response(null, { status: 304, headers: asset.headers });
  }
  const accepted = req.headers.get("accept-encoding") ?? "";
  for (const encoding of ENCODINGS) {
    const bytes = asset.compressed[encoding];
    if (bytes && accepted.includes(encoding)) {
      return new Response(bytes, { headers: { ...asset.headers, "Content-Encoding": encoding } });
    }
  }
  return new Response(asset.body, { headers: asset.headers });
}

interface AppRoutes {
  readonly files: Record<string, (req: Request) => Response>;
  /** The app, for every page. */
  readonly page: (req: Request) => Response;
  /** Compresses the files, which go uncompressed until then. */
  readonly compress: () => Promise<void>;
}

/**
 * Routes for the files of a bundle built ahead of time, and a handler that
 * answers every other page with the app. Undefined when the bundle wasn't
 * built ahead of time, like when running from source.
 */
export async function appRoutes(
  app: HTMLBundle,
): Promise<AppRoutes | undefined> {
  if (!app.files) return undefined;
  const files: Record<string, (req: Request) => Response> = {};
  const assets: Asset[] = [];
  let page: Asset | undefined;
  for (const file of app.files) {
    if (file.loader === "html") {
      // Asked for on every visit, and answered with 304 while it's the same.
      page = await load(file, "no-cache");
      assets.push(page);
      continue;
    }
    const asset = await load(file, "public, max-age=31536000, immutable");
    assets.push(asset);
    files[`/${file.path.split("/").pop()}`] = (req) => respond(asset, req);
  }
  if (!page) return undefined;
  const index = page;
  return { files, page: (req) => respond(index, req), compress: () => compressAll(assets) };
}
