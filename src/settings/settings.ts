import { desc, eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Semaphore, type Stream, SubscriptionRef } from "effect";
import {
  type BotSettings,
  ConfigError,
  InvalidSettings,
  parseSettings,
  SETTINGS_SECTIONS,
  type SettingsSection,
  settingsChannels,
} from "../config.ts";
import { Database, type DB, type Transaction } from "../db/index.ts";
import { settings, settingsChanges } from "../db/schema.ts";
import type { FluxerError } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";

// The bot settings live in the database so they can change while the bot
// runs. Each guild has its own, the defaults until someone changes them.
// Every change is recorded with who made it.

export type SettingsChange = typeof settingsChanges.$inferSelect;
type Source = SettingsChange["source"];

/** What the settings need from the guild: the channels they have the bot post in. */
export class SettingsGuild extends Context.Service<
  SettingsGuild,
  {
    /** Null when the guild has no such channel. */
    readonly channel: (channelId: string) => Effect.Effect<{ readonly text: boolean } | null, FluxerError>;
  }
>()("orianna/SettingsGuild") {}

/** The bot settings of the current guild, as they are now and as they change. */
export class Settings extends Context.Service<
  Settings,
  {
    /** The settings as they are now. They change while the bot runs, so read them when you need them. */
    readonly get: Effect.Effect<BotSettings>;
    /** The settings as they are now, then each change. */
    readonly changes: Stream.Stream<BotSettings>;
    /**
     * Validates `raw`, checks the channels it names against the guild, and
     * makes it the settings, recording `userId` as the one who changed them.
     * Returns the sections that changed; with none, nothing is stored or
     * recorded.
     */
    readonly replace: (raw: unknown, userId: string) => Effect.Effect<SettingsSection[], InvalidSettings | FluxerError>;
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
    ) => Effect.Effect<SettingsSection[], InvalidSettings | FluxerError | E>;
    /** The latest changes, newest first. */
    readonly history: (limit: number) => Effect.Effect<SettingsChange[]>;
  }
>()("orianna/Settings") {
  /** The current guild's settings, from the {@link SettingsStore}, with changes checked against the guild. */
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const { id } = yield* CurrentGuild;
      const stored = yield* (yield* SettingsStore).forGuild(id);
      const guild = yield* SettingsGuild;
      const update: Settings["Service"]["update"] = (change, userId, alongside) =>
        stored.update(
          (current) => change(current).pipe(Effect.tap((raw) => checkChannels(guild, id, raw, current))),
          userId,
          alongside,
        );
      return { ...stored, update, replace: (raw, userId) => update(() => Effect.succeed(raw), userId) };
    }),
  );

  static readonly current: Effect.Effect<BotSettings, never, Settings> = Effect.gen(function* () {
    return yield* (yield* Settings).get;
  });
}

/**
 * Checks the channels `raw` has the bot post in that `before` didn't. They
 * have to be the guild's own, or an admin could have the bot post in another
 * guild it's in, and take messages.
 */
const checkChannels = Effect.fnUntraced(function* (
  guild: SettingsGuild["Service"],
  guildId: string,
  raw: unknown,
  before: BotSettings,
) {
  const next = yield* parseSettings(raw, guildId);
  const known = new Set(settingsChannels(before).map((c) => c.channelId));
  const problems: string[] = [];
  for (const { path, channelId } of settingsChannels(next)) {
    if (known.has(channelId)) continue;
    const channel = yield* guild.channel(channelId);
    if (!channel) problems.push(`${path}: there's no channel ${channelId} in this server`);
    else if (!channel.text) problems.push(`${path}: channel ${channelId} doesn't take messages`);
  }
  if (problems.length > 0) return yield* new InvalidSettings({ problems });
});

/** Every guild's settings, loaded when first needed and kept while the bot runs. */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    /**
     * The guild's settings. A guild without any gets the defaults, stored
     * right away. Fails when the stored ones don't validate anymore. Changes
     * through these aren't checked against the guild; {@link Settings} does that.
     */
    readonly forGuild: (guildId: string) => Effect.Effect<Settings["Service"], ConfigError>;
  }
>()("orianna/SettingsStore") {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const db = yield* Database;
      const loaded = new Map<string, Settings["Service"]>();
      // One guild at a time, so a guild's settings are only loaded once.
      const lock = yield* Semaphore.make(1);
      return {
        forGuild: (guildId) =>
          lock.withPermits(1)(
            Effect.suspend(() => {
              const known = loaded.get(guildId);
              if (known) return Effect.succeed(known);
              return loadSettings(db, guildId).pipe(Effect.tap((s) => Effect.sync(() => loaded.set(guildId, s))));
            }),
          ),
      };
    }),
  );
}

/** Loads a guild's settings from the database, or stores the defaults when it has none. */
const loadSettings = Effect.fnUntraced(function* (db: DB, guildId: string) {
  const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms)));
  const row = db.select().from(settings).where(eq(settings.guildId, guildId)).get();
  let current: BotSettings;
  if (row) {
    current = yield* parseSettings(row.document, guildId).pipe(
      Effect.mapError(
        (err) =>
          new ConfigError({ message: `the bot settings of guild ${guildId} in the database are invalid:\n${err.message}` }),
      ),
    );
  } else {
    current = yield* parseSettings({}, guildId).pipe(Effect.orDie);
    store(db, guildId, current, {
      at: yield* now,
      by: null,
      source: "defaults",
      before: null,
      sections: SETTINGS_SECTIONS,
    });
    yield* Effect.logInfo(`guild ${guildId}: stored the default bot settings`);
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
        const next = yield* parseSettings(yield* change(before), guildId);
        const sections = SETTINGS_SECTIONS.filter((key) => !Bun.deepEquals(before[key], next[key]));
        if (sections.length === 0) return sections;
        store(db, guildId, next, { at: yield* now, by: userId, source: "command", before, sections }, alongside);
        yield* SubscriptionRef.set(ref, next);
        return sections;
      }),
    );

  const service: Settings["Service"] = {
    get: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    replace: (raw, userId) => update(() => Effect.succeed(raw), userId),
    update,
    history: (limit) =>
      Effect.sync(() =>
        db
          .select()
          .from(settingsChanges)
          .where(eq(settingsChanges.guildId, guildId))
          .orderBy(desc(settingsChanges.id))
          .limit(limit)
          .all(),
      ),
  };
  return service;
});

interface Change {
  at: Date;
  by: string | null;
  source: Source;
  /** Null for the first settings. */
  before: BotSettings | null;
  sections: readonly SettingsSection[];
}

/** Writes the guild's settings and records the change, together with `alongside`. */
function store(db: DB, guildId: string, next: BotSettings, change: Change, alongside?: (tx: Transaction) => void) {
  const pick = (from: BotSettings) => Object.fromEntries(change.sections.map((key) => [key, from[key] ?? null]));
  db.transaction((tx) => {
    tx.insert(settings)
      .values({ guildId, document: next, updatedAt: change.at })
      .onConflictDoUpdate({ target: settings.guildId, set: { document: next, updatedAt: change.at } })
      .run();
    tx.insert(settingsChanges)
      .values({
        guildId,
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
