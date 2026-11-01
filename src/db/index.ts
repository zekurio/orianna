import { Database as SQLite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { AppConfig } from "../config.ts";
import * as schema from "./schema.ts";

// bun:sqlite answers synchronously, so queries run inline in effects. A query
// that throws is a bug or a broken disk, and ends up as a defect.

/** Opens (or creates) the database and applies pending migrations. */
function openDatabase(file: string, migrationsFolder: string) {
  const sqlite = new SQLite(file, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema, casing: "snake_case" });
  migrate(db, { migrationsFolder });
  return db;
}

export type DB = ReturnType<typeof openDatabase>;
export type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

export class Database extends Context.Service<Database, DB>()("orianna/Database") {
  /**
   * The database at the config's `database` path, created and brought up to
   * date when it opens, and closed when the layer is released.
   */
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const { database } = yield* AppConfig.current;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // bun:sqlite creates the file, but not the directories it goes in.
      if (database !== ":memory:") {
        yield* fs.makeDirectory(path.dirname(database), { recursive: true }).pipe(Effect.orDie);
      }
      // From source, the migrations are at the top of the repository. The
      // compiled bot carries them inside, where every module's directory is
      // the root.
      const migrations = path.join(import.meta.dir, Bun.isStandaloneExecutable ? "drizzle" : "../../drizzle");
      return yield* Effect.acquireRelease(
        Effect.sync(() => openDatabase(database, migrations)),
        (db) => Effect.sync(() => db.$client.close()),
      );
    }),
  );
}
