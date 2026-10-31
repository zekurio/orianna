import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { Cause, Clock, Context, Duration, Effect, FiberMap, FiberSet, Layer, Queue } from "effect";
import type { UserError } from "../commands/command.ts";
import { Database } from "../db/index.ts";
import { type PollOption, polls, votes } from "../db/schema.ts";
import { emojiKey, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import type { MessageBody } from "../messages/body.ts";
import type { ReactionListener } from "../reactions.ts";
import { type PollFile, PollTransport } from "./transport.ts";
import { normalizeSlug, pickSlug, randomSlug } from "./slug.ts";

export type Poll = typeof polls.$inferSelect;

/** Votes per option key, plus the number of distinct voters. */
export interface Tally {
  counts: Record<string, number>;
  voters: number;
}

export interface PollHandler {
  /**
   * Called after a poll of this kind closes. Failing leaves the poll closed
   * and it is retried, so this must be safe to run more than once.
   */
  onClose(poll: Poll, tally: Tally): Effect.Effect<void, FluxerError>;
  /**
   * Checked after votes change on an open poll. Returning true closes the
   * poll right away instead of waiting for its deadline.
   */
  isDecided?(poll: Poll, tally: Tally): boolean;
  /**
   * Renders the poll message. Polls of a kind with a renderer are also
   * re-rendered shortly after their votes change, so they can show live
   * results. Without one, {@link renderPoll} shows the counts once it closes.
   */
  render?(poll: Poll, tally: Tally): MessageBody;
  /**
   * Called when someone reacts to an open poll of this kind with an emoji that
   * isn't one of its options.
   */
  onOtherReaction?(poll: Poll, userId: string, emoji: ReactionEmoji): Effect.Effect<void, UserError | FluxerError>;
}

export interface CreatePollInput {
  kind: string;
  guildId: string;
  channelId: string;
  question: string;
  description?: string;
  options: PollOption[];
  mode: "single" | "multi";
  closesAt: Date;
  createdBy: string;
  files?: PollFile[];
  /**
   * Let `@everyone` and `@here` in the poll message notify people, e.g. an
   * `@here` in the description. Mentions of users and roles never do. Off by
   * default, since questions often come from users.
   */
  everyone?: boolean;
}

/** Delay before retrying handlers that failed. */
const RETRY_MS = 60_000;
/** How long votes are gathered before a live poll message is edited. */
const REFRESH = Duration.seconds(2);
/** Longest timer the runtime can set. */
const MAX_TIMEOUT = 2 ** 31 - 1;

const warn = (poll: { id: number }, what: string) => (err: FluxerError) =>
  Effect.logWarning(`poll ${poll.id}: ${what}: ${err.reason}`);

const makePollService = Effect.gen(function* () {
  const db = yield* Database;
  const transport = yield* PollTransport;
  const scope = yield* Effect.scope;

  const handlers = new Map<string, PollHandler>();
  const resolving = new Set<number>();
  /** Live polls whose votes changed since their message was last edited. */
  const stale = new Set<number>();
  /** Per live poll, the fiber that waits for votes to settle and edits the message. */
  const refreshers = yield* FiberMap.make<number>();
  /** Polls being closed or resolved by the close loop. */
  const closing = yield* FiberSet.make();
  /** Tells the close loop to look at the deadlines again. */
  const wake = yield* Queue.sliding<void>(1);
  let started = false;

  function register(kind: string, handler: PollHandler) {
    if (handlers.has(kind)) throw new Error(`duplicate poll kind: ${kind}`);
    handlers.set(kind, handler);
  }

  function get(id: number): Poll | undefined {
    return db.select().from(polls).where(eq(polls.id, id)).get();
  }

  function bySlug(slug: string): Poll | undefined {
    return db.select().from(polls).where(eq(polls.slug, normalizeSlug(slug))).get();
  }

  function byMessage(messageId: string): Poll | undefined {
    return db.select().from(polls).where(eq(polls.messageId, messageId)).get();
  }

  const schedule = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  /** Stores the poll, posts it, and seeds one reaction per option. */
  const create = Effect.fn("PollService.create")(function* (input: CreatePollInput) {
    const keys = new Set(input.options.map((o) => o.key));
    if (input.options.length < 2 || keys.size !== input.options.length) {
      return yield* Effect.die(new Error("a poll needs at least two options with unique keys"));
    }

    const inserted = db
      .insert(polls)
      .values({
        kind: input.kind,
        // Checked against every poll ever made, so a slug always means one poll.
        slug: pickSlug((slug) => bySlug(slug) !== undefined, randomSlug),
        guildId: input.guildId,
        channelId: input.channelId,
        question: input.question,
        description: input.description,
        options: input.options,
        mode: input.mode,
        createdBy: input.createdBy,
        createdAt: new Date(yield* Clock.currentTimeMillis),
        closesAt: input.closesAt,
      })
      .returning()
      .get();

    const messageId = yield* transport
      .post(inserted.channelId, body(inserted), { files: input.files, everyone: input.everyone })
      .pipe(Effect.onError(() => Effect.sync(() => db.delete(polls).where(eq(polls.id, inserted.id)).run())));

    const poll = db
      .update(polls)
      .set({ messageId })
      .where(eq(polls.id, inserted.id))
      .returning()
      .get()!;

    // Best effort: the poll is live once posted, and people can add the
    // reactions themselves if seeding fails.
    for (const option of poll.options) {
      yield* transport
        .react(poll.channelId, messageId, option.emoji)
        .pipe(Effect.catch(warn(poll, `could not add ${option.emoji}`)));
    }

    yield* schedule;
    return poll;
  });

  function tally(poll: Poll): Tally {
    const rows = db.select().from(votes).where(eq(votes.pollId, poll.id)).all();
    const counts = Object.fromEntries(poll.options.map((o) => [o.key, 0]));
    for (const row of rows) {
      if (row.optionKey in counts) counts[row.optionKey]!++;
    }
    return { counts, voters: new Set(rows.map((r) => r.userId)).size };
  }

  /**
   * Records a vote on an open poll. In single-choice polls this replaces the
   * user's other votes and returns the option keys that were dropped.
   */
  const castVote = Effect.fnUntraced(function* (pollId: number, userId: string, optionKey: string) {
    const poll = get(pollId);
    if (!poll || !(yield* acceptsVotes(poll))) return null;
    if (!poll.options.some((o) => o.key === optionKey)) return null;

    const now = new Date(yield* Clock.currentTimeMillis);
    return db.transaction((tx) => {
      let replaced: string[] = [];
      if (poll.mode === "single") {
        replaced = tx
          .delete(votes)
          .where(
            and(
              eq(votes.pollId, pollId),
              eq(votes.userId, userId),
              sql`${votes.optionKey} != ${optionKey}`,
            ),
          )
          .returning({ key: votes.optionKey })
          .all()
          .map((r) => r.key);
      }
      tx.insert(votes).values({ pollId, userId, optionKey, votedAt: now }).onConflictDoNothing().run();
      return replaced;
    });
  });

  const removeVote = Effect.fnUntraced(function* (pollId: number, userId: string, optionKey?: string) {
    const poll = get(pollId);
    if (!poll || !(yield* acceptsVotes(poll))) return;

    const conditions = [eq(votes.pollId, pollId), eq(votes.userId, userId)];
    if (optionKey) conditions.push(eq(votes.optionKey, optionKey));
    db.delete(votes).where(and(...conditions)).run();
  });

  // Reaction adapter. Callers must filter out bot users, the bot included.

  const reactionAdded = Effect.fnUntraced(function* (
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ) {
    const poll = byMessage(messageId);
    if (!poll) return;
    const option = findOption(poll, emoji);
    if (!option) {
      const onOther = handlers.get(poll.kind)?.onOtherReaction;
      if (poll.status === "open" && onOther) yield* onOther(poll, userId, emoji);
      return;
    }

    const replaced = yield* castVote(poll.id, userId, option.key);
    if (replaced === null) return;
    yield* refreshSoon(poll);
    for (const key of replaced) {
      const old = poll.options.find((o) => o.key === key);
      if (!old) continue;
      yield* transport
        .removeReaction(poll.channelId, messageId, old.emoji, userId)
        .pipe(Effect.catch(warn(poll, "could not remove reaction")));
    }
    yield* closeIfDecided(poll);
  });

  const reactionRemoved = Effect.fnUntraced(function* (
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ) {
    const poll = byMessage(messageId);
    const option = poll && findOption(poll, emoji);
    if (!poll || !option) return;
    yield* removeVote(poll.id, userId, option.key);
    yield* refreshSoon(poll);
  });

  /** All reactions, or all reactions of one emoji, were cleared by a moderator. */
  const reactionsCleared = Effect.fnUntraced(function* (messageId: string, emoji?: ReactionEmoji) {
    const poll = byMessage(messageId);
    if (!poll || !(yield* acceptsVotes(poll))) return;

    const conditions = [eq(votes.pollId, poll.id)];
    if (emoji) {
      const option = findOption(poll, emoji);
      if (!option) return;
      conditions.push(eq(votes.optionKey, option.key));
    }
    db.delete(votes).where(and(...conditions)).run();
    yield* refreshSoon(poll);
  });

  /**
   * Rebuilds the votes of open polls from their reactions, picking up anything
   * that happened while the bot was offline.
   */
  const reconcile = Effect.fn("PollService.reconcile")(function* () {
    const open = db.select().from(polls).where(eq(polls.status, "open")).all();
    for (const poll of open) {
      if (!poll.messageId) continue;
      const read = yield* reconcilePoll(poll, poll.messageId).pipe(
        Effect.as(true),
        Effect.catch((err) => warn(poll, "could not read reactions")(err).pipe(Effect.as(false))),
      );
      if (!read) continue;
      yield* refreshSoon(poll);
      // Votes cast while offline may already have decided it.
      yield* closeIfDecided(poll);
    }
  });

  /** Closes an open poll early when its handler says the outcome is settled. */
  const closeIfDecided = Effect.fnUntraced(function* (poll: Poll) {
    const handler = handlers.get(poll.kind);
    if (!handler?.isDecided || !(yield* acceptsVotes(poll))) return;
    if (handler.isDecided(poll, tally(poll))) yield* close(poll.id);
  });

  const reconcilePoll = Effect.fnUntraced(function* (poll: Poll, messageId: string) {
    const reacted = new Map<string, string[]>();
    for (const option of poll.options) {
      const users = yield* transport.reactionUsers(poll.channelId, messageId, option.emoji);
      for (const userId of users) {
        reacted.set(userId, [...(reacted.get(userId) ?? []), option.key]);
      }
    }

    const existing = db.select().from(votes).where(eq(votes.pollId, poll.id)).all();
    const wanted = new Set<string>();
    for (const [userId, keys] of reacted) {
      // Single choice with several reactions: keep the vote we already had.
      const kept =
        poll.mode === "single"
          ? [
              existing.find((v) => v.userId === userId && keys.includes(v.optionKey))
                ?.optionKey ?? keys[0]!,
            ]
          : keys;
      for (const key of kept) wanted.add(`${userId}\0${key}`);
    }

    const now = new Date(yield* Clock.currentTimeMillis);
    db.transaction((tx) => {
      for (const vote of existing) {
        if (!wanted.delete(`${vote.userId}\0${vote.optionKey}`)) {
          tx.delete(votes)
            .where(
              and(
                eq(votes.pollId, poll.id),
                eq(votes.userId, vote.userId),
                eq(votes.optionKey, vote.optionKey),
              ),
            )
            .run();
        }
      }
      for (const entry of wanted) {
        const [userId, optionKey] = entry.split("\0") as [string, string];
        tx.insert(votes).values({ pollId: poll.id, userId, optionKey, votedAt: now }).run();
      }
    });
  });

  /** Closes the poll now and runs its handler. Returns false if it was not open. */
  const close = Effect.fn("PollService.close")(function* (pollId: number) {
    const poll = db
      .update(polls)
      .set({ status: "closed" })
      .where(and(eq(polls.id, pollId), eq(polls.status, "open")))
      .returning()
      .get();
    if (!poll) return false;

    // Claimed until the handler has run, so a retry from the close loop
    // can't run it while the message is still being edited.
    resolving.add(poll.id);
    yield* Effect.gen(function* () {
      yield* settleRefresh(poll.id);
      if (poll.messageId) {
        yield* transport
          .edit(poll.channelId, poll.messageId, body(poll, tally(poll)))
          .pipe(Effect.catch(warn(poll, "could not edit message")));
      }
      yield* runHandler(poll);
    }).pipe(Effect.ensuring(Effect.sync(() => resolving.delete(poll.id))));
    yield* schedule;
    return true;
  });

  /**
   * Cancels an open poll without running its handler. Pass `messageDeleted`
   * when the poll message is gone, so it isn't edited.
   */
  const cancel = Effect.fn("PollService.cancel")(function* (
    pollId: number,
    { messageDeleted = false } = {},
  ) {
    const poll = db
      .update(polls)
      .set({ status: "cancelled" })
      .where(and(eq(polls.id, pollId), eq(polls.status, "open")))
      .returning()
      .get();
    if (!poll) return false;

    yield* settleRefresh(poll.id);
    if (poll.messageId && !messageDeleted) {
      yield* transport
        .edit(poll.channelId, poll.messageId, body(poll))
        .pipe(Effect.catch(warn(poll, "could not edit message")));
    }
    yield* schedule;
    return true;
  });

  /**
   * Closes every poll past its deadline and retries unresolved handlers. Each
   * runs in a fiber of its own, so a handler that's slow to finish doesn't
   * hold up the deadlines of other polls.
   */
  const tick = Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    // Read before closing, so a poll closed here is resolved by its own close
    // after the message edit, not by the retry.
    const pending = db.select().from(polls).where(eq(polls.status, "closed")).all();
    const due = db
      .select({ id: polls.id })
      .from(polls)
      .where(and(eq(polls.status, "open"), lte(polls.closesAt, now)))
      .all();
    for (const { id } of due) {
      yield* FiberSet.run(closing, close(id).pipe(Effect.catchCause(logFailure(`closing poll ${id}`))));
    }
    for (const poll of pending) yield* FiberSet.run(closing, resolve(poll));
  });

  /** Milliseconds until the next deadline, or until failed handlers are retried. */
  const nextDelay = Effect.gen(function* () {
    const next = db
      .select({ closesAt: polls.closesAt })
      .from(polls)
      .where(eq(polls.status, "open"))
      .orderBy(asc(polls.closesAt))
      .limit(1)
      .get();
    const hasPending = db
      .select({ id: polls.id })
      .from(polls)
      .where(eq(polls.status, "closed"))
      .limit(1)
      .get();

    let delay = next ? next.closesAt.getTime() - (yield* Clock.currentTimeMillis) : Infinity;
    if (hasPending) delay = Math.min(delay, RETRY_MS);
    return delay;
  });

  /** Ticks at every deadline. Creating or ending a poll wakes it to look again. */
  const closeLoop = Effect.gen(function* () {
    for (;;) {
      yield* tick.pipe(Effect.catchCause(logFailure("poll tick")));
      for (;;) {
        const delay = yield* nextDelay;
        const timer =
          delay === Infinity
            ? Effect.never
            : Effect.sleep(Duration.millis(Math.min(Math.max(delay, 0), MAX_TIMEOUT)));
        const due = yield* Effect.race(Effect.as(timer, true), Effect.as(Queue.take(wake), false));
        if (due) break;
      }
    }
  });

  /**
   * Starts closing polls at their deadlines, until the service is released.
   * Polls whose message was never posted (the bot died mid-create) are
   * dropped first.
   */
  const start = Effect.suspend(() => {
    if (started) return Effect.void;
    started = true;
    db.delete(polls)
      .where(and(eq(polls.status, "open"), isNull(polls.messageId)))
      .run();
    return Effect.asVoid(Effect.forkIn(closeLoop, scope));
  });

  /** Runs the handler of a closed poll nobody else is resolving. */
  function resolve(poll: Poll): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (resolving.has(poll.id)) return Effect.void;
      // `poll` may come from a list read earlier; it may be resolved by now.
      if (get(poll.id)?.status !== "closed") return Effect.void;
      resolving.add(poll.id);
      return runHandler(poll).pipe(Effect.ensuring(Effect.sync(() => resolving.delete(poll.id))));
    });
  }

  /** Runs the poll's handler and marks it resolved. Failures are logged and retried later. */
  function runHandler(poll: Poll): Effect.Effect<void> {
    return Effect.gen(function* () {
      const handler = handlers.get(poll.kind);
      if (handler) {
        yield* handler.onClose(poll, tally(poll));
      } else {
        yield* Effect.logWarning(`poll ${poll.id}: no handler for kind ${poll.kind}`);
      }
      db.update(polls).set({ status: "resolved" }).where(eq(polls.id, poll.id)).run();
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`poll ${poll.id}: handler failed, will retry`, cause),
      ),
    );
  }

  /** The poll message, from the kind's renderer when it has one. */
  function body(poll: Poll, pollTally?: Tally): MessageBody {
    const handler = handlers.get(poll.kind);
    if (handler?.render) return handler.render(poll, pollTally ?? tally(poll));
    return renderPoll(poll, pollTally);
  }

  /**
   * Re-renders a poll with live results once its votes have settled for a
   * moment, so a burst of reactions costs one edit.
   */
  function refreshSoon(poll: Poll): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (poll.status !== "open" || !handlers.get(poll.kind)?.render) return Effect.void;
      stale.add(poll.id);
      return Effect.asVoid(
        FiberMap.run(refreshers, poll.id, refresher(poll.id), { onlyIfMissing: true }),
      );
    });
  }

  /** Edits the message until no votes came in during the last edit. */
  function refresher(pollId: number) {
    return Effect.gen(function* () {
      while (stale.has(pollId)) {
        yield* Effect.sleep(REFRESH);
        stale.delete(pollId);
        // Uninterruptible, so settleRefresh waits for an edit on its way
        // instead of letting it land after the final one.
        yield* Effect.uninterruptible(refresh(pollId));
      }
    });
  }

  function refresh(pollId: number) {
    return Effect.gen(function* () {
      const poll = get(pollId);
      if (!poll?.messageId || poll.status !== "open") return;
      yield* transport.edit(poll.channelId, poll.messageId, body(poll));
    }).pipe(Effect.catch(warn({ id: pollId }, "could not update results")));
  }

  /** Drops a pending re-render and waits for one in flight, so it can't land last. */
  function settleRefresh(pollId: number) {
    return Effect.suspend(() => {
      stale.delete(pollId);
      return FiberMap.remove(refreshers, pollId);
    });
  }

  function acceptsVotes(poll: Poll) {
    return Clock.currentTimeMillis.pipe(
      Effect.map((now) => poll.status === "open" && poll.closesAt.getTime() > now),
    );
  }

  const service = {
    register,
    get,
    bySlug,
    byMessage,
    create,
    tally,
    castVote,
    removeVote,
    reactionAdded,
    reactionRemoved,
    reactionsCleared,
    reconcile,
    close,
    cancel,
    start,
  };
  return service satisfies ReactionListener<UserError | FluxerError>;
});

