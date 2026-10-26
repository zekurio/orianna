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
    /** Kept so the expression can be created even if the original message is gone. */
    image: blob({ mode: "buffer" }).notNull(),
    contentType: text().notNull(),
    proposerId: text().notNull(),
    /** Non-bot members who could see the vote channel when the proposal was made. */
    requiredYes: integer().notNull().default(1),
    status: text({ enum: ["pending", "added", "rejected", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    /** Set when an admin decides before the vote ends. */
    decision: text({ enum: ["approve", "reject"] }),
    decidedBy: text(),
    reason: text(),
    /** The created emoji or sticker. */
    expressionId: text(),
    error: text(),
  },
  (t) => [index("proposals_type_status_idx").on(t.type, t.status)],
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
