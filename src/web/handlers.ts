import { cdnEmojiURL, type Guild, type GuildChannel, Routes } from "@fluxerjs/core";
import { Cause, Effect, Exit, Layer, Option, Predicate, Ref, Result, Schema } from "effect";
import { Headers } from "effect/http";
import { type Command, formatUsage, isGroup, mayRun, optionHelp, type UserError } from "../commands/command.ts";
import { CommandList } from "../commands/router.ts";
import { type ParsedEmoji, parseEmoji } from "../emoji.ts";
import { Fluxer, type FluxerError, logFailure, request, tagOf } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { Guilds } from "../guilds.ts";
import { SCOREBOARD_SIZE } from "../karma/commands.ts";
import { HOUR, Karma, KarmaGuild } from "../karma/karma.ts";
import { currentKarma, disableKarma, setKarma } from "../karma/manage.ts";
import { millis, tagLogs } from "../log.ts";
import { GuildAccess, PERMISSIONS } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { unicodeEmoji } from "./emoji.ts";
import {
  Authentication,
  CallLog,
  type CommandInfo,
  type CommandSection,
  CurrentMember,
  type EmojiInfo,
  type GuildInfo,
  type KarmaEntry,
  type KarmaOff,
  type KarmaStanding,
  NotMember,
  Refused,
  SettingsRejected,
  SignedOut,
  WebRpcs,
} from "./rpc.ts";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";

// The server side of the calls in rpc.ts. A failure a member should read is
// one of the errors in the schemas. Anything else is logged, and the app only
// learns that something went wrong, without the details. A call about a
// guild runs with that guild's services, like a command in it would.

const PROBLEM = "The bot ran into a problem. Its log says what happened.";

/** As many changes as `!settings log` shows. */
const LOG_SIZE = 30;

/** Logs why `what` failed and hands the app nothing but {@link PROBLEM}. */
const hide =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catchCause(effect, (cause) => logFailure(what)(cause).pipe(Effect.andThen(Effect.die(PROBLEM))));

/** The errors in the schemas, which the member reads. */
type Answer = Refused | SettingsRejected;

/**
 * Answers with a UserError as {@link Refused}, and with the errors from the
 * schemas as they are, for the member to read. Hides everything else.
 */
const answer =
  (what: string) =>
  <A, E extends UserError | FluxerError | Answer, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Extract<E, Answer> | Refused, R> =>
    effect.pipe(
      Effect.map((value) => Result.succeed<A>(value)),
      Effect.catch((err: E) => {
        if (err._tag === "FluxerError") return Effect.fail(err);
        const readable = err._tag === "UserError" ? new Refused({ message: err.message }) : (err as Extract<E, Answer>);
        return Effect.succeed(Result.fail(readable));
      }),
      hide(what),
      Effect.flatMap((result) => (Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))),
    );

/**
 * A server's icon. `Guild.iconURL` always asks for a PNG, which shows an animated icon frozen
 * on its first frame. An `a_` hash marks an animated one, and the CDN serves those as GIFs.
 */
function guildIconUrl(guild: Guild): string | null {
  const url = guild.iconURL({ size: 64 });
  return url && guild.icon?.startsWith("a_") ? url.replace(/\.png(?=\?|$)/, ".gif") : url;
}

/** The guild's channels that take messages, threads aside, in the order the client lists them. */
function textChannels(channels: readonly GuildChannel[]) {
  const position = (c: GuildChannel) => c.position ?? 0;
  const categories = new Map(channels.map((c) => [c.id, position(c)]));
  // Categories first, then channels within them.
  const order = (c: GuildChannel) => [c.parentId ? (categories.get(c.parentId) ?? 0) : -1, position(c)] as const;
  return channels
    .filter((c) => c.isTextBased() && !c.isThread())
    .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
    .map((c) => ({ id: c.id, name: c.name ?? c.id, nsfw: "nsfw" in c && c.nsfw === true }));
}

/** The `guildId` of a call about a guild. */
function guildIdOf(payload: unknown): string | undefined {
  const guildId = (payload as { guildId?: unknown } | null | undefined)?.guildId;
  return typeof guildId === "string" ? guildId : undefined;
}

