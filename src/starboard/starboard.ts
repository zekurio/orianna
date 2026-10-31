import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Option, Result, Semaphore, Stream, SubscriptionRef } from "effect";
import type { UserError } from "../commands/command.ts";
import type { StarboardConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { type StarboardMedia, starboardEntries, starboardOptOuts } from "../db/schema.ts";
import { type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { ImageMagick } from "../expressions/process.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { ImageStore } from "../imagestore.ts";
import type { MessageBody } from "../messages/body.ts";
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
  /** The username, with the discriminator on instances that use them, like shinpuru shows authors. */
  authorName: string;
  authorAvatar: string;
  content: string;
  createdAt: Date;
  attachments: StarboardAttachment[];
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
    /** Posts a message. Returns its ID, and where its embed's image ended up, for one sent with it. */
    readonly post: (
      channelId: string,
      body: MessageBody,
    ) => Effect.Effect<{ id: string; image: string | null }, FluxerError>;
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

/** Leaves room in the embed for the link. */
const MAX_TEXT = 3500;

/** A link to an image in the text, which counts as a file of the message, as on shinpuru. */
const IMAGE_LINK = /https?:\/\/\S+?\.(?:jpe?g|png|webp|gif)(?:[?#]\S*)?(?=\s|$)/i;

/** shinpuru's embed colour. */
const COLOR = 0xffc107;

/** The blurred copy of the post's image, when it's sent with the post. */
const BLURRED = "blurred.webp";

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
  const store = yield* ImageStore;
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
    const { text, media } = contentsOf(message, yield* censorFor(board, channelId));
    const image = media.find((m) => m.kind === "image");
    if (row?.postChannelId && row.postId) {
      // The blurred copy went with the post, and edits keep it.
      const blurred = image?.hidden ? row.media?.find((m) => m.blurred) : undefined;
      const shown = image?.hidden ? blurred?.url : image?.url;
      const kept = [...media.filter((m) => !m.hidden).map(entryMedia), ...(blurred ? [blurred] : [])];
      if (yield* guild.edit(row.postChannelId, row.postId, renderPost(message, votes, link, text, shown))) {
        db.update(starboardEntries)
          .set({ count: votes, ...snapshot(message, text, kept) })
          .where(eq(starboardEntries.messageId, messageId))
          .run();
      } else {
        // Someone deleted the post while the bot was offline.
        yield* markRemoved(row);
      }
      return;
    }

    // Like shinpuru, an image the starboard hides goes up blurred instead,
    // from the image store. Without a web interface to serve it, the blurred
    // copy is sent with the post.
    const blurred = image?.hidden ? yield* blur(image.url) : undefined;
    const stored = blurred ? yield* store.put(blurred.image, blurred.type) : null;
    const attached = blurred && !stored;
    const shown = image?.hidden ? (stored ?? (attached ? `attachment://${BLURRED}` : undefined)) : image?.url;
    const body = {
      ...renderPost(message, votes, link, text, shown),
      files: attached ? [{ name: BLURRED, data: blurred.image }] : [],
    };
    // A change to the settings interrupts updates; one that came between
    // posting and recording would leave the post behind, and post it again.
    yield* Effect.uninterruptible(
      guild.post(board.channelId, body).pipe(
        Effect.tapError(() => (stored ? store.remove(stored) : Effect.void)),
        Effect.map((post) => {
          const url = stored ?? (attached ? post.image : null);
          const copy: StarboardMedia[] = url ? [{ url, name: fileName(url), kind: "image", blurred: true }] : [];
          db.insert(starboardEntries)
            .values({
              messageId,
              channelId,
              authorId: message.authorId,
              postChannelId: board.channelId,
              postId: post.id,
              count: votes,
              postedAt: new Date(),
              ...snapshot(message, text, [...media.filter((m) => !m.hidden).map(entryMedia), ...copy]),
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

  /** A blurred copy of an image, or nothing when it can't be blurred. */
  const blur = Effect.fnUntraced(function* (url: string) {
    const result = yield* Effect.result(guild.downloadImage(url).pipe(Effect.flatMap(magick.blur)));
    if (Result.isSuccess(result)) return result.success;
    yield* Effect.logWarning(`starboard: couldn't blur ${url}: ${result.failure.message}`);
    return undefined;
  });

  /** Deletes the post and forgets the entry, so the message can go up again. */
  const takeDown = Effect.fnUntraced(function* (row: Entry) {
    if (row.postChannelId && row.postId) yield* guild.delete(row.postChannelId, row.postId);
    db.delete(starboardEntries).where(eq(starboardEntries.messageId, row.messageId)).run();
    yield* forgetBlurred(row);
  });

  /** Keeps the entry, so the message doesn't go up again. */
  const markRemoved = Effect.fnUntraced(function* (row: Entry) {
    db.update(starboardEntries)
      .set({ removed: true, postChannelId: null, postId: null, media: [] })
      .where(eq(starboardEntries.messageId, row.messageId))
      .run();
    yield* forgetBlurred(row);
  });

  /** Deletes the blurred copy from the image store, once no post shows it. */
  const forgetBlurred = (row: Entry) =>
    Effect.forEach(row.media?.filter((m) => m.blurred) ?? [], (m) => store.remove(m.url), { discard: true });

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
          const { text, media } = contentsOf(message, yield* censorFor(board, row.channelId));
          const shown = media.filter((m) => !m.hidden).map(entryMedia);
          db.update(starboardEntries)
            .set(snapshot(message, text, shown))
            .where(eq(starboardEntries.messageId, messageId))
            .run();
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
          if (post) yield* markRemoved(post);
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

/** A file of the message, and whether the starboard hides it. */
type Media = StarboardMedia & { hidden: boolean };

/**
 * The text and files a post shows, the way shinpuru reads a message: its
 * files, then the first image link in the text, which leaves the text.
 */
function contentsOf(message: StarboardMessage, censor: Censor): { text: string; media: Media[] } {
  const link = IMAGE_LINK.exec(message.content)?.[0];
  const text = link ? message.content.replace(link, "").trim() : message.content;
  const media: Media[] = message.attachments.map(({ url, name, kind, nsfw }) => ({
    url,
    name,
    kind,
    hidden: censor.channel || (censor.marked && nsfw),
  }));
  if (link) media.push({ url: link, name: fileName(link), kind: "image", linked: true, hidden: censor.channel });
  return { text, media };
}

/** A file as the entry keeps it, for the web interface. */
function entryMedia({ hidden: _hidden, ...media }: Media): StarboardMedia {
  return media;
}

function fileName(url: string): string {
  return URL.parse(url)?.pathname.split("/").at(-1) || url;
}

/** What the entry keeps of the message. */
function snapshot(message: StarboardMessage, text: string, media: StarboardMedia[]) {
  return {
    content: text,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar,
    media,
    sentAt: message.createdAt,
  };
}

/**
 * shinpuru's post: the author, the text with a link to jump to the message,
 * the first image, the time it was sent, and the votes with a ⭐, whatever
 * the emoji.
 */
function renderPost(
  message: StarboardMessage,
  votes: number,
  link: string,
  text: string,
  image: string | undefined,
): Exclude<MessageBody, string> {
  const shortened = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return {
    embeds: [
      {
        author: { name: message.authorName, iconUrl: message.authorAvatar },
        description: `${shortened}\n\n[jump to message](${link})`,
        color: COLOR,
        image,
        timestamp: message.createdAt,
        footer: `${votes} ⭐`,
      },
    ],
  };
}
