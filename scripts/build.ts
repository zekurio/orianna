import tailwind from "bun-plugin-tailwind";

// `bun run build`: the bot, the web interface and the migrations in one
// executable, dist/orianna. The `bun build` CLI can't load plugins yet, and
// the web interface's styles need Tailwind's, so the build runs from here.

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  compile: { outfile: "dist/orianna", assets: ["./drizzle"] },
  // What --production does.
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  sourcemap: "linked",
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
