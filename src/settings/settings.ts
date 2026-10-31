import { desc, eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Semaphore, type Stream, SubscriptionRef } from "effect";
import {
  AppConfig,
  type BotSettings,
  ConfigError,
  type InvalidSettings,
  parseSettings,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../config.ts";
import { Database, type DB, type Transaction } from "../db/index.ts";
import { settings, settingsChanges } from "../db/schema.ts";

// The bot settings live in the database so they can change while the bot
// runs. On the first start they are the defaults. Every change is recorded
// with who made it.

export type SettingsChange = typeof settingsChanges.$inferSelect;
type Source = SettingsChange["source"];

/** The bot settings, as they are now and as they change. */
export class Settings extends Context.Service<
  Settings,
  {
    /** The settings as they are now. They change while the bot runs, so read them when you need them. */
    readonly get: Effect.Effect<BotSettings>;
    /** The settings as they are now, then each change. */
    readonly changes: Stream.Stream<BotSettings>;
    /**
     * Validates `raw` and makes it the settings, recording `userId` as the one
     * who changed them. Returns the sections that changed; with none, nothing
     * is stored or recorded.
     */
    readonly replace: (raw: unknown, userId: string) => Effect.Effect<SettingsSection[], InvalidSettings>;
    /**
     * Like {@link replace}, with the new settings worked out from the current
     * ones while no other change can come between. `alongside` runs in the
     * transaction that stores them, for rows that have to change with them;
     * it doesn't run when nothing changed.
     */
    readonly update: <E>(
      change: (current: BotSettings) => Effect.Effect<unknown, E>,
      userId: string,
      alongside?: (tx: Transaction) => void,
    ) => Effect.Effect<SettingsSection[], InvalidSettings | E>;
    /** The latest changes, newest first. */
    readonly history: (limit: number) => Effect.Effect<SettingsChange[]>;
  }
>()("orianna/Settings") {
  /**
   * Loads the settings from the database. When it has none yet, stores the
   * defaults.
   */
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const db = yield* Database;
      const config = yield* AppConfig.current;
      const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms)));

      const row = db.select().from(settings).where(eq(settings.id, 1)).get();
      let current: BotSettings;
      if (row) {
        current = yield* parseSettings(row.document, config.guildId).pipe(
          Effect.mapError(
            (err) => new ConfigError({ message: `the bot settings in the database are invalid:\n${err.message}` }),
          ),
        );
      } else {
        current = yield* parseSettings({}, config.guildId).pipe(Effect.orDie);
        store(db, current, { at: yield* now, by: null, source: "defaults", before: null, sections: SETTINGS_SECTIONS });
        yield* Effect.logInfo(`stored the default bot settings; edit them with ${current.prefix}settings`);
      }

      const ref = yield* SubscriptionRef.make(current);
      // One change at a time, so each is compared with the one before it.
      const lock = yield* Semaphore.make(1);

      const update = <E>(
        change: (current: BotSettings) => Effect.Effect<unknown, E>,
        userId: string,
        alongside?: (tx: Transaction) => void,
      ) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const before = yield* SubscriptionRef.get(ref);
            const next = yield* parseSettings(yield* change(before), config.guildId);
            const sections = SETTINGS_SECTIONS.filter((key) => !Bun.deepEquals(before[key], next[key]));
            if (sections.length === 0) return sections;
            store(db, next, { at: yield* now, by: userId, source: "command", before, sections }, alongside);
            yield* SubscriptionRef.set(ref, next);
            return sections;
          }),
        );

      return {
        get: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref),
        replace: (raw, userId) => update(() => Effect.succeed(raw), userId),
        update,
        history: (limit) =>
          Effect.sync(() => db.select().from(settingsChanges).orderBy(desc(settingsChanges.id)).limit(limit).all()),
      };
    }),
  );

  static readonly current: Effect.Effect<BotSettings, never, Settings> = Effect.gen(function* () {
    return yield* (yield* Settings).get;
  });
}

interface Change {
  at: Date;
  by: string | null;
  source: Source;
  /** Null for the first settings. */
  before: BotSettings | null;
  sections: readonly SettingsSection[];
}

/** Writes the settings and records the change, together with `alongside`. */
function store(db: DB, next: BotSettings, change: Change, alongside?: (tx: Transaction) => void) {
  const pick = (from: BotSettings) => Object.fromEntries(change.sections.map((key) => [key, from[key] ?? null]));
  db.transaction((tx) => {
    tx.insert(settings)
      .values({ id: 1, document: next, updatedAt: change.at })
      .onConflictDoUpdate({ target: settings.id, set: { document: next, updatedAt: change.at } })
      .run();
    tx.insert(settingsChanges)
      .values({
        changedAt: change.at,
        changedBy: change.by,
        source: change.source,
        sections: [...change.sections],
        before: change.before && pick(change.before),
        after: pick(next),
      })
      .run();
    alongside?.(tx);
  });
}
