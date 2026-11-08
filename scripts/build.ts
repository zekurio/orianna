import type { BuildOutput } from "bun";
import tailwind from "bun-plugin-tailwind";
import type { Encoding, WebFile } from "../src/web/assets.ts";
import cn from "./cn.ts";
import icons from "./icons.ts";

// `bun run build`: the bot, the web interface and the migrations in one
// executable, dist/orianna. The `bun build` CLI can't load plugins yet, and
// the web interface's styles need Tailwind's, so the build runs from here.
// bunfig.toml has the plugins that apply when running from source as well.
//
// The web interface is built first, into dist/web, and compressed there:
// brotli at its best takes a second over the script, which the bot would
// otherwise spend each time it starts. The bot carries the files inside, and
// src/web/assets.ts serves them.

const WEB = "dist/web";

// What --production does.
const define = { "process.env.NODE_ENV": JSON.stringify("production") };

function check(result: BuildOutput): BuildOutput {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  return result;
}

/** Brotli comes out at its best quality, the only one Bun's CompressionStream has. */
function compress(body: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<Uint8Array> {
  const stream = new CompressionStream((encoding === "br" ? "brotli" : "gzip") as CompressionFormat);
  return new Response(new Blob([body]).stream().pipeThrough(stream)).bytes();
}

/**
 * Bun lowers a media query like `(width < 80rem)` to
 * `(max-width: calc(80rem - .001px))`, which Chromium takes to hold at
 * exactly 1280px wide. This puts the range back; every browser the styles
 * work in reads it.
 */
function unlowered(css: string): string {
  return css.replace(/\(max-width:calc\(([\d.]+[a-z]+) - \.001px\)\)/g, "(width<$1)");
}

await Bun.$`rm -rf ${WEB}`;
const web = check(
  await Bun.build({
    entrypoints: ["./src/web/app/index.html"],
    outdir: WEB,
    // The app routes in the browser, so its files come from the root
    // whatever the page.
    publicPath: "/",
    minify: true,
    define,
    plugins: [tailwind, icons, cn],
  }),
);

const files: WebFile[] = [];
for (const output of web.outputs) {
  const name = output.path.slice(output.path.lastIndexOf("/") + 1);
  let body = new Uint8Array(await output.arrayBuffer());
  if (output.type.startsWith("text/css")) {
    body = new TextEncoder().encode(unlowered(new TextDecoder().decode(body)));
    await Bun.write(output.path, body);
  }
  const encodings: Encoding[] = [];
  // Images and fonts are compressed already.
  if (/^(text\/|application\/(javascript|json)|image\/svg)/.test(output.type)) {
    for (const encoding of ["br", "gzip"] as const) {
      const compressed = await compress(body, encoding);
      if (compressed.byteLength >= body.byteLength) continue;
      await Bun.write(`${WEB}/${name}.${encoding}`, compressed);
      encodings.push(encoding);
    }
  }
  files.push({ name, type: output.type, etag: Bun.hash(body).toString(36), encodings });
}

check(
  await Bun.build({
    entrypoints: ["./src/main.ts"],
    compile: {
      outfile: "dist/orianna",
      // Inside, these are drizzle/ and web/.
      assets: ["./drizzle", `./${WEB}`],
    },
    // Parsed and compiled ahead, so the bot starts in under half the time.
    // Bytecode is CommonJS unless told otherwise.
    bytecode: true,
    format: "esm",
    minify: true,
    // src/web/server.ts serves these instead of bundling the app itself.
    define: { ...define, "process.env.ORIANNA_WEB_FILES": JSON.stringify(JSON.stringify(files)) },
    sourcemap: "linked",
  }),
);
