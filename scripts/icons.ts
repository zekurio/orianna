import type { BunPlugin } from "bun";

// Each Phosphor icon carries its paths in all six weights, though the app
// draws icons bold and fills the current tab's (src/web/app/main.tsx and
// Header.tsx). This drops the other four from the bundle, a little over half
// of what the icons weigh. An icon asked for in another weight comes out
// empty, in development too, since bunfig.toml loads this for `bun --watch`.

/** The weights the app uses. */
const WEIGHTS = new Set(["bold", "fill"]);
const ALL = ["bold", "duotone", "fill", "light", "regular", "thin"];

/** One `["weight", <paths>]` entry of the Map each icon's file exports. */
const ENTRY = /^ {2}\[\n {4}"(\w+)",\n[\s\S]*?\n {2}\],?$/gm;

const icons: BunPlugin = {
  name: "phosphor-weights",
  setup(build) {
    build.onLoad({ filter: /@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]\w+\.es\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const found: string[] = [];
      const kept: string[] = [];
      for (const [entry, weight] of source.matchAll(ENTRY)) {
        found.push(weight!);
        if (WEIGHTS.has(weight!)) kept.push(entry.replace(/,$/, ""));
      }
      // A new layout in a Phosphor update shouldn't quietly empty every icon.
      if (found.join() !== ALL.join()) throw new Error(`${path}: can't find the icon's weights`);
      const start = source.indexOf("new Map([") + "new Map([".length;
      const end = source.lastIndexOf("]);");
      return { contents: `${source.slice(0, start)}\n${kept.join(",\n")}\n${source.slice(end)}`, loader: "js" };
    });
  },
};

export default icons;
