import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

const DEFAULT_DATABASE = "./data/orianna.db";

// The database the bot opens when run from here: `database` from the config
// file it reads, or its default when there's no file or no key. The bot reads
// its config through src/config.ts. drizzle-kit loads this file with
// require(), which can't wait on Bun.file, and Bun has no synchronous reads of
// its own, so this is the one place left that uses node:fs.
function configuredDatabase(): string {
  const path = process.env.ORIANNA_CONFIG ?? "config.json";
  if (!existsSync(path)) return DEFAULT_DATABASE;
  const { database } = JSON.parse(readFileSync(path, "utf8")) as { database?: unknown };
  return typeof database === "string" && database.length > 0 ? database : DEFAULT_DATABASE;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: configuredDatabase() },
});
