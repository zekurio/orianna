import { and, count, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { Context, Effect, Semaphore } from "effect";
import { refuse } from "../commands/command.ts";
import type { BoardConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { boardEntries, boardOptOuts } from "../db/schema.ts";
import { type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";

/** A file on a message. */
export interface BoardAttachment {
  name: string;
  url: string;
  image: boolean;
  /** The uploader marked it NSFW. */
  nsfw: boolean;
}

/** What a board post shows of a message. */
export interface BoardMessage {
  id: string;
  channelId: string;
  /** Null in a DM. */
  guildId: string | null;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  createdAt: Date;
  attachments: BoardAttachment[];
  /** Images from link previews. */
  embedImages: string[];
  /** How many reacted with each emoji, by {@link reactionKey}, the author and bots included. */
  reactionCounts: Map<string, number>;
}

/** What boards need from the guild. */
export class BoardGuild extends Context.Service<
  BoardGuild,
  {
    /** Null when the message is gone. */
    readonly message: (channelId: string, messageId: string) => Effect.Effect<BoardMessage | null, FluxerError>;
    /** Every non-bot user who reacted with `emoji`. */
    readonly reactionUsers: (
      channelId: string,
      messageId: string,
      emoji: string,
    ) => Effect.Effect<string[], FluxerError>;
    readonly nsfw: (channelId: string) => Effect.Effect<boolean, FluxerError>;
    /** Posts a message and returns its ID. */
    readonly post: (channelId: string, body: MessageBody) => Effect.Effect<string, FluxerError>;
    /** False when the message is gone. */
    readonly edit: (channelId: string, messageId: string, body: MessageBody) => Effect.Effect<boolean, FluxerError>;
    /** Also succeeds when the message is already gone. */
    readonly delete: (channelId: string, messageId: string) => Effect.Effect<void, FluxerError>;
    readonly messageLink: (channelId: string, messageId: string) => string;
  }
>()("orianna/BoardGuild") {}

interface Board extends Omit<BoardConfig, "emoji"> {
  emoji: ParsedEmoji;
}

type Entry = typeof boardEntries.$inferSelect;

/** How many members `!board top` lists. */
const TOP_SIZE = 10;

/** Leaves room in the embed for the files and the link. */
const MAX_TEXT = 3500;

/** The last ID in a message link, or a bare ID. */
const MESSAGE_ID = /(\d+)\/?$/;

export type Boards = Effect.Success<ReturnType<typeof makeBoards>>;

/**
 * Starboards. Every update counts the reactions again instead of keeping a
 * tally, so reactions from while the bot was offline count on the next one.
 * All work runs one task at a time, so a burst of reactions can't post a
 * message twice.
 */
export const makeBoards = Effect.fnUntraced(function* (config: readonly BoardConfig[], guildId: string) {
  const db = yield* Database;
  const guild = yield* BoardGuild;
  const lock = yield* Semaphore.make(1);

  // The config check already rejected emoji that don't parse.
  const boards: Board[] = config.map((b) => ({ ...b, emoji: parseEmoji(b.emoji)! }));
  const boardChannels = new Set(boards.map((b) => b.channelId));
  const byName = new Map(boards.map((b) => [b.name, b]));

  function enqueue<E>(label: string, task: Effect.Effect<void, E>): Effect.Effect<void> {
    return lock.withPermits(1)(task).pipe(Effect.catchCause(logFailure(`boards: ${label}`)));
  }

  function entry(messageId: string, board: string): Entry | undefined {
    return db
      .select()
      .from(boardEntries)
      .where(and(eq(boardEntries.messageId, messageId), eq(boardEntries.board, board)))
      .get();
  }

  function optedOut(userId: string): boolean {
    return db.select().from(boardOptOuts).where(eq(boardOptOuts.userId, userId)).get() !== undefined;
  }

  /** Counts the reactions again and posts, edits or takes down the message's post to match. */
  const update = Effect.fnUntraced(function* (board: Board, channelId: string, messageId: string) {
    if (boardChannels.has(channelId) || board.ignoredChannelIds.includes(channelId)) return;
    const row = entry(messageId, board.name);
    if (row?.removed) return;

    const message = yield* guild.message(channelId, messageId);
    if (!message) {
      if (row) yield* takeDown(row);
      return;
    }
    if (message.guildId !== guildId || optedOut(message.authorId)) return;
    // These counts include the author and bots, so they can only be too high.
    if (!row && (message.reactionCounts.get(board.emoji.key) ?? 0) < board.threshold) return;

    const users = yield* guild.reactionUsers(channelId, messageId, board.emoji.api);
    const reacted = users.filter((id) => id !== message.authorId).length;
    if (reacted < board.threshold && !(row && board.keep)) {
      if (row) yield* takeDown(row);
      return;
    }

    const body = renderPost(board, message, reacted, guild.messageLink(channelId, messageId));
    if (row?.postChannelId && row.postId) {
      if (yield* guild.edit(row.postChannelId, row.postId, body)) {
        db.update(boardEntries)
          .set({ count: reacted })
          .where(and(eq(boardEntries.messageId, messageId), eq(boardEntries.board, board.name)))
          .run();
      } else {
        // Someone deleted the post while the bot was offline.
        markRemoved(row);
      }
      return;
    }

    if ((yield* guild.nsfw(channelId)) && !(yield* guild.nsfw(board.channelId))) return;
    // A change to the settings interrupts updates; one that came between
    // posting and recording would leave the post behind, and post it again.
    yield* Effect.uninterruptible(
      guild.post(board.channelId, body).pipe(
        Effect.map((postId) =>
          db
            .insert(boardEntries)
            .values({
              messageId,
              board: board.name,
              channelId,
              authorId: message.authorId,
              postChannelId: board.channelId,
              postId,
              count: reacted,
              postedAt: new Date(),
            })
            .run(),
        ),
      ),
    );
  });

  /** Deletes the post and forgets the entry, so the message can go up again. */
  const takeDown = Effect.fnUntraced(function* (row: Entry) {
    if (row.postChannelId && row.postId) yield* guild.delete(row.postChannelId, row.postId);
    db.delete(boardEntries)
      .where(and(eq(boardEntries.messageId, row.messageId), eq(boardEntries.board, row.board)))
      .run();
  });

  /** Keeps the entry, so the message doesn't go up again. */
  function markRemoved(row: Entry) {
    db.update(boardEntries)
      .set({ removed: true, postChannelId: null, postId: null })
      .where(and(eq(boardEntries.messageId, row.messageId), eq(boardEntries.board, row.board)))
      .run();
  }

  function boardOf(name: string | undefined) {
    if (boards.length === 0) return refuse("There are no boards.");
    if (name === undefined) return Effect.succeed(boards[0]!);
    const board = byName.get(name.toLowerCase());
    if (board) return Effect.succeed(board);
    return refuse(`There is no board called ${name}. Try ${boards.map((b) => b.name).join(", ")}.`);
  }

  return {
    boards: boards as readonly Board[],

    /** Someone reacted, or reactions were cleared, all of them when `emoji` is unset. */
    reacted: (channelId: string, messageId: string, emoji?: ReactionEmoji) => {
      const key = emoji && reactionKey(emoji);
      const affected = boards.filter((b) => emoji === undefined || b.emoji.key === key);
      return Effect.forEach(affected, (board) => enqueue("reaction", update(board, channelId, messageId)), {
        discard: true,
      });
    },

    /** Brings the posts of an edited message up to date. */
    messageEdited: (channelId: string, messageId: string) =>
      enqueue(
        "message edit",
        Effect.gen(function* () {
          const rows = db
            .select()
            .from(boardEntries)
            .where(and(eq(boardEntries.messageId, messageId), isNotNull(boardEntries.postId)))
            .all();
          for (const row of rows) {
            const board = byName.get(row.board);
            if (board) yield* update(board, channelId, messageId);
          }
        }),
      ),

    /**
     * Takes down the posts of a deleted message. A deleted post takes its
     * message off the board for good; the bot's own deletions have already
     * dropped the entry by the time their event arrives.
     */
    messageDeleted: (messageId: string) =>
      enqueue(
        "message delete",
        Effect.gen(function* () {
          const sources = db.select().from(boardEntries).where(eq(boardEntries.messageId, messageId)).all();
          for (const row of sources) yield* takeDown(row);
          const post = db.select().from(boardEntries).where(eq(boardEntries.postId, messageId)).get();
          if (post) markRemoved(post);
        }),
      ),

    /**
     * Takes a message off its boards for good. `input` is a link to the
     * message or to a post, or either ID. Returns the boards it was on.
     */
    remove: (input: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const id = MESSAGE_ID.exec(input.trim())?.[1];
          if (!id) return yield* refuse(`${input} isn't a message link or ID.`);
          const rows = db
            .select()
            .from(boardEntries)
            .where(
              and(
                or(eq(boardEntries.messageId, id), eq(boardEntries.postId, id)),
                isNotNull(boardEntries.postId),
              ),
            )
            .all();
          if (rows.length === 0) return yield* refuse("That message isn't on a board.");
          for (const row of rows) {
            yield* guild.delete(row.postChannelId!, row.postId!);
            markRemoved(row);
          }
          return rows.map((r) => r.board);
        }),
      ),

    /** Keeps the member's messages off the boards and takes down their posts. Returns how many. */
    optOut: (userId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          db.insert(boardOptOuts).values({ userId, optedOutAt: new Date() }).onConflictDoNothing().run();
          const rows = db
            .select()
            .from(boardEntries)
            .where(and(eq(boardEntries.authorId, userId), isNotNull(boardEntries.postId)))
            .all();
          for (const row of rows) yield* takeDown(row);
          return rows.length;
        }),
      ),

    /** Returns false when the member hadn't opted out. */
    optIn: (userId: string) =>
      Effect.sync(() => db.delete(boardOptOuts).where(eq(boardOptOuts.userId, userId)).returning().all().length > 0),

    /** The members with the most posts on a board, the first board by default. */
    top: (name: string | undefined) =>
      Effect.gen(function* () {
        const board = yield* boardOf(name);
        const rows = db
          .select({
            authorId: boardEntries.authorId,
            posts: count(),
            reactions: sql<number>`sum(${boardEntries.count})`.mapWith(Number),
          })
          .from(boardEntries)
          .where(and(eq(boardEntries.board, board.name), isNotNull(boardEntries.postId)))
          .groupBy(boardEntries.authorId)
          .orderBy(desc(count()), desc(sql`sum(${boardEntries.count})`))
          .limit(TOP_SIZE)
          .all();
        return { board, rows };
      }),
  };
});

export function renderPost(board: Board, message: BoardMessage, reacted: number, link: string): MessageBody {
  const shown = message.attachments.find((a) => a.image && !a.nsfw);
  const image = shown?.url ?? message.embedImages[0];
  const files = message.attachments
    .filter((a) => a !== shown)
    .map((a) => `📎 [${a.name.replace(/[[\]]/g, "")}](${a.url})`);
  const text = message.content.length > MAX_TEXT ? `${message.content.slice(0, MAX_TEXT)}…` : message.content;
  return {
    content: `${board.emoji.text} **${reacted}** in <#${message.channelId}>`,
    embeds: [
      {
        author: { name: message.authorName, iconUrl: message.authorAvatar },
        description: [text, files.join("\n"), `[Jump to message](${link})`].filter(Boolean).join("\n\n"),
        color: ACCENT,
        image,
        timestamp: message.createdAt,
      },
    ],
  };
}
