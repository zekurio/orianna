import { cdnEmojiURL } from "@fluxerjs/core";
import { Effect, Layer, Option, Ref, Result } from "effect";
import { Headers } from "effect/http";
import { type Command, formatUsage, isGroup, mayRun, type UserError } from "../commands/command.ts";
import { CommandList } from "../commands/router.ts";
import { Database } from "../db/index.ts";
import { type ParsedEmoji, parseEmoji } from "../emoji.ts";
import { Fluxer, type FluxerError, logFailure, request, tagOf } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { Guilds } from "../guilds.ts";
import { GuildAccess, PERMISSIONS } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { currentStarboard, disableStarboard, setStarboard } from "../starboard/manage.ts";
import { optedOut, optIn, optOut } from "../starboard/optout.ts";
import { LiveStarboard, StarboardGuild } from "../starboard/starboard.ts";
import { unicodeEmoji } from "./emoji.ts";
import {
  Authentication,
  type CommandInfo,
  type CommandSection,
  CurrentMember,
  type GuildInfo,
  type Names,
  NotMember,
  Refused,
  SettingsRejected,
  SignedOut,
  STARBOARD_PAGE_SIZE,
  type StarboardEntry,
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

/** Mentions in message text, by kind. */
const USER_MENTION = /<@!?(\d+)>/g;
const CHANNEL_MENTION = /<#(\d+)>/g;
const CUSTOM_EMOJI = /<(a?):\w+:(\d+)>/g;

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

export const HandlersLive = WebRpcs.toLayer(
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const guilds = yield* Guilds;
    const commandList = yield* CommandList;
    // The starboard opt-out holds in every guild.
    const everywhere = yield* Effect.context<Guilds | Database>();
    const emojiUrl = (id: string, animated: boolean) =>
      cdnEmojiURL(id, animated, { mediaBase: client.instance.endpoints.media });
    /** The picture of a custom emoji, null for a Unicode one. */
    const customEmojiUrl = (emoji: ParsedEmoji | undefined) =>
      emoji && /^\d+$/.test(emoji.key) ? emojiUrl(emoji.key, emoji.text.startsWith("<a:")) : null;
    const serverEmojis = (emojis: readonly { id: string; name: string; animated: boolean }[]) =>
      emojis.map((e) => ({
        text: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
        name: e.name,
        url: emojiUrl(e.id, e.animated),
      }));

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

    /** The guild's starboard, while it's on and the member can see its channel. */
    const visibleStarboard = Effect.gen(function* () {
      const { userId } = yield* member;
      const starboard = yield* LiveStarboard.current;
      const board = starboard.board;
      if (!board || !(yield* (yield* GuildAccess).canView(userId, board.channelId))) return undefined;
      return { starboard, board };
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

    /** Refuses members without `starboard.config`. */
    const mayConfig = Effect.gen(function* () {
      const { userId } = yield* member;
      if (!(yield* (yield* GuildAccess).can(userId, "starboard.config"))) {
        return yield* new Refused({ message: "Changing the starboard takes the starboard.config permission." });
      }
      return userId;
    });

    /** The names the entries' mentions show, of channels the member can see. */
    const namesFor = Effect.fnUntraced(function* (texts: readonly string[], channelIds: readonly string[]) {
      const { userId } = yield* member;
      const access = yield* GuildAccess;
      const guild = yield* StarboardGuild;
      const all = texts.join("\n");
      const userIds = new Set([...all.matchAll(USER_MENTION)].map((m) => m[1]!));
      const mentioned = new Set([...channelIds, ...[...all.matchAll(CHANNEL_MENTION)].map((m) => m[1]!)]);
      const names: Record<keyof Names, Record<string, string>> = { users: {}, channels: {}, emojis: {} };
      for (const [, animated, id] of all.matchAll(CUSTOM_EMOJI)) {
        names.emojis[id!] = emojiUrl(id!, animated === "a");
      }
      yield* Effect.forEach(
        userIds,
        (id) =>
          request("fetching a user", () => client.users.fetch(id)).pipe(
            Effect.map((user) => {
              names.users[id] = user.globalName ?? user.username;
            }),
            Effect.ignore,
          ),
        { concurrency: 4, discard: true },
      );
      yield* Effect.forEach(
        mentioned,
        (id) =>
          Effect.gen(function* () {
            if (!(yield* access.canView(userId, id))) return;
            const channel = yield* guild.channel(id);
            if (channel) names.channels[id] = channel.name;
          }).pipe(Effect.ignore),
        { concurrency: 4, discard: true },
      );
      const result: Names = names;
      return result;
    });

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
          iconUrl: guild.iconURL({ size: 64 }),
          admin: permissions.bypass !== null,
          configStarboard: permissions.has("starboard.config"),
          prefix,
        };
        return info;
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
            const guild = yield* StarboardGuild;
            const fluxerGuild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
            const roles = yield* request("fetching roles", () => fluxerGuild.fetchRoles());
            const channels = yield* guild.textChannels;
            return {
              settings: yield* Settings.current,
              channels: channels.map(({ id, name, nsfw }) => ({ id, name, nsfw })),
              roles: roles
                .filter((r) => r.id !== guildId)
                .sort((a, b) => b.position - a.position)
                .map(({ id, name, color }) => ({ id, name, color })),
              emojis: serverEmojis(yield* guild.emojis),
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
              .pipe(Effect.mapError(rejected));
          }),
        ).pipe(answer("saving the bot settings")),

      importSettings: ({ document }) =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayAdmin;
            return yield* (yield* Settings).replace(document, userId).pipe(Effect.mapError(rejected));
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
              usage: formatUsage(c.options),
              options: (c.options ?? []).map((o) => ({
                name: o.name,
                description: o.description,
                usage: formatUsage([o]),
              })),
              permission: c.permission ?? null,
              adminOnly: c.adminOnly === true,
            });
            const standalone: CommandInfo[] = [];
            const groups: CommandSection[] = [];
            const entries = (yield* Ref.get(commandList)).get(guildId) ?? new Map();
            for (const entry of entries.values()) {
              if (!isGroup(entry)) {
                if (mayRun(entry, permissions)) standalone.push(info(entry.name, entry));
                continue;
              }
              const commands = entry.subcommands
                .filter((c) => mayRun(c, permissions))
                .map((c) => info(`${entry.name} ${c.name}`, c));
              if (commands.length > 0) groups.push({ group: entry.name, description: entry.description, commands });
            }
            return [{ group: null, description: null, commands: standalone }, ...groups].filter(
              (s) => s.commands.length > 0,
            );
          }),
        ).pipe(hide("listing the commands")),

      starboard: () =>
        inGuild(
          Effect.gen(function* () {
            const visible = yield* visibleStarboard;
            if (!visible) return null;
            const { board } = visible;
            const channel = yield* (yield* StarboardGuild).channel(board.channelId);
            return {
              emoji: board.emoji.text,
              emojiUrl: customEmojiUrl(board.emoji),
              channelId: board.channelId,
              channelName: channel?.name ?? "deleted-channel",
              threshold: board.threshold,
              nsfw: channel?.nsfw ?? false,
            };
          }),
        ).pipe(hide("loading the starboard")),

      starboardEntries: ({ sort, offset }) =>
        inGuild(
          Effect.gen(function* () {
            const visible = yield* visibleStarboard;
            if (!visible) return { entries: [], total: 0, names: { users: {}, channels: {}, emojis: {} } };
            const guild = yield* StarboardGuild;
            const { rows, total } = yield* visible.starboard.posts(sort, offset, STARBOARD_PAGE_SIZE);
            const entries = rows.map(
              (row): StarboardEntry => ({
                messageId: row.messageId,
                channelId: row.channelId,
                authorId: row.authorId,
                authorName: row.authorName,
                authorAvatar: row.authorAvatar,
                content: row.content,
                media: row.media ?? [],
                score: row.count,
                messageUrl: guild.messageLink(row.channelId, row.messageId),
              }),
            );
            const names = yield* namesFor(
              rows.map((r) => r.content ?? ""),
              rows.map((r) => r.channelId),
            );
            return { entries, total, names };
          }),
        ).pipe(hide("loading the starboard entries")),

      unicodeEmoji: () => Effect.sync(unicodeEmoji).pipe(hide("listing the emoji")),

      starboardOptOut: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          return yield* optedOut(userId).pipe(Effect.provideContext(everywhere));
        }).pipe(hide("loading the starboard opt-out")),

      setStarboardOptOut: ({ optedOut: next }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          if (next) return yield* optOut(userId).pipe(Effect.provideContext(everywhere));
          yield* optIn(userId).pipe(Effect.provideContext(everywhere));
          return 0;
        }).pipe(hide("changing the starboard opt-out")),

      starboardSetup: () =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayConfig;
            const guild = yield* StarboardGuild;
            const config = yield* currentStarboard;
            const channels = yield* guild.textChannels;
            const visible = new Set(yield* (yield* GuildAccess).visibleChannels(userId, channels.map((c) => c.id)));
            const emoji = parseEmoji(config.emoji);
            return {
              config: {
                channelId: config.channelId ?? null,
                threshold: config.threshold,
                emoji: emoji?.text ?? config.emoji,
                emojiUrl: customEmojiUrl(emoji),
              },
              channels: channels.filter((c) => visible.has(c.id)).map(({ id, name, nsfw }) => ({ id, name, nsfw })),
              emojis: serverEmojis(yield* guild.emojis),
            };
          }),
        ).pipe(answer("loading the starboard settings")),

      setStarboard: ({ starboard }) =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayConfig;
            yield* setStarboard(starboard, userId);
          }),
        ).pipe(answer("setting the starboard")),

      disableStarboard: () =>
        inGuild(
          Effect.gen(function* () {
            const userId = yield* mayConfig;
            yield* disableStarboard(userId);
          }),
        ).pipe(answer("disabling the starboard")),
    };
  }),
);
