import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { type PollOption, polls, votes } from "../db/schema.ts";
import { emojiKey, type ReactionEmoji, reactionKey } from "../emoji.ts";
import type { ReactionListener } from "../reactions.ts";
import type { PollFile, PollTransport } from "./transport.ts";
import { normalizeSlug, pickSlug, randomSlug } from "./slug.ts";

export type Poll = typeof polls.$inferSelect;

/** Votes per option key, plus the number of distinct voters. */
export interface Tally {
  counts: Record<string, number>;
  voters: number;
}

export interface PollHandler {
  /**
   * Called after a poll of this kind closes. Throwing leaves the poll closed
   * and it is retried, so this must be safe to run more than once.
   */
  onClose(poll: Poll, tally: Tally): Promise<void>;
  /**
   * Checked after votes change on an open poll. Returning true closes the
   * poll right away instead of waiting for its deadline.
   */
  isDecided?(poll: Poll, tally: Tally): boolean;
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
}

export interface PollServiceOptions {
  now?: () => number;
  /** Delay before retrying handlers that threw. */
  retryMs?: number;
  /** Generates candidate poll slugs. */
  slug?: () => string;
}

const MAX_TIMEOUT = 2 ** 31 - 1;

export class PollService implements ReactionListener {
  private readonly handlers = new Map<string, PollHandler>();
  private readonly resolving = new Set<number>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly slug: () => string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly transport: PollTransport,
    options: PollServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 60_000;
    this.slug = options.slug ?? randomSlug;
  }

  register(kind: string, handler: PollHandler) {
    if (this.handlers.has(kind)) throw new Error(`duplicate poll kind: ${kind}`);
    this.handlers.set(kind, handler);
  }

  get(id: number): Poll | undefined {
    return this.db.select().from(polls).where(eq(polls.id, id)).get();
  }

  bySlug(slug: string): Poll | undefined {
    return this.db.select().from(polls).where(eq(polls.slug, normalizeSlug(slug))).get();
  }

  /** Stores the poll, posts it, and seeds one reaction per option. */
  async create(input: CreatePollInput): Promise<Poll> {
    const keys = new Set(input.options.map((o) => o.key));
    if (input.options.length < 2 || keys.size !== input.options.length) {
      throw new Error("a poll needs at least two options with unique keys");
    }

    const inserted = this.db
      .insert(polls)
      .values({
        kind: input.kind,
        // Checked against every poll ever made, so a slug always means one poll.
        slug: pickSlug((slug) => this.bySlug(slug) !== undefined, this.slug),
        guildId: input.guildId,
        channelId: input.channelId,
        question: input.question,
        description: input.description,
        options: input.options,
        mode: input.mode,
        createdBy: input.createdBy,
        createdAt: new Date(this.now()),
        closesAt: input.closesAt,
      })
      .returning()
      .get();

    let messageId: string;
    try {
      messageId = await this.transport.post(
        inserted.channelId,
        renderPoll(inserted),
        input.files,
      );
    } catch (err) {
      this.db.delete(polls).where(eq(polls.id, inserted.id)).run();
      throw err;
    }

    const poll = this.db
      .update(polls)
      .set({ messageId })
      .where(eq(polls.id, inserted.id))
      .returning()
      .get()!;

    // Best effort: the poll is live once posted, and people can add the
    // reactions themselves if seeding fails.
    for (const option of poll.options) {
      await this.transport
        .react(poll.channelId, messageId, option.emoji)
        .catch((err) => console.warn(`poll ${poll.id}: could not add ${option.emoji}:`, err));
    }

    this.schedule();
    return poll;
  }

  tally(poll: Poll): Tally {
    const rows = this.db.select().from(votes).where(eq(votes.pollId, poll.id)).all();
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
  castVote(pollId: number, userId: string, optionKey: string): string[] | null {
    const poll = this.get(pollId);
    if (!poll || !this.acceptsVotes(poll)) return null;
    if (!poll.options.some((o) => o.key === optionKey)) return null;

    return this.db.transaction((tx) => {
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
      tx.insert(votes)
        .values({ pollId, userId, optionKey, votedAt: new Date(this.now()) })
        .onConflictDoNothing()
        .run();
      return replaced;
    });
  }

  removeVote(pollId: number, userId: string, optionKey?: string) {
    const poll = this.get(pollId);
    if (!poll || !this.acceptsVotes(poll)) return;

    const conditions = [eq(votes.pollId, pollId), eq(votes.userId, userId)];
    if (optionKey) conditions.push(eq(votes.optionKey, optionKey));
    this.db.delete(votes).where(and(...conditions)).run();
  }

  // Reaction adapter. Callers must filter out bot users, the bot included.

  async reactionAdded(messageId: string, userId: string, emoji: ReactionEmoji) {
    const poll = this.byMessage(messageId);
    const option = poll && findOption(poll, emoji);
    if (!poll || !option) return;

    const replaced = this.castVote(poll.id, userId, option.key);
    if (replaced === null) return;
    for (const key of replaced) {
      const old = poll.options.find((o) => o.key === key);
      if (!old) continue;
      await this.transport
        .removeReaction(poll.channelId, messageId, old.emoji, userId)
        .catch((err) => console.warn(`poll ${poll.id}: could not remove reaction:`, err));
    }
    await this.closeIfDecided(poll);
  }

  reactionRemoved(messageId: string, userId: string, emoji: ReactionEmoji) {
    const poll = this.byMessage(messageId);
    const option = poll && findOption(poll, emoji);
    if (poll && option) this.removeVote(poll.id, userId, option.key);
  }

  /** All reactions, or all reactions of one emoji, were cleared by a moderator. */
  reactionsCleared(messageId: string, emoji?: ReactionEmoji) {
    const poll = this.byMessage(messageId);
    if (!poll || !this.acceptsVotes(poll)) return;

    const conditions = [eq(votes.pollId, poll.id)];
    if (emoji) {
      const option = findOption(poll, emoji);
      if (!option) return;
      conditions.push(eq(votes.optionKey, option.key));
    }
    this.db.delete(votes).where(and(...conditions)).run();
  }

  /**
   * Rebuilds the votes of open polls from their reactions, picking up anything
   * that happened while the bot was offline.
   */
  async reconcile() {
    const open = this.db.select().from(polls).where(eq(polls.status, "open")).all();
    for (const poll of open) {
      if (!poll.messageId) continue;
      try {
        await this.reconcilePoll(poll, poll.messageId);
      } catch (err) {
        console.warn(`poll ${poll.id}: could not read reactions:`, err);
        continue;
      }
      // Votes cast while offline may already have decided it.
      await this.closeIfDecided(poll);
    }
  }

  /** Closes an open poll early when its handler says the outcome is settled. */
  private async closeIfDecided(poll: Poll) {
    const handler = this.handlers.get(poll.kind);
    if (!handler?.isDecided || !this.acceptsVotes(poll)) return;
    if (handler.isDecided(poll, this.tally(poll))) await this.close(poll.id);
  }

  private async reconcilePoll(poll: Poll, messageId: string) {
    const reacted = new Map<string, string[]>();
    for (const option of poll.options) {
      const users = await this.transport.reactionUsers(poll.channelId, messageId, option.emoji);
      for (const userId of users) {
        reacted.set(userId, [...(reacted.get(userId) ?? []), option.key]);
      }
    }

    const existing = this.db.select().from(votes).where(eq(votes.pollId, poll.id)).all();
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

    const now = new Date(this.now());
    this.db.transaction((tx) => {
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
  }

  /** Closes the poll now and runs its handler. Returns false if it was not open. */
  async close(pollId: number): Promise<boolean> {
    const poll = this.db
      .update(polls)
      .set({ status: "closed" })
      .where(and(eq(polls.id, pollId), eq(polls.status, "open")))
      .returning()
      .get();
    if (!poll) return false;

    if (poll.messageId) {
      await this.transport
        .edit(poll.channelId, poll.messageId, renderPoll(poll, this.tally(poll)))
        .catch((err) => console.warn(`poll ${poll.id}: could not edit message:`, err));
    }
    await this.resolve(poll);
    this.schedule();
    return true;
  }

  /** Cancels an open poll without running its handler. */
  async cancel(pollId: number): Promise<boolean> {
    const poll = this.db
      .update(polls)
      .set({ status: "cancelled" })
      .where(and(eq(polls.id, pollId), eq(polls.status, "open")))
      .returning()
      .get();
    if (!poll) return false;

    if (poll.messageId) {
      await this.transport
        .edit(poll.channelId, poll.messageId, renderPoll(poll))
        .catch((err) => console.warn(`poll ${poll.id}: could not edit message:`, err));
    }
    this.schedule();
    return true;
  }

  /** Closes every poll past its deadline and retries unresolved handlers. */
  async tick() {
    const due = this.db
      .select({ id: polls.id })
      .from(polls)
      .where(and(eq(polls.status, "open"), lte(polls.closesAt, new Date(this.now()))))
      .all();
    for (const { id } of due) await this.close(id);

    const pending = this.db.select().from(polls).where(eq(polls.status, "closed")).all();
    for (const poll of pending) await this.resolve(poll);
  }

  /**
   * Starts the close timer. Polls whose message was never posted (the bot died
   * mid-create) are dropped first.
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.db
      .delete(polls)
      .where(and(eq(polls.status, "open"), isNull(polls.messageId)))
      .run();
    void this.runTick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  private async runTick() {
    try {
      await this.tick();
    } catch (err) {
      console.error("poll tick failed:", err);
    }
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;

    const next = this.db
      .select({ closesAt: polls.closesAt })
      .from(polls)
      .where(eq(polls.status, "open"))
      .orderBy(asc(polls.closesAt))
      .limit(1)
      .get();
    const hasPending = this.db
      .select({ id: polls.id })
      .from(polls)
      .where(eq(polls.status, "closed"))
      .limit(1)
      .get();

    let delay = next ? next.closesAt.getTime() - this.now() : Infinity;
    if (hasPending) delay = Math.min(delay, this.retryMs);
    if (delay === Infinity) return;

    this.timer = setTimeout(() => void this.runTick(), Math.min(Math.max(delay, 0), MAX_TIMEOUT));
  }

  private async resolve(poll: Poll) {
    if (this.resolving.has(poll.id)) return;
    this.resolving.add(poll.id);
    try {
      const handler = this.handlers.get(poll.kind);
      if (handler) {
        await handler.onClose(poll, this.tally(poll));
      } else {
        console.warn(`poll ${poll.id}: no handler for kind ${poll.kind}`);
      }
      this.db.update(polls).set({ status: "resolved" }).where(eq(polls.id, poll.id)).run();
    } catch (err) {
      console.error(`poll ${poll.id}: handler failed, will retry:`, err);
    } finally {
      this.resolving.delete(poll.id);
    }
  }

  private byMessage(messageId: string): Poll | undefined {
    return this.db.select().from(polls).where(eq(polls.messageId, messageId)).get();
  }

  private acceptsVotes(poll: Poll): boolean {
    return poll.status === "open" && poll.closesAt.getTime() > this.now();
  }
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
