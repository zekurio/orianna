import { defineConfig } from "drizzle-kit";

const DEFAULT_DATABASE = "./data/orianna.db";

// The database the bot opens when run from here: `database` from the config
// file it reads, or its default when there's no file or no key. The bot reads
// its config through src/config.ts. The db:* scripts run drizzle-kit on Bun,
// with `bun --bun`, so this can use Bun's APIs, and drizzle-kit reaches the
// database through Bun's SQLite driver.
async function configuredDatabase(): Promise<string> {
  const file = Bun.file(Bun.env.ORIANNA_CONFIG ?? "config.json");
  if (!(await file.exists())) return DEFAULT_DATABASE;
  const { database } = (await file.json()) as { database?: unknown };
  return typeof database === "string" && database.length > 0 ? database : DEFAULT_DATABASE;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: await configuredDatabase() },
});