/**
 * Finds who's signed in by the session cookie, and for a call about a guild,
 * checks they're a member of it.
 */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const guilds = yield* Guilds;

    return (effect, { headers, payload }) =>
      Effect.gen(function* () {
        const cookies = new Bun.CookieMap(Option.getOrElse(Headers.get(headers, "cookie"), () => ""));
        const token = cookies.get(SESSION_COOKIE);
        const userId = token ? yield* sessions.find(token) : undefined;
        if (!userId) return yield* new SignedOut();

        const guildId = guildIdOf(payload);
        if (guildId === undefined) return yield* Effect.provideService(effect, CurrentMember, { userId, guild: undefined });

        if (!(yield* guilds.ids).includes(guildId)) return yield* new NotMember();
        const permissions = yield* guilds.context(guildId).pipe(
          Effect.flatMap((context) =>
            Effect.gen(function* () {
              return yield* (yield* GuildAccess).permissionsOf(userId);
            }).pipe(Effect.provideContext(context)),
          ),
          Effect.catchTag("UserError", () => Effect.succeed(undefined)),
          hide("checking who's signed in"),
        );
        if (!permissions) return yield* new NotMember();
        return yield* Effect.provideService(effect, CurrentMember, {
          userId,
          guild: { id: guildId, admin: permissions.bypass !== null },
        });
      });
  }),
);

/**
 * Logs each call by name, with its guild, what came of it and how long it
 * took. What went wrong in a call that failed is logged where it failed.
 *
 * The RPC server encodes the answer only after this, and an answer that
 * doesn't fit its schema would reach the app as a defect with nothing in the
 * log, so it's checked here, the way the server will encode it, and hidden
 * like any other failure.
 */
export const CallLogLive = Layer.succeed(CallLog, (effect, { rpc, payload }) => {
  const guildId = guildIdOf(payload);
  const call = guildId === undefined ? rpc._tag : `${rpc._tag} in guild ${guildId}`;
  return effect.pipe(
    Effect.tap((answer) => encoderFor(rpc.successSchema)(answer).pipe(hide(`answering ${call}`))),
    Effect.exit,
    Effect.timed,
    Effect.flatMap(([duration, exit]) =>
      Effect.logInfo(`${call}: ${outcomeOf(exit)} in ${millis(duration)}`).pipe(Effect.andThen(exit)),
    ),
    tagLogs("rpc"),
  );
});

const encoders = new WeakMap<Schema.Top, (answer: unknown) => Effect.Effect<unknown, Schema.SchemaError>>();

/** Encodes an answer to JSON as the RPC server does. Our schemas need no services to encode. */
function encoderFor(schema: Schema.Top) {
  let encode = encoders.get(schema);
  if (!encode) {
    encode = Schema.encodeUnknownEffect(Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>));
    encoders.set(schema, encode);
  }
  return encode;
}

/** `ok`, the error the app gets, like `Refused`, or `failed`. */
function outcomeOf(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "ok";
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted";
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  return Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : "failed";
}