/** Stores polls, counts their votes and closes them on time. */
export class PollService extends Context.Service<PollService>()("orianna/PollService", {
  make: makePollService,
}) {
  static readonly layer = Layer.effect(PollService, makePollService);
}

/** Matches a reaction to an option. Custom emoji match by ID. */
export function findOption(poll: Poll, emoji: ReactionEmoji): PollOption | undefined {
  const reacted = reactionKey(emoji);
  if (!reacted) return undefined;
  return poll.options.find((o) => emojiKey(o.emoji) === reacted);
}

export function timestamp(date: Date, style: "R" | "f" = "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function renderPoll(poll: Poll, tally?: Tally): string {
  const state =
    poll.status === "cancelled" ? " (cancelled)" : poll.status === "open" ? "" : " (closed)";
  const lines = [`**${poll.question}**${state}`];
  if (poll.description) lines.push(poll.description);
  lines.push("");

  for (const option of poll.options) {
    const count = tally ? `: **${tally.counts[option.key] ?? 0}**` : "";
    lines.push(`${option.emoji} ${option.label}${count}`);
  }

  lines.push("");
  if (poll.status === "open") {
    const how = poll.mode === "single" ? "React to vote" : "React to vote, several choices allowed";
    lines.push(`${how}. Closes ${timestamp(poll.closesAt)}. Poll \`${poll.slug}\``);
  } else {
    lines.push(`Poll \`${poll.slug}\``);
  }
  return lines.join("\n");
}
