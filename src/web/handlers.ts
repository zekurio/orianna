import { cdnEmojiURL } from "@fluxerjs/core";
import { Effect, Layer, Option, Result } from "effect";
import { Headers } from "effect/http";
import type { UserError } from "../commands/command.ts";
import { type ParsedEmoji, parseEmoji } from "../emoji.ts";
import { Fluxer, type FluxerError, logFailure, request } from "../fluxer.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { currentStarboard, disableStarboard, setStarboard } from "../starboard/manage.ts";
import { LiveStarboard, StarboardGuild } from "../starboard/starboard.ts";
import { unicodeEmoji } from "./emoji.ts";
import {
  Authentication,
  CurrentMember,
  type Names,
  NotMember,
  Refused,
  STARBOARD_PAGE_SIZE,
  SignedOut,
  type StarboardEntry,
  WebRpcs,
} from "./rpc.ts";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";

// The server side of the calls in rpc.ts. A failure a member should read is
// one of the errors in the schemas. Anything else is logged, and the app only
// learns that something went wrong, without the details.

const PROBLEM = "The bot ran into a problem. Its log says what happened.";

/** Logs why `what` failed and hands the app nothing but {@link PROBLEM}. */
const hide =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catchCause(effect, (cause) => logFailure(what)(cause).pipe(Effect.andThen(Effect.die(PROBLEM))));

/**
 * Answers with a UserError as {@link Refused}, for the member to read, and
 * hides everything else.
 */
const answer =
  (what: string) =>
  <A, R>(effect: Effect.Effect<A, UserError | FluxerError | Refused, R>): Effect.Effect<A, Refused, R> =>
    effect.pipe(
      Effect.map((value) => Result.succeed(value)),
      Effect.catchTag("UserError", (err) => Effect.succeed(Result.fail(new Refused({ message: err.message })))),
      Effect.catchTag("Refused", (err) => Effect.succeed(Result.fail(err))),
      hide(what),
      Effect.flatMap((result) => (Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))),
    );

/** Mentions in message text, by kind. */
const USER_MENTION = /<@!?(\d+)>/g;
const CHANNEL_MENTION = /<#(\d+)>/g;
const CUSTOM_EMOJI = /<(a?):\w+:(\d+)>/g;

/** Finds the member by the session cookie, and checks they're still in the guild. */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const access = yield* GuildAccess;

    return (effect, { headers }) =>
      Effect.gen(function* () {
        const cookies = new Bun.CookieMap(Option.getOrElse(Headers.get(headers, "cookie"), () => ""));
        const token = cookies.get(SESSION_COOKIE);
        const userId = token ? yield* sessions.find(token) : undefined;
        if (!userId) return yield* new SignedOut();

        const permissions = yield* access.permissionsOf(userId).pipe(
          Effect.catchTag("UserError", () => Effect.succeed(undefined)),
          hide("checking who's signed in"),
        );
        if (!permissions) return yield* new NotMember();
        return yield* Effect.provideService(effect, CurrentMember, {
          userId,
          admin: permissions.bypass !== null,
        });
      });
  }),
);