export const HandlersLive = WebRpcs.toLayer(
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const guilds = yield* Guilds;
    const commandList = yield* CommandList;
    const emojiUrl = (id: string, animated: boolean) =>
      cdnEmojiURL(id, animated, { mediaBase: client.instance.endpoints.media });
    /** The picture of a custom emoji, null for a Unicode one. */
    const customEmojiUrl = (emoji: ParsedEmoji | undefined) =>
      emoji && /^\d+$/.test(emoji.key) ? emojiUrl(emoji.key, emoji.text.startsWith("<a:")) : null;
    /** The guild's custom emoji, for the emoji pickers. */
    const serverEmojis = (guildId: string) =>
      request("listing emojis", () =>
        client.rest.get<{ id: string; name: string; animated?: boolean }[]>(Routes.guildEmojis(guildId)),
      ).pipe(
        Effect.map((list) =>
          list.map((e) => ({
            text: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
            name: e.name,
            url: emojiUrl(e.id, e.animated === true),
          })),
        ),
      );

    /** Runs a call about a guild with the guild's services. */
    const inGuild = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const { guild } = yield* CurrentMember;
        if (!guild) return yield* Effect.die(new Error("a call about a guild came without its guildId"));
        const context = yield* guilds.context(guild.id).pipe(Effect.orDie);
        return yield* effect.pipe(Effect.provideContext(context));
      });

    /** The member and the guild a call is about. */
    const member = Effect.gen(function* () {
      const { userId, guild } = yield* CurrentMember;
      if (!guild) return yield* Effect.die(new Error("a call about a guild came without its guildId"));
      return { userId, guildId: guild.id, admin: guild.admin };
    });

    /** Refuses members who may not change the bot settings, as `!settings` does. */
    const mayAdmin = Effect.gen(function* () {
      const { userId, admin } = yield* member;
      if (!admin) {
        return yield* new Refused({
          message: "Only the server owner and members with Administrator may change the bot settings.",
        });
      }
      return userId;
    });

    /** Turns settings that don't validate into the problems the app shows next to each field. */
    const rejected = (err: { problems: readonly string[] }) => new SettingsRejected({ problems: [...err.problems] });

    /** Refuses members without `karma.config`. */
    const mayConfigKarma = Effect.gen(function* () {
      const { userId } = yield* member;
      if (!(yield* (yield* GuildAccess).can(userId, "karma.config"))) {
        return yield* new Refused({ message: "Changing karma takes the karma.config permission." });
      }
      return userId;
    });

    /** An emoji from the settings, as the app draws it. */
    const emojiInfo = (text: string): EmojiInfo => {
      const emoji = parseEmoji(text);
      return { emoji: emoji?.text ?? text, url: customEmojiUrl(emoji) };
    };

    /** The guild as the session lists it, when the user is a member of it. */
    const sharedGuild = (userId: string, guildId: string) =>
      guilds.context(guildId).pipe(
        Effect.flatMap((context) => guildInfo(userId, guildId).pipe(Effect.provideContext(context))),
        // Not a member: not one to show.
        Effect.catchTag("UserError", () => Effect.succeed(undefined)),
      );

    const guildInfo = (userId: string, guildId: string) =>
      Effect.gen(function* () {
        const permissions = yield* (yield* GuildAccess).permissionsOf(userId);
        const guild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
        const { prefix } = yield* Settings.current;
        const info: GuildInfo = {
          id: guild.id,
          name: guild.name,
          iconUrl: guildIconUrl(guild),
          admin: permissions.bypass !== null,
          configKarma: permissions.has("karma.config"),
          prefix,
        };
        return info;
      });

    /** Scoreboard rows with the members' names and pictures. Members who left drop out. */
    const named = Effect.fnUntraced(function* (rows: readonly { userId: string; value: number; rank: number }[]) {
      const members = yield* (yield* KarmaGuild).members(rows.map((r) => r.userId));
      return rows.flatMap((row): KarmaEntry[] => {
        const found = members.get(row.userId);
        return found ? [{ ...row, ...found }] : [];
      });
    });

    /** The member's karma in the current guild. Fails with a UserError for a non-member. */
    const standingIn = (userId: string, guildId: string) =>
      Effect.gen(function* () {
        yield* (yield* GuildAccess).permissionsOf(userId);
        const { karma: config } = yield* Settings.current;
        const karma = yield* Karma;
        const fluxerGuild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
        const guild = { id: fluxerGuild.id, name: fluxerGuild.name, iconUrl: guildIconUrl(fluxerGuild) };
        const own = yield* karma.of(userId);
        if (!config) {
          const off: KarmaOff = { guild, own, off: true };
          return off;
        }
        const [ranked] = own === 0 ? [] : yield* karma.ranked({ userIds: [userId] });
        const recent = yield* karma.recentVotes(userId);
        const votesLeft = Math.max(0, config.votesPerHour - recent.length);
        // A vote comes back once enough of the recent ones are an hour old to drop under the limit.
        const freedBy = recent[recent.length - config.votesPerHour];
        const standing: KarmaStanding = {
          guild,
          own,
          rank: ranked?.rank ?? null,
          upvotes: config.upvotes.map(emojiInfo),
          downvotes: config.downvotes.map(emojiInfo),
          votesPerHour: config.votesPerHour,
          votesLeft,
          nextVoteAt: votesLeft === 0 && freedBy ? freedBy.getTime() + HOUR : null,
          blocked: config.blocklist.includes(userId),
          penalty: config.penalty,
        };
        return standing;
      });

    return {
      session: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          const user = yield* request("fetching a user", () => client.users.fetch(userId));
          const shared = yield* Effect.forEach(
            yield* guilds.ids,
            (guildId) =>
              sharedGuild(userId, guildId).pipe(
                Effect.catch((err) =>
                  Effect.logWarning(`guild ${guildId}: couldn't check membership: ${err.message}`).pipe(
                    Effect.as(undefined),
                  ),
                ),
              ),
            { concurrency: 4 },
          );
          return {
            guilds: shared
              .filter((g): g is GuildInfo => g !== undefined)
              .sort((a, b) => a.name.localeCompare(b.name)),
            user: {
              id: user.id,
              name: user.globalName ?? user.username,
              tag: tagOf(user),
              avatarUrl: user.displayAvatarURL({ size: 64 }),
            },
            emojiImages: `${client.instance.endpoints.static_cdn.replace(/\/+$/, "")}/emoji`,
          };
        }).pipe(hide("loading the session")),

      adminSetup: () =>
        inGuild(
          Effect.gen(function* () {
            yield* mayAdmin;
            const { id: guildId } = yield* CurrentGuild;
            const fluxerGuild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
            const roles = yield* request("fetching roles", () => fluxerGuild.fetchRoles());
            const channels = yield* request("listing channels", () => fluxerGuild.fetchChannels());
            return {
              settings: yield* Settings.current,
              channels: textChannels(channels),
              roles: roles
                .filter((r) => r.id !== guildId)
                .sort((a, b) => b.position - a.position)
                .map(({ id, name, color }) => ({ id, name, color })),
              emojis: yield* serverEmojis(guildId),
              permissions: [...PERMISSIONS],
            };
          }),
        ).pipe(answer("loading the bot settings")),

      saveSettings: ({ sections }) =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayAdmin;
            return yield* (yield* Settings)
              .update((current) => {
                const next: Record<string, unknown> = { ...current };
                for (const [key, value] of Object.entries(sections)) {
                  if (value === null) delete next[key];
                  else next[key] = value;
                }
                return Effect.succeed(next);
              }, userId)
              .pipe(Effect.catchTag("InvalidSettings", (err) => Effect.fail(rejected(err))));
          }),
        ).pipe(answer("saving the bot settings")),

      importSettings: ({ document }) =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayAdmin;
            return yield* (yield* Settings).replace(document, userId).pipe(Effect.catchTag("InvalidSettings", (err) => Effect.fail(rejected(err))));
          }),
        ).pipe(answer("importing the bot settings")),

      settingsLog: () =>
        inGuild(
          Effect.gen(function* () {
            yield* mayAdmin;
            const changes = yield* (yield* Settings).history(LOG_SIZE);
            const names = new Map<string, string>();
            yield* Effect.forEach(
              new Set(changes.flatMap((c) => (c.changedBy ? [c.changedBy] : []))),
              (id) =>
                request("fetching a user", () => client.users.fetch(id)).pipe(
                  Effect.map((user) => {
                    names.set(id, user.globalName ?? user.username);
                  }),
                  Effect.ignore,
                ),
              { concurrency: 4, discard: true },
            );
            return changes.map((c) => ({
              at: c.changedAt.getTime(),
              by: c.changedBy ? { id: c.changedBy, name: names.get(c.changedBy) ?? null } : null,
              source: c.source,
              sections: c.sections,
            }));
          }),
        ).pipe(answer("loading the settings log")),

      commands: () =>
        inGuild(
          Effect.gen(function* () {
            const { userId, guildId } = yield* member;
            const permissions = yield* (yield* GuildAccess).permissionsOf(userId);
            const info = (path: string, c: Command): CommandInfo => ({
              name: path,
              description: c.description,
              details: c.details ?? null,
              usage: formatUsage(c.options),
              options: optionHelp(c.options),
              permission: c.permission ?? null,
              adminOnly: c.adminOnly === true,
            });
            const general: CommandInfo[] = [];
            // By title. A group and the commands that name it as their section share one.
            const features = new Map<string, CommandInfo[]>();
            const feature = (title: string) => {
              let commands = features.get(title);
              if (!commands) features.set(title, (commands = []));
              return commands;
            };
            const entries = (yield* Ref.get(commandList)).get(guildId) ?? new Map();
            for (const entry of entries.values()) {
              if (!isGroup(entry)) {
                if (!mayRun(entry, permissions)) continue;
                (entry.section === undefined ? general : feature(entry.section)).push(info(entry.name, entry));
                continue;
              }
              const commands = [
                ...(entry.default && mayRun(entry.default, permissions) ? [info(entry.name, entry.default)] : []),
                ...entry.subcommands.filter((c) => mayRun(c, permissions)).map((c) => info(`${entry.name} ${c.name}`, c)),
              ];
              if (commands.length === 0) continue;
              feature(entry.name[0]!.toUpperCase() + entry.name.slice(1)).push(...commands);
            }
            // General first, then the features by name, then the ones only admins
            // may run anything in, like the settings.
            const adminOnly = (s: { commands: readonly CommandInfo[] }) => s.commands.every((c) => c.adminOnly);
            const sections: CommandSection[] = [...features]
              .map(([title, commands]) => ({ title, commands }))
              .sort((a, b) => Number(adminOnly(a)) - Number(adminOnly(b)) || a.title.localeCompare(b.title));
            return [{ title: "General", commands: general }, ...sections].filter(
              (s) => s.commands.length > 0,
            );
          }),
        ).pipe(hide("listing the commands")),

      unicodeEmoji: () => Effect.sync(unicodeEmoji).pipe(hide("listing the emoji")),

      karma: () =>
        inGuild(
          Effect.gen(function* () {
            if (!(yield* Settings.current).karma) return null;
            return { top: yield* named(yield* (yield* Karma).ranked({ limit: SCOREBOARD_SIZE })) };
          }),
        ).pipe(hide("loading karma")),

      karmaSearch: ({ query }) =>
        inGuild(
          Effect.gen(function* () {
            const trimmed = query.trim();
            if (!trimmed || !(yield* Settings.current).karma) return [];
            const userIds = yield* (yield* KarmaGuild).search(trimmed);
            return yield* named(yield* (yield* Karma).ranked({ userIds }));
          }),
        ).pipe(hide("searching karma")),

      myKarma: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          const standings = yield* Effect.forEach(
            yield* guilds.ids,
            (guildId) =>
              guilds.context(guildId).pipe(
                Effect.flatMap((context) => standingIn(userId, guildId).pipe(Effect.provideContext(context))),
                // Not a member: not one to show.
                Effect.catchTag("UserError", () => Effect.succeed(undefined)),
                Effect.catch((err) =>
                  Effect.logWarning(`guild ${guildId}: couldn't load karma: ${err.message}`).pipe(Effect.as(undefined)),
                ),
              ),
            { concurrency: 4 },
          );
          return standings
            .filter((s): s is KarmaStanding | KarmaOff => s !== undefined)
            .sort((a, b) => a.guild.name.localeCompare(b.guild.name));
        }).pipe(hide("loading your karma")),

      karmaSetup: () =>
        inGuild(
          Effect.gen(function* () {
            yield* mayConfigKarma;
            const { id: guildId } = yield* CurrentGuild;
            const fluxerGuild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
            const roles = yield* request("fetching roles", () => fluxerGuild.fetchRoles());
            const config = yield* currentKarma;
            const blocked = yield* (yield* KarmaGuild).members(config.blocklist);
            return {
              on: (yield* Settings.current).karma !== undefined,
              config,
              blocked: Object.fromEntries([...blocked].map(([id, { name }]) => [id, name])),
              roles: roles
                .filter((r) => r.id !== guildId)
                .sort((a, b) => b.position - a.position)
                .map(({ id, name }) => ({ id, name })),
              emojis: yield* serverEmojis(guildId),
            };
          }),
        ).pipe(answer("loading the karma settings")),

      setKarma: ({ karma }) =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayConfigKarma;
            yield* setKarma(karma, userId).pipe(Effect.catchTag("InvalidSettings", (err) => Effect.fail(rejected(err))));
          }),
        ).pipe(answer("setting karma")),

      disableKarma: () =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayConfigKarma;
            yield* disableKarma(userId);
          }),
        ).pipe(answer("disabling karma")),
    };
  }),
);
