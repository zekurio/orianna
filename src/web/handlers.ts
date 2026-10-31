import { cdnEmojiURL } from "@fluxerjs/core";
import { Effect, Layer, Option, Result } from "effect";
import { Headers } from "effect/http";
import { BoardGuild, LiveBoards, noBoard } from "../boards/boards.ts";
import { createBoard, deleteBoard, editBoard } from "../boards/manage.ts";
import { parseEmoji } from "../emoji.ts";
import type { UserError } from "../commands/command.ts";
import { Fluxer, type FluxerError, logFailure, request } from "../fluxer.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import {
  type Board,
  type BoardPost,
  Authentication,
  BOARD_PAGE_SIZE,
  CurrentMember,
  type Names,
  NotMember,
  Refused,
  SignedOut,
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
    const guild = yield* BoardGuild;
    const live = yield* LiveBoards;
    const boardsNow = LiveBoards.current.pipe(
      Effect.provideService(LiveBoards, live),
      Effect.provideService(Settings, settings),
    );
    const emojiUrl = (id: string, animated: boolean) =>
      cdnEmojiURL(id, animated, { mediaBase: client.instance.endpoints.media });

    /** The boards whose channels the member can see. */
    const visibleBoards = Effect.gen(function* () {
      const { userId } = yield* CurrentMember;
      const boards = yield* boardsNow;
      const visible = new Set(yield* access.visibleChannels(userId, boards.boards.map((b) => b.channelId)));
      return boards.boards.filter((b) => visible.has(b.channelId));
    });

    /** Refuses members without `boards.manage`. */
    const mayManage = Effect.gen(function* () {
      const { userId } = yield* CurrentMember;
      if (!(yield* access.can(userId, "boards.manage"))) {
        return yield* new Refused({ message: "Setting up boards takes the boards.manage permission." });
      }
      return userId;
    });

    /** Runs a change from boards/manage.ts with the services it needs. */
    const managing = <A, E>(effect: Effect.Effect<A, E, BoardGuild | Settings>) =>
      effect.pipe(Effect.provideService(BoardGuild, guild), Effect.provideService(Settings, settings));

    /** A board the member can see; any other name is no board at all to them. */
    const visibleBoard = (name: string) =>
      visibleBoards.pipe(
        Effect.flatMap((boards) => {
          const board = boards.find((b) => b.name === name.toLowerCase());
          return board ? Effect.succeed(board) : noBoard(name, boards);
        }),
      );

    /** The names the posts' mentions show, of channels the member can see. */
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
            manageBoards: yield* access.can(userId, "boards.manage"),
            prefix,
          };
        }).pipe(hide("loading the session")),

      boards: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          const boards = yield* visibleBoards;
          const listed = yield* Effect.forEach(
            boards,
            (b) =>
              guild.channel(b.channelId).pipe(
                Effect.map((channel): Board => {
                  const custom = /^\d+$/.test(b.emoji.key);
                  return {
                    name: b.name,
                    emoji: b.emoji.text,
                    emojiUrl: custom ? emojiUrl(b.emoji.key, b.emoji.text.startsWith("<a:")) : null,
                    channelId: b.channelId,
                    channelName: channel?.name ?? "deleted-channel",
                    threshold: b.threshold,
                    keep: b.keep,
                    nsfw: channel?.nsfw ?? false,
                  };
                }),
              ),
            { concurrency: 4 },
          );
          return {
            boards: listed,
            canRemove: yield* access.can(userId, "boards.remove"),
          };
        }).pipe(hide("listing the boards")),

      boardPosts: ({ board, sort, offset }) =>
        Effect.gen(function* () {
          const { name } = yield* visibleBoard(board);
          const { rows, total } = yield* (yield* boardsNow).posts(name, sort, offset, BOARD_PAGE_SIZE);
          const posts = rows.map(
            (row): BoardPost => ({
              messageId: row.messageId,
              postId: row.postId!,
              channelId: row.channelId,
              authorId: row.authorId,
              authorName: row.authorName,
              authorAvatar: row.authorAvatar,
              content: row.content,
              media: row.media ?? [],
              count: row.count,
              sentAt: row.sentAt?.getTime() ?? null,
              postedAt: row.postedAt.getTime(),
              messageUrl: guild.messageLink(row.channelId, row.messageId),
              postUrl: guild.messageLink(row.postChannelId!, row.postId!),
            }),
          );
          const names = yield* namesFor(
            rows.map((r) => r.content ?? ""),
            rows.map((r) => r.channelId),
          );
          return { posts, total, names };
        }).pipe(answer("loading a board's posts")),

      boardTop: ({ board }) =>
        Effect.gen(function* () {
          const { name } = yield* visibleBoard(board);
          const { rows } = yield* (yield* boardsNow).top(name);
          return rows.map((r) => ({
            userId: r.authorId,
            name: r.authorName,
            avatarUrl: r.authorAvatar,
            posts: r.posts,
            reactions: r.reactions,
          }));
        }).pipe(answer("loading a leaderboard")),

      removeFromBoard: ({ board, postId }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          if (!(yield* access.can(userId, "boards.remove"))) {
            return yield* new Refused({ message: "Taking messages off boards takes the boards.remove permission." });
          }
          yield* visibleBoard(board);
          yield* (yield* boardsNow).remove(postId);
        }).pipe(answer("taking a message off a board")),

      boardOptOut: () =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          return yield* (yield* boardsNow).optedOut(userId);
        }).pipe(hide("loading the board opt-out")),

      setBoardOptOut: ({ optedOut }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentMember;
          const boards = yield* boardsNow;
          if (optedOut) return yield* boards.optOut(userId);
          yield* boards.optIn(userId);
          return 0;
        }).pipe(hide("changing the board opt-out")),

      boardSetup: () =>
        Effect.gen(function* () {
          const userId = yield* mayManage;
          const { boards } = yield* settings.get;
          const channels = yield* guild.textChannels;
          const visible = new Set(yield* access.visibleChannels(userId, channels.map((c) => c.id)));
          const emojis = yield* guild.emojis;
          return {
            boards: (boards ?? []).map((b) => {
              const emoji = parseEmoji(b.emoji);
              const custom = emoji && /^\d+$/.test(emoji.key);
              return {
                ...b,
                emoji: emoji?.text ?? b.emoji,
                emojiUrl: custom ? emojiUrl(emoji.key, emoji.text.startsWith("<a:")) : null,
              };
            }),
            channels: channels.filter((c) => visible.has(c.id)).map(({ id, name, nsfw }) => ({ id, name, nsfw })),
            emojis: emojis.map((e) => ({
              text: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
              name: e.name,
              url: emojiUrl(e.id, e.animated),
            })),
          };
        }).pipe(answer("loading the board setup")),

      createBoard: ({ board }) =>
        Effect.gen(function* () {
          const userId = yield* mayManage;
          yield* managing(createBoard(board, userId));
        }).pipe(answer("creating a board")),

      editBoard: ({ name, board }) =>
        Effect.gen(function* () {
          const userId = yield* mayManage;
          const { changed } = yield* managing(editBoard(name, board, userId));
          return changed;
        }).pipe(answer("changing a board")),

      deleteBoard: ({ name }) =>
        Effect.gen(function* () {
          const userId = yield* mayManage;
          yield* managing(deleteBoard(name, userId));
        }).pipe(answer("deleting a board")),
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
