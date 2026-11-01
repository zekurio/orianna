import {
  blob,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Column names are derived from the keys with `casing: "snake_case"`, which is
// set both here (drizzle.config.ts) and at runtime (db/index.ts). The bot
// serves every guild it's in, so what belongs to a guild carries its ID.

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
    index("polls_guild_id_kind_idx").on(t.guildId, t.kind),
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
    /** The poll's, for counting a guild's open proposals. */
    guildId: text().notNull(),
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
  (t) => [index("proposals_guild_id_type_status_idx").on(t.guildId, t.type, t.status)],
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
    guildId: text().notNull(),
    /** The menu's `name` in the settings. */
    name: text().notNull(),
    channelId: text().notNull(),
    messageId: text().notNull(),
    /** JSON of the body last posted, so an unchanged menu isn't edited. */
    rendered: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.name] }), uniqueIndex("role_menus_message_id_idx").on(t.messageId)],
);

/**
 * Reactions the bot gave a role for. Comparing these with the reactions on the
 * message shows what changed while the bot was offline, without handing back
 * roles that were taken away some other way.
 */
export const roleMenuReactions = sqliteTable(
  "role_menu_reactions",
  {
    guildId: text().notNull(),
    menu: text().notNull(),
    roleId: text().notNull(),
    userId: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.menu, t.roleId, t.userId] }),
    foreignKey({ columns: [t.guildId, t.menu], foreignColumns: [roleMenus.guildId, roleMenus.name] }).onDelete(
      "cascade",
    ),
    index("role_menu_reactions_guild_id_user_id_idx").on(t.guildId, t.userId),
  ],
);

/** A file on a starboard post, as the web interface shows it. */
export type StarboardMedia = {
  url: string;
  name: string;
  kind: "image" | "video" | "file";
  /**
   * A blurred copy the bot uploaded with the post, of an NSFW image on a
   * starboard that isn't NSFW.
   */
  blurred?: boolean;
  /** An image from a link in the text, not a file on the message. */
  linked?: boolean;
};

/**
 * Messages that made it into the starboard. A row goes when its post is
 * taken down because votes dropped, and stays as `removed` when someone
 * deleted the post.
 */
export const starboardEntries = sqliteTable(
  "starboard_entries",
  {
    messageId: text().primaryKey(),
    guildId: text().notNull(),
    channelId: text().notNull(),
    authorId: text().notNull(),
    /** The bot's post. Null once someone deleted it. */
    postChannelId: text(),
    postId: text(),
    /** The votes, the author's own included, as of the last update. */
    count: integer().notNull(),
    /** Someone deleted the post, so the message doesn't go up again. */
    removed: integer({ mode: "boolean" }).notNull().default(false),
    postedAt: integer({ mode: "timestamp_ms" }).notNull(),
    /**
     * What the post shows of the message, as of the last update, for the web
     * interface. Null on entries from before the bot kept it, until it catches up.
     */
    content: text(),
    authorName: text(),
    authorAvatar: text(),
    media: text({ mode: "json" }).$type<StarboardMedia[]>(),
    /** When the message was sent. */
    sentAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("starboard_entries_post_id_idx").on(t.postId),
    index("starboard_entries_guild_id_author_id_idx").on(t.guildId, t.authorId),
    index("starboard_entries_guild_id_posted_at_idx").on(t.guildId, t.postedAt),
  ],
);

/** Members whose messages never go into the starboard, in any guild, as on shinpuru. */
export const starboardOptOuts = sqliteTable("starboard_opt_outs", {
  userId: text().primaryKey(),
  optedOutAt: integer({ mode: "timestamp_ms" }).notNull(),
});

/**
 * The bot settings, one JSON document per guild. The bot validates them when
 * it loads them; src/settings/settings.ts reads and writes them.
 */
export const settings = sqliteTable("settings", {
  guildId: text().primaryKey(),
  /** With defaults filled in, as of the last change. */
  document: text({ mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

/** Every change to the bot settings. */
export const settingsChanges = sqliteTable(
  "settings_changes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    guildId: text().notNull(),
    changedAt: integer({ mode: "timestamp_ms" }).notNull(),
    /** The member who made the change; null when the bot stored the first settings itself. */
    changedBy: text(),
    /** Where the settings came from: the defaults for a guild new to the bot, or a member's change. */
    source: text({ enum: ["defaults", "command"] }).notNull(),
    /** The top-level keys that changed. */
    sections: text({ mode: "json" }).$type<string[]>().notNull(),
    /**
     * Those keys before and after the change, with null for a section that was
     * missing. `before` is null for the first settings.
     */
    before: text({ mode: "json" }).$type<Record<string, unknown>>(),
    after: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("settings_changes_guild_id_idx").on(t.guildId)],
);

/** Members signed in to the web interface. */
export const webSessions = sqliteTable(
  "web_sessions",
  {
    /** SHA-256 of the session cookie, in hex, so the table alone can't sign anyone in. */
    tokenHash: text().primaryKey(),
    userId: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("web_sessions_expires_at_idx").on(t.expiresAt)],
);

/**
 * Images the web interface serves at `/imagestore/<id>.<ext>`, for embeds
 * to link to, like shinpuru's image store. src/imagestore.ts keeps them.
 */
export const storedImages = sqliteTable("stored_images", {
  /** Random, so nobody can guess the URL of an image they weren't shown. */
  id: text().primaryKey(),
  image: blob({ mode: "buffer" }).notNull(),
  contentType: text().notNull(),
  storedAt: integer({ mode: "timestamp_ms" }).notNull(),
});
