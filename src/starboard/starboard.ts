import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Option, Result, Semaphore, Stream, SubscriptionRef } from "effect";
import type { UserError } from "../commands/command.ts";
import type { StarboardConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { type StarboardMedia, starboardEntries, starboardOptOuts } from "../db/schema.ts";
import { type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { ImageMagick } from "../expressions/process.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { ACCENT, type MessageBody, type MessageFile } from "../messages/body.ts";
import { Settings } from "../settings/settings.ts";

/** A file on a message. */
export interface StarboardAttachment {
  name: string;
  url: string;
  kind: StarboardMedia["kind"];
  /** The uploader marked it NSFW. */
  nsfw: boolean;
}

/** What a starboard post shows of a message. */
export interface StarboardMessage {
  id: string;
  channelId: string;
  /** Null in a DM. */
  guildId: string | null;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  createdAt: Date;
  attachments: StarboardAttachment[];
  /** Images from link previews. */
  embedImages: string[];
  /** How many reacted with each emoji, by {@link reactionKey}, the author and bots included. */
  reactionCounts: Map<string, number>;
}

/** A channel in the guild, as the starboard sees it. */
export interface StarboardChannel {
  id: string;
  name: string;
  nsfw: boolean;
  /** Takes messages, so the starboard can post there. */
  text: boolean;
}

/** A custom emoji of the guild. */
export interface GuildEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/** What the starboard needs from the guild. */
export class StarboardGuild extends Context.Service<
  StarboardGuild,
  {
    /** Null when the message is gone. */
    readonly message: (channelId: string, messageId: string) => Effect.Effect<StarboardMessage | null, FluxerError>;
    readonly nsfw: (channelId: string) => Effect.Effect<boolean, FluxerError>;
    /** Null when the guild has no such channel. */
    readonly channel: (channelId: string) => Effect.Effect<StarboardChannel | null, FluxerError>;
    /** The guild's channels that take messages, threads aside, in the order the client lists them. */
    readonly textChannels: Effect.Effect<StarboardChannel[], FluxerError>;
    readonly emojis: Effect.Effect<GuildEmoji[], FluxerError>;
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
>()("orianna/StarboardGuild") {}

/** The starboard as it runs: on, with a channel. */
interface Board {
  channelId: string;
  threshold: number;
  emoji: ParsedEmoji;
}

type Entry = typeof starboardEntries.$inferSelect;

/** Leaves room in the embed for the files and the link. */
const MAX_TEXT = 3500;

/** A link to an image in the text, shown when a message has no other image. */
const IMAGE_LINK = /https?:\/\/\S+?\.(?:jpe?g|png|webp|gif)(?:[?#]\S*)?(?=\s|$)/i;

/** How many images of one message the bot blurs, at most. */
const MAX_BLURRED = 4;

/** What a starboard that isn't NSFW hides. Both are false on an NSFW one. */
interface Censor {
  /** The message is from an NSFW channel, so all its images and files. */
  channel: boolean;
  /** Attachments their uploader marked NSFW. */
  marked: boolean;
}

export type Starboard = Effect.Success<ReturnType<typeof makeStarboard>>;

/**
 * The starboard, as shinpuru has it: once a message has `threshold` votes
 * with the emoji, the bot posts it in the starboard channel with its vote
 * count, and takes it down when votes drop below again. Every update counts
 * the reactions again instead of keeping a tally, so reactions from while
 * the bot was offline count on the next one. All work runs one task at a
 * time, so a burst of reactions can't post a message twice.
 */
export const makeStarboard = Effect.fnUntraced(function* (config: StarboardConfig | undefined, guildId: string) {
  const db = yield* Database;
  const guild = yield* StarboardGuild;
  const magick = yield* ImageMagick;
  const lock = yield* Semaphore.make(1);

  // The settings check already rejected emoji that don't parse.
  const board: Board | undefined =
    config?.channelId === undefined
      ? undefined
      : { channelId: config.channelId, threshold: config.threshold, emoji: parseEmoji(config.emoji)! };

  function enqueue<E>(label: string, task: Effect.Effect<void, E>): Effect.Effect<void> {
    return lock.withPermits(1)(task).pipe(Effect.catchCause(logFailure(`starboard: ${label}`)));
  }

  function entry(messageId: string): Entry | undefined {
    return db.select().from(starboardEntries).where(eq(starboardEntries.messageId, messageId)).get();
  }

  function optedOut(userId: string): boolean {
    return db.select().from(starboardOptOuts).where(eq(starboardOptOuts.userId, userId)).get() !== undefined;
  }

  /** Counts the votes again and posts, edits or takes down the message's post to match. */
  const update = Effect.fnUntraced(function* (board: Board, channelId: string, messageId: string) {
    if (channelId === board.channelId) return;
    const row = entry(messageId);
    if (row?.removed) return;

    const message = yield* guild.message(channelId, messageId);
    if (!message) {
      if (row) yield* takeDown(row);
      return;
    }
    if (message.guildId !== guildId || optedOut(message.authorId)) return;
    const votes = message.reactionCounts.get(board.emoji.key) ?? 0;
    if (votes < board.threshold) {
      if (row) yield* takeDown(row);
      return;
    }

    const link = guild.messageLink(channelId, messageId);
    const censor = yield* censorFor(board, channelId);
    if (row?.postChannelId && row.postId) {
      // Edits leave the post's files alone, so its blurred images stay.
      const media = [...visibleMedia(message, censor), ...(row.media ?? []).filter((m) => m.blurred)];
      if (yield* guild.edit(row.postChannelId, row.postId, renderPost(board, message, votes, link, media))) {
        db.update(starboardEntries)
          .set({ count: votes, ...snapshot(message, media) })
          .where(eq(starboardEntries.messageId, messageId))
          .run();
      } else {
        // Someone deleted the post while the bot was offline.
        markRemoved(row);
      }
      return;
    }

    const media = visibleMedia(message, censor);
    const files = yield* blurImages(message, censor);
    const body = { ...renderPost(board, message, votes, link, media), files };
    // A change to the settings interrupts updates; one that came between
    // posting and recording would leave the post behind, and post it again.
    yield* Effect.uninterruptible(
      guild.post(board.channelId, body).pipe(
        Effect.map((post) => {
          const blurred = files.flatMap((f): StarboardMedia[] => {
            const url = post.files.get(f.name);
            return url ? [{ url, name: f.name, kind: "image", blurred: true }] : [];
          });
          db.insert(starboardEntries)
            .values({
              messageId,
              channelId,
              authorId: message.authorId,
              postChannelId: board.channelId,
              postId: post.id,
              count: votes,
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
   * Blurred copies of the images the starboard hides, to post with the
   * message, as shinpuru does. An image that can't be blurred is left out.
   */
  const blurImages = Effect.fnUntraced(function* (message: StarboardMessage, censor: Censor) {
    const sources = [
      ...message.attachments.filter((a) => a.kind === "image" && hidden(a, censor)).map((a) => a.url),
      ...(censor.channel ? linkedImages(message) : []),
    ].slice(0, MAX_BLURRED);
    const files: MessageFile[] = [];
    for (const url of sources) {
      const result = yield* Effect.result(guild.downloadImage(url).pipe(Effect.flatMap(magick.blur)));
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(`starboard: couldn't blur ${url}: ${result.failure.message}`);
        continue;
      }
      files.push({ name: `blurred-${files.length + 1}.webp`, data: result.success.image });
    }
    return files;
  });

  /** Deletes the post and forgets the entry, so the message can go up again. */
  const takeDown = Effect.fnUntraced(function* (row: Entry) {
    if (row.postChannelId && row.postId) yield* guild.delete(row.postChannelId, row.postId);
    db.delete(starboardEntries).where(eq(starboardEntries.messageId, row.messageId)).run();
  });

  /** Keeps the entry, so the message doesn't go up again. */
  function markRemoved(row: Entry) {
    db.update(starboardEntries)
      .set({ removed: true, postChannelId: null, postId: null })
      .where(eq(starboardEntries.messageId, row.messageId))
      .run();
  }

  /**
   * Fills in what the posts from before the bot kept it show, for the web
   * interface, one at a time between other updates. The posts stay as they are.
   */
  const catchUp = Effect.gen(function* () {
    if (!board) return;
    const rows = db
      .select()
      .from(starboardEntries)
      .where(and(isNull(starboardEntries.content), isNotNull(starboardEntries.postId)))
      .all();
    for (const { messageId } of rows) {
      yield* enqueue(
        "catching up",
        Effect.gen(function* () {
          const row = entry(messageId);
          if (!row?.postId || row.content !== null) return;
          const message = yield* guild.message(row.channelId, messageId);
          if (!message) return yield* takeDown(row);
          const media = visibleMedia(message, yield* censorFor(board, row.channelId));
          db.update(starboardEntries).set(snapshot(message, media)).where(eq(starboardEntries.messageId, messageId)).run();
        }),
      );
    }
  });

  return {
    /** The settings this starboard was made from. */
    config,
    /** Unset while the starboard is off. */
    board: board as Readonly<Board> | undefined,
    catchUp,

    /** Someone reacted, or reactions were cleared, all of them when `emoji` is unset. */
    reacted: (channelId: string, messageId: string, emoji?: ReactionEmoji) => {
      if (!board || (emoji && reactionKey(emoji) !== board.emoji.key)) return Effect.void;
      return enqueue("reaction", update(board, channelId, messageId));
    },

    /** Brings the post of an edited message up to date. */
    messageEdited: (channelId: string, messageId: string) =>
      enqueue(
        "message edit",
        Effect.gen(function* () {
          if (board && entry(messageId)?.postId) yield* update(board, channelId, messageId);
        }),
      ),

    /**
     * Takes down the post of a deleted message. A deleted post keeps its
     * message out of the starboard for good; the bot's own deletions have
     * already dropped the entry by the time their event arrives.
     */
    messageDeleted: (messageId: string) =>
      enqueue(
        "message delete",
        Effect.gen(function* () {
          const source = entry(messageId);
          if (source) yield* takeDown(source);
          const post = db.select().from(starboardEntries).where(eq(starboardEntries.postId, messageId)).get();
          if (post) markRemoved(post);
        }),
      ),

    /** Keeps the member's messages out of the starboard and takes down their posts. Returns how many. */
    optOut: (userId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          db.insert(starboardOptOuts).values({ userId, optedOutAt: new Date() }).onConflictDoNothing().run();
          const rows = db
            .select()
            .from(starboardEntries)
            .where(and(eq(starboardEntries.authorId, userId), isNotNull(starboardEntries.postId)))
            .all();
          for (const row of rows) yield* takeDown(row);
          return rows.length;
        }),
      ),

    /** Whether the member keeps their messages out of the starboard. */
    optedOut: (userId: string) => Effect.sync(() => optedOut(userId)),

    /** Returns false when the member hadn't opted out. */
    optIn: (userId: string) =>
      Effect.sync(
        () => db.delete(starboardOptOuts).where(eq(starboardOptOuts.userId, userId)).returning().all().length > 0,
      ),

    /** A page of the posts, newest or most voted first, and how many there are. */
    posts: (sort: "latest" | "top", offset: number, limit: number) =>
      Effect.sync(() => {
        const where = isNotNull(starboardEntries.postId);
        const order =
          sort === "top"
            ? [desc(starboardEntries.count), desc(starboardEntries.postedAt)]
            : [desc(starboardEntries.postedAt)];
        const rows = db
          .select()
          .from(starboardEntries)
          .where(where)
          .orderBy(...order)
          .limit(limit)
          .offset(offset)
          .all();
        const total = db.select({ n: count() }).from(starboardEntries).where(where).get()?.n ?? 0;
        return { rows, total };
      }),
  };
});

/**
 * The starboard as the settings have it now. The features set it when they
 * start and clear it when they stop, so what outlives a settings change,
 * like the web interface, finds the current one.
 */
export class LiveStarboard extends Context.Service<
  LiveStarboard,
  SubscriptionRef.SubscriptionRef<Starboard | undefined>
>()("orianna/LiveStarboard") {
  static readonly layer = Layer.effect(LiveStarboard, SubscriptionRef.make<Starboard | undefined>(undefined));

  /** Makes `starboard` the current one until the scope closes. */
  static readonly provide = (starboard: Starboard) =>
    Effect.gen(function* () {
      const ref = yield* LiveStarboard;
      yield* Effect.acquireRelease(SubscriptionRef.set(ref, starboard), () => SubscriptionRef.set(ref, undefined));
    });

  /**
   * The starboard the settings have now. Right after a change, the old one
   * may still be up, so this waits for the new one.
   */
  static readonly current = Effect.gen(function* () {
    const ref = yield* LiveStarboard;
    const wanted = (yield* Settings.current).starboard;
    const next = yield* SubscriptionRef.changes(ref).pipe(
      Stream.filter(
        (starboard): starboard is Starboard => starboard !== undefined && Bun.deepEquals(starboard.config, wanted),
      ),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () => Effect.die(new Error("the starboard didn't start; the log says why")),
      }),
    );
    return Option.getOrThrow(next);
  });
}

function hidden(attachment: StarboardAttachment, censor: Censor): boolean {
  return censor.channel || (censor.marked && attachment.nsfw);
}

/** Images from link previews, or else an image link in the text. */
function linkedImages(message: StarboardMessage): string[] {
  if (message.embedImages.length > 0) return message.embedImages;
  const link = IMAGE_LINK.exec(message.content)?.[0];
  return link ? [link] : [];
}

/** The files and linked images the starboard shows, besides the ones it blurs. */
function visibleMedia(message: StarboardMessage, censor: Censor): StarboardMedia[] {
  const media: StarboardMedia[] = message.attachments
    .filter((a) => !hidden(a, censor))
    .map(({ url, name, kind }) => ({ url, name, kind }));
  if (censor.channel) return media;
  const linked = linkedImages(message).map(
    (url): StarboardMedia => ({ url, name: fileName(url), kind: "image", linked: true }),
  );
  return [...media, ...linked];
}

function fileName(url: string): string {
  return URL.parse(url)?.pathname.split("/").at(-1) || url;
}

/** What the entry keeps of the message. */
function snapshot(message: StarboardMessage, media: StarboardMedia[]) {
  return {
    content: message.content,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar,
    media,
    sentAt: message.createdAt,
  };
}

/**
 * The post, like shinpuru's: the author, the text, a link to the message,
 * the first image that isn't blurred, and the votes in the footer. Other
 * files are linked; blurred images go with the post as files of their own.
 */
function renderPost(
  board: Board,
  message: StarboardMessage,
  votes: number,
  link: string,
  media: readonly StarboardMedia[],
): Exclude<MessageBody, string> {
  const shown = media.find((m) => m.kind === "image" && !m.blurred);
  const files = media
    .filter((m) => m !== shown && !m.blurred && !m.linked)
    .map((m) => `📎 [${m.name.replace(/[[\]]/g, "")}](${m.url})`);
  const text = message.content.length > MAX_TEXT ? `${message.content.slice(0, MAX_TEXT)}…` : message.content;
  // A footer can't show a custom emoji.
  const emoji = /^\d+$/.test(board.emoji.key) ? "⭐" : board.emoji.text;
  return {
    embeds: [
      {
        author: { name: message.authorName, iconUrl: message.authorAvatar },
        description: [text, files.join("\n"), `[jump to message](${link})`].filter(Boolean).join("\n\n"),
        color: ACCENT,
        image: shown?.url,
        timestamp: message.createdAt,
        footer: `${votes} ${emoji}`,
      },
    ],
  };
}
