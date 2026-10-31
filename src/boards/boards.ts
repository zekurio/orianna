import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { Context, Effect, Result, Semaphore } from "effect";
import { refuse, type UserError } from "../commands/command.ts";
import type { BoardConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { type BoardMedia, boardEntries, boardOptOuts } from "../db/schema.ts";
import { type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { ImageMagick } from "../expressions/process.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { ACCENT, type MessageBody, type MessageFile } from "../messages/body.ts";

/** A file on a message. */
export interface BoardAttachment {
  name: string;
  url: string;
  kind: BoardMedia["kind"];
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

/** A channel in the guild, as boards see it. */
export interface BoardChannel {
  id: string;
  name: string;
  nsfw: boolean;
  /** Takes messages, so a board can post there. */
  text: boolean;
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
    /** Null when the guild has no such channel. */
    readonly channel: (channelId: string) => Effect.Effect<BoardChannel | null, FluxerError>;
    /** Downloads an image from a message, to blur it. */
    readonly downloadImage: (url: string) => Effect.Effect<Uint8Array, UserError>;
    /** Posts a message. Returns its ID, and the URLs of its files by name. */
    readonly post: (
      channelId: string,
      body: MessageBody,
    ) => Effect.Effect<{ id: string; files: ReadonlyMap<string, string> }, FluxerError>;
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

/** A link to an image in the text, shown when a message has no other image. */
const IMAGE_LINK = /https?:\/\/\S+?\.(?:jpe?g|png|webp|gif)(?:[?#]\S*)?(?=\s|$)/i;

/** How many images of one message the bot blurs, at most. */
const MAX_BLURRED = 4;

/** What a board that isn't NSFW hides. Both are false on an NSFW board. */
interface Censor {
  /** The message is from an NSFW channel, so all its images and files. */
  channel: boolean;
  /** Attachments their uploader marked NSFW. */
  marked: boolean;
}

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
  const magick = yield* ImageMagick;
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

    const link = guild.messageLink(channelId, messageId);
    const censor = yield* censorFor(board, channelId);
    if (row?.postChannelId && row.postId) {
      // Edits leave the post's files alone, so its blurred images stay.
      const media = [...visibleMedia(message, censor), ...(row.media ?? []).filter((m) => m.blurred)];
      if (yield* guild.edit(row.postChannelId, row.postId, renderPost(board, message, reacted, link, media))) {
        db.update(boardEntries)
          .set({ count: reacted, ...snapshot(message, media) })
          .where(and(eq(boardEntries.messageId, messageId), eq(boardEntries.board, board.name)))
          .run();
      } else {
        // Someone deleted the post while the bot was offline.
        markRemoved(row);
      }
      return;
    }

    const media = visibleMedia(message, censor);
    const files = yield* blurImages(message, censor);
    const body = { ...renderPost(board, message, reacted, link, media), files };
    // A change to the settings interrupts updates; one that came between
    // posting and recording would leave the post behind, and post it again.
    yield* Effect.uninterruptible(
      guild.post(board.channelId, body).pipe(
        Effect.map((post) => {
          const blurred = files.flatMap((f): BoardMedia[] => {
            const url = post.files.get(f.name);
            return url ? [{ url, name: f.name, kind: "image", blurred: true }] : [];
          });
          db.insert(boardEntries)
            .values({
              messageId,
              board: board.name,
              channelId,
              authorId: message.authorId,
              postChannelId: board.channelId,
              postId: post.id,
              count: reacted,
              postedAt: new Date(),
              ...snapshot(message, [...media, ...blurred]),
            })
            .run();
        }),
      ),
    );
  });

  const censorFor = Effect.fnUntraced(function* (board: Board, channelId: string) {
    if (yield* guild.nsfw(board.channelId)) return { channel: false, marked: false } satisfies Censor;
    return { channel: yield* guild.nsfw(channelId), marked: true } satisfies Censor;
  });

  /**
   * Blurred copies of the images the board hides, to post with the message,
   * as shinpuru does. An image that can't be blurred is left out.
   */
  const blurImages = Effect.fnUntraced(function* (message: BoardMessage, censor: Censor) {
    const sources = [
      ...message.attachments.filter((a) => a.kind === "image" && hidden(a, censor)).map((a) => a.url),
      ...(censor.channel ? linkedImages(message) : []),
    ].slice(0, MAX_BLURRED);
    const files: MessageFile[] = [];
    for (const url of sources) {
      const result = yield* Effect.result(guild.downloadImage(url).pipe(Effect.flatMap(magick.blur)));
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(`boards: couldn't blur ${url}: ${result.failure.message}`);
        continue;
      }
      files.push({ name: `blurred-${files.length + 1}.webp`, data: result.success.image });
    }
    return files;
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
    if (name === undefined && boards.length > 0) return Effect.succeed(boards[0]!);
    const board = name === undefined ? undefined : byName.get(name.toLowerCase());
    return board ? Effect.succeed(board) : noBoard(name, boards);
  }

  /**
   * Fills in what the posts from before the bot kept it show, for the web
   * interface, one at a time between other updates. The posts stay as they are.
   */
  const catchUp = Effect.gen(function* () {
    const rows = db
      .select()
      .from(boardEntries)
      .where(and(isNull(boardEntries.content), isNotNull(boardEntries.postId)))
      .all();
    for (const { messageId, board: name } of rows) {
      const board = byName.get(name);
      if (!board) continue;
      yield* enqueue(
        "catching up",
        Effect.gen(function* () {
          const row = entry(messageId, name);
          if (!row?.postId || row.content !== null) return;
          const message = yield* guild.message(row.channelId, messageId);
          if (!message) return yield* takeDown(row);
          const media = visibleMedia(message, yield* censorFor(board, row.channelId));
          db.update(boardEntries)
            .set(snapshot(message, media))
            .where(and(eq(boardEntries.messageId, messageId), eq(boardEntries.board, name)))
            .run();
        }),
      );
    }
  });

  return {
    boards: boards as readonly Board[],
    catchUp,

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

/** Refuses a board name that isn't one of `boards`, or any name when there are none. */
export function noBoard(name: string | undefined, boards: readonly { name: string }[]) {
  if (boards.length === 0) return refuse("There are no boards.");
  return refuse(`There is no board called ${name}. Try ${boards.map((b) => b.name).join(", ")}.`);
}

function hidden(attachment: BoardAttachment, censor: Censor): boolean {
  return censor.channel || (censor.marked && attachment.nsfw);
}

/** Images from link previews, or else an image link in the text. */
function linkedImages(message: BoardMessage): string[] {
  if (message.embedImages.length > 0) return message.embedImages;
  const link = IMAGE_LINK.exec(message.content)?.[0];
  return link ? [link] : [];
}

/** The files and linked images a board shows, besides the ones it blurs. */
export function visibleMedia(message: BoardMessage, censor: Censor): BoardMedia[] {
  const media: BoardMedia[] = message.attachments
    .filter((a) => !hidden(a, censor))
    .map(({ url, name, kind }) => ({ url, name, kind }));
  if (censor.channel) return media;
  const linked = linkedImages(message).map(
    (url): BoardMedia => ({ url, name: fileName(url), kind: "image", linked: true }),
  );
  return [...media, ...linked];
}

function fileName(url: string): string {
  return URL.parse(url)?.pathname.split("/").at(-1) || url;
}

/** What the entry keeps of the message. */
function snapshot(message: BoardMessage, media: BoardMedia[]) {
  return {
    content: message.content,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar,
    media,
    sentAt: message.createdAt,
  };
}

/**
 * The post: the first image that isn't blurred, links to the other files,
 * and the text. Blurred images go with the post as files of their own.
 */
export function renderPost(
  board: Board,
  message: BoardMessage,
  reacted: number,
  link: string,
  media: readonly BoardMedia[],
): Exclude<MessageBody, string> {
  const shown = media.find((m) => m.kind === "image" && !m.blurred);
  const files = media
    .filter((m) => m !== shown && !m.blurred && !m.linked)
    .map((m) => `📎 [${m.name.replace(/[[\]]/g, "")}](${m.url})`);
  const text = message.content.length > MAX_TEXT ? `${message.content.slice(0, MAX_TEXT)}…` : message.content;
  return {
    content: `${board.emoji.text} **${reacted}** in <#${message.channelId}>`,
    embeds: [
      {
        author: { name: message.authorName, iconUrl: message.authorAvatar },
        description: [text, files.join("\n"), `[Jump to message](${link})`].filter(Boolean).join("\n\n"),
        color: ACCENT,
        image: shown?.url,
        timestamp: message.createdAt,
      },
    ],
  };
}
