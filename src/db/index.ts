import { Database as SQLite } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer } from "effect";
import { AppConfig } from "../config.ts";
import * as schema from "./schema.ts";

// bun:sqlite answers synchronously, so queries run inline in effects. A query
// that throws is a bug or a broken disk, and ends up as a defect.

// From source, the migrations are at the top of the repository. The compiled
// bot carries them inside, where every module's directory is the root.
const migrationsFolder = join(import.meta.dir, Bun.isStandaloneExecutable ? "drizzle" : "../../drizzle");

/** Opens (or creates) the database and applies pending migrations. */
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const sqlite = new SQLite(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema, casing: "snake_case" });
  migrate(db, { migrationsFolder });
  return db;
}

export type DB = ReturnType<typeof openDatabase>;

export class Database extends Context.Service<Database, DB>()("orianna/Database") {
  /** The database at the config's `database` path, closed when the layer is released. */
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const { database } = yield* AppConfig.current;
      return yield* Effect.acquireRelease(
        Effect.sync(() => openDatabase(database)),
        (db) => Effect.sync(() => db.$client.close()),
      );
    }),
  );
}
