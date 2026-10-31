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
    /** What users see and type, e.g. `green-panther`. Never reused. */
    slug: text().notNull(),
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
    uniqueIndex("polls_slug_idx").on(t.slug),
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

export const proposals = sqliteTable(
  "proposals",
  {
    /** Proposals share their poll's id; users refer to them by the poll's slug. */
    pollId: integer()
      .primaryKey()
      .references(() => polls.id, { onDelete: "cascade" }),
    type: text({ enum: ["emoji", "sticker"] }).notNull(),
    name: text().notNull(),
    /** Stickers only. */
    description: text(),
    /** Stickers only. */
    tags: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    proposerId: text().notNull(),
    /**
     * Yes votes needed, worked out from the config's `threshold` and the
     * non-bot members who could see the polls channel when the proposal was made.
     */
    requiredYes: integer().notNull().default(1),
    status: text({ enum: ["pending", "added", "rejected", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    /** Set when someone decides before the vote ends. */
    decision: text({ enum: ["approve", "reject"] }),
    decidedBy: text(),
    reason: text(),
    error: text(),
  },
  (t) => [index("proposals_type_status_idx").on(t.type, t.status)],
);

/**
 * What a proposal adds: one image, or the pieces of a wide or tall image, each
 * of which becomes its own emoji or sticker.
 */
export const proposalImages = sqliteTable(
  "proposal_images",
  {
    pollId: integer()
      .notNull()
      .references(() => proposals.pollId, { onDelete: "cascade" }),
    /** Left to right, or top to bottom. */
    position: integer().notNull(),
    /** Of the emoji or sticker it becomes. */
    name: text().notNull(),
    /** Kept so the expression can be created even if the original message is gone. */
    image: blob({ mode: "buffer" }).notNull(),
    contentType: text().notNull(),
    /** The created emoji or sticker. */
    expressionId: text(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.position] })],
);

export const roleMenus = sqliteTable(
  "role_menus",
  {
    /** The menu's `name` in the config. */
    name: text().primaryKey(),
    channelId: text().notNull(),
    messageId: text().notNull(),
    /** JSON of the body last posted, so an unchanged menu isn't edited. */
    rendered: text().notNull(),
  },
  (t) => [uniqueIndex("role_menus_message_id_idx").on(t.messageId)],
);

/**
 * Reactions the bot gave a role for. Comparing these with the reactions on the
 * message shows what changed while the bot was offline, without handing back
 * roles that were taken away some other way.
 */
export const roleMenuReactions = sqliteTable(
  "role_menu_reactions",
  {
    menu: text()
      .notNull()
      .references(() => roleMenus.name, { onDelete: "cascade" }),
    roleId: text().notNull(),
    userId: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.menu, t.roleId, t.userId] }),
    index("role_menu_reactions_user_id_idx").on(t.userId),
  ],
);

/**
 * Messages that made it onto a board. A row goes when its post is taken down
 * because reactions dropped, and stays as `removed` when a moderator took it off.
 */
export const boardEntries = sqliteTable(
  "board_entries",
  {
    messageId: text().notNull(),
    /** The board's `name` in the config. */
    board: text().notNull(),
    channelId: text().notNull(),
    authorId: text().notNull(),
    /** The bot's post. Null once a moderator took the message off. */
    postChannelId: text(),
    postId: text(),
    /** Members other than the author who reacted, as of the last update. */
    count: integer().notNull(),
    /** A moderator took the message off, so it doesn't go up again. */
    removed: integer({ mode: "boolean" }).notNull().default(false),
    postedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.board] }),
    uniqueIndex("board_entries_post_id_idx").on(t.postId),
    index("board_entries_board_author_id_idx").on(t.board, t.authorId),
  ],
);

/** Members whose messages never go on a board. */
export const boardOptOuts = sqliteTable("board_opt_outs", {
  userId: text().primaryKey(),
  optedOutAt: integer({ mode: "timestamp_ms" }).notNull(),
});