export const HandlersLive = WebRpcs.toLayer(
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const settings = yield* Settings;
    const access = yield* GuildAccess;
    const guild = yield* StarboardGuild;
    const live = yield* LiveStarboard;
    const starboardNow = LiveStarboard.current.pipe(
      Effect.provideService(LiveStarboard, live),
      Effect.provideService(Settings, settings),
    );
    const emojiUrl = (id: string, animated: boolean) =>
      cdnEmojiURL(id, animated, { mediaBase: client.instance.endpoints.media });
    /** The picture of a custom emoji, null for a Unicode one. */
    const customEmojiUrl = (emoji: ParsedEmoji | undefined) =>
      emoji && /^\d+$/.test(emoji.key) ? emojiUrl(emoji.key, emoji.text.startsWith("<a:")) : null;

    /** The starboard, while it's on and the member can see its channel. */
    const visibleStarboard = Effect.gen(function* () {
      const { userId } = yield* CurrentMember;
      const starboard = yield* starboardNow;
      const board = starboard.board;
      if (!board || !(yield* access.canView(userId, board.channelId))) return undefined;
      return { starboard, board };
    });

    /** Refuses members without `starboard.config`. */
    const mayConfig = Effect.gen(function* () {
      const { userId } = yield* CurrentMember;
      if (!(yield* access.can(userId, "starboard.config"))) {
        return yield* new Refused({ message: "Changing the starboard takes the starboard.config permission." });
      }
      return userId;
    });

    /** Runs a change from starboard/manage.ts with the services it needs. */
    const configuring = <A, E>(effect: Effect.Effect<A, E, StarboardGuild | Settings>) =>
      effect.pipe(Effect.provideService(StarboardGuild, guild), Effect.provideService(Settings, settings));

    /** The names the entries' mentions show, of channels the member can see. */
    const namesFor = Effect.fnUntraced(function* (texts: readonly string[], channelIds: readonly string[]) {
      const { userId } = yield* CurrentMember;
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

    return {
      session: () =>
        Effect.gen(function* () {
          const { userId, admin } = yield* CurrentMember;
          const user = yield* request("fetching a user", () => client.users.fetch(userId));
          const { prefix } = yield* settings.get;
          return {
            user: {
              id: user.id,
              name: user.globalName ?? user.username,
              tag: tagOf(user),
              avatarUrl: user.displayAvatarURL({ size: 64 }),
            },
            admin,
            configStarboard: yield* access.can(userId, "starboard.config"),
            prefix,
            emojiImages: `${client.instance.endpoints.static_cdn.replace(/\/+$/, "")}/emoji`,
          };
        }).pipe(hide("loading the session")),

      starboard: () =>
        Effect.gen(function* () {
          const visible = yield* visibleStarboard;
          if (!visible) return null;
          const { board } = visible;
          const channel = yield* guild.channel(board.channelId);
          return {
            emoji: board.emoji.text,
            emojiUrl: customEmojiUrl(board.emoji),
            channelId: board.channelId,
            channelName: channel?.name ?? "deleted-channel",
            threshold: board.threshold,
            nsfw: channel?.nsfw ?? false,
          };
        }).pipe(hide("loading the starboard")),

      starboardEntries: ({ sort, offset }) =>
        Effect.gen(function* () {
          const visible = yield* visibleStarboard;
          if (!visible) return { entries: [], total: 0, names: { users: {}, channels: {}, emojis: {} } };
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
        }).pipe(hide("loading the starboard entries")),

      unicodeEmoji: () => Effect.sync(unicodeEmoji).pipe(hide("listing the emoji")),

      starboardOptOut: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          return yield* (yield* starboardNow).optedOut(userId);
        }).pipe(hide("loading the starboard opt-out")),

      setStarboardOptOut: ({ optedOut }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          const starboard = yield* starboardNow;
          if (optedOut) return yield* starboard.optOut(userId);
          yield* starboard.optIn(userId);
          return 0;
        }).pipe(hide("changing the starboard opt-out")),

      starboardSetup: () =>
        Effect.gen(function* () {
          const userId = yield* mayConfig;
          const config = yield* configuring(currentStarboard);
          const channels = yield* guild.textChannels;
          const visible = new Set(yield* access.visibleChannels(userId, channels.map((c) => c.id)));
          const emojis = yield* guild.emojis;
          const emoji = parseEmoji(config.emoji);
          return {
            config: {
              channelId: config.channelId ?? null,
              threshold: config.threshold,
              emoji: emoji?.text ?? config.emoji,
              emojiUrl: customEmojiUrl(emoji),
            },
            channels: channels.filter((c) => visible.has(c.id)).map(({ id, name, nsfw }) => ({ id, name, nsfw })),
            emojis: emojis.map((e) => ({
              text: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
              name: e.name,
              url: emojiUrl(e.id, e.animated),
            })),
          };
        }).pipe(answer("loading the starboard settings")),

      setStarboard: ({ starboard }) =>
        Effect.gen(function* () {
          const userId = yield* mayConfig;
          yield* configuring(setStarboard(starboard, userId));
        }).pipe(answer("setting the starboard")),

      disableStarboard: () =>
        Effect.gen(function* () {
          const userId = yield* mayConfig;
          yield* configuring(disableStarboard(userId));
        }).pipe(answer("disabling the starboard")),
    };
  }),
);

/**
 * `name#0001`, or the bare username. An instance can make usernames unique
 * instead, and then every discriminator is zeros.
 */
function tagOf({ username, discriminator }: { username: string; discriminator: string }): string {
  return /^0*$/.test(discriminator) ? username : `${username}#${discriminator}`;
}
