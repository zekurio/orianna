import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Column names are derived from the keys with `casing: "snake_case"`, which is
// set both here (drizzle.config.ts) and at runtime (db/index.ts).

export type PollOption = {
  /** Stable identifier stored on votes. */
  key: string;
  /** Unicode emoji, or `name:id` for a custom one. */
  emoji: string;
  label: string;
};

export const polls = sqliteTable(
  "polls",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    /** Selects the close handler, e.g. "emoji-proposal". */
    kind: text().notNull(),
    guildId: text().notNull(),
    channelId: text().notNull(),
    /** Null until the poll message has been posted. */
    messageId: text(),
    question: text().notNull(),
    description: text(),
    options: text({ mode: "json" }).$type<PollOption[]>().notNull(),
    mode: text({ enum: ["single", "multi"] }).notNull(),
    /** open → closed → resolved once the handler succeeded; or open → cancelled. */
    status: text({ enum: ["open", "closed", "resolved", "cancelled"] })
      .notNull()
      .default("open"),
    createdBy: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    closesAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("polls_message_id_idx").on(t.messageId),
    index("polls_status_closes_at_idx").on(t.status, t.closesAt),
  ],
);

export const votes = sqliteTable(
  "votes",
  {
    pollId: integer()
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    optionKey: text().notNull(),
    votedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  // Single-choice polls are enforced by the poll service, not the key.
  (t) => [primaryKey({ columns: [t.pollId, t.userId, t.optionKey] })],
);

export const emojiProposals = sqliteTable(
  "emoji_proposals",
  {
    /** Proposals share their poll's id, which is also what users type. */
    pollId: integer()
      .primaryKey()
      .references(() => polls.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Kept so the emoji can be created even if the original message is gone. */
    image: blob({ mode: "buffer" }).notNull(),
    contentType: text().notNull(),
    proposerId: text().notNull(),
    status: text({ enum: ["pending", "added", "rejected", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    /** Set when an admin decides before the vote ends. */
    decision: text({ enum: ["approve", "reject"] }),
    decidedBy: text(),
    reason: text(),
    emojiId: text(),
    error: text(),
  },
  (t) => [index("emoji_proposals_status_idx").on(t.status)],
);
