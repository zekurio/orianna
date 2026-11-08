import type { BunPlugin } from "bun";
import { build } from "cn/build";

// `cn` merges class names with tables for every Tailwind utility there is.
// The app's own classes need about a third of them, and `cn build` compiles
// just those from the app's sources and theme. Only the compiled bot gets the
// fitted tables: running from source, a class added since the bot started
// would be missing from them until a restart.

const root = `${import.meta.dir}/..`;

const fitted: BunPlugin = {
  name: "cn-tables",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]cn[\\/]dist[\\/]tables\.js$/ }, async () => {
      const { source } = await build({
        cwd: root,
        content: ["src/web/app/**/*.{ts,tsx}"],
        css: "src/web/app/styles.css",
        // build() writes the tables out as well; this keeps them with the build.
        out: "dist/cn-tables.mjs",
      });
      return { contents: source, loader: "js" };
    });
  },
};

export default fitted;
