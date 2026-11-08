import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

// The calls the app makes to the bot. handlers.ts implements them and
// app/api.ts calls them, both from these schemas, so the two sides agree on
// what goes over the wire and check it when it arrives.

/** The browser has no session, or it ran out. */
export class SignedOut extends Schema.TaggedError<SignedOut>()("SignedOut", {}) {}

/** The call is about a guild the member isn't in, or the bot isn't in anymore. */
export class NotMember extends Schema.TaggedError<NotMember>()("NotMember", {}) {}

/** Who's making a call, for the handlers. */
export class CurrentMember extends Context.Service<
  CurrentMember,
  {
    readonly userId: string;
    /** The guild a call is about, from its `guildId`; unset for calls about no guild. */
    readonly guild:
      | {
          readonly id: string;
          /** The guild owner or a member with Administrator. */
          readonly admin: boolean;
        }
      | undefined;
  }
>()("orianna/web/CurrentMember") {}

/**
 * Every call needs someone signed in. A call with a `guildId` in its payload
 * is about that guild, and needs them to be a member of it.
 */
export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentMember }>()(
  "orianna/web/Authentication",
  { error: Schema.Union([SignedOut, NotMember]) },
) {}

/** Logs each call, what came of it and how long it took. Only the bot has it. */
export class CallLog extends RpcMiddleware.Service<CallLog>()("orianna/web/CallLog") {}

/** Which guild a call is about. */
const GuildId = Schema.String.check(Schema.isPattern(/^[0-9]+$/));

/** A guild the bot and the member are both in, and what the member may do there. */
export const GuildInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  iconUrl: Schema.NullOr(Schema.String),
  /** The guild owner or a member with Administrator, who may change the bot settings. */
  admin: Schema.Boolean,
  /** The member has `karma.config` there, so may change karma. */
  configKarma: Schema.Boolean,
  /** What commands start with there. */
  prefix: Schema.String,
});
export type GuildInfo = typeof GuildInfo.Type;

export const Session = Schema.Struct({
  /** The guilds the bot and the member share, by name. */
  guilds: Schema.Array(GuildInfo),
  user: Schema.Struct({
    id: Schema.String,
    /** The display name, or the username without one. */
    name: Schema.String,
    /** The username, with the discriminator on instances that use them, like `orianna#0001`. */
    tag: Schema.String,
    avatarUrl: Schema.String,
  }),
  /**
   * Where the instance serves its pictures of Unicode emoji, as
   * `<emojiImages>/<codepoints>.svg`, the way Fluxer's own client draws them.
   */
  emojiImages: Schema.String,
});
export type Session = typeof Session.Type;

/** The bot won't do what the member asked, and says why. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

/** An emoji as the app draws it: the Unicode emoji, or `<:name:id>` with its picture. */
const EmojiInfo = Schema.Struct({ emoji: Schema.String, url: Schema.NullOr(Schema.String) });
export type EmojiInfo = typeof EmojiInfo.Type;

/** A member on the karma scoreboard. */
export const KarmaEntry = Schema.Struct({
  /** Their place, shared with those who have as much: 1, 1, 3. */
  rank: Schema.Number,
  userId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.String,
  value: Schema.Number,
});
export type KarmaEntry = typeof KarmaEntry.Type;

/** The karma scoreboard while karma is on. */
export const KarmaBoard = Schema.Struct({
  /** Most karma first, members who left aside. */
  top: Schema.Array(KarmaEntry),
});
export type KarmaBoard = typeof KarmaBoard.Type;

const GuildSummary = Schema.Struct({ id: Schema.String, name: Schema.String, iconUrl: Schema.NullOr(Schema.String) });

/** The member's karma in a guild where it's on, and how voting goes there. */
export const KarmaStanding = Schema.Struct({
  guild: GuildSummary,
  own: Schema.Number,
  /** Their place on the scoreboard; null at 0 karma, where nobody has one. */
  rank: Schema.NullOr(Schema.Number),
  upvotes: Schema.Array(EmojiInfo),
  downvotes: Schema.Array(EmojiInfo),
  votesPerHour: Schema.Number,
  /** How many of {@link votesPerHour} the member has left right now. */
  votesLeft: Schema.Number,
  /** With none left, when the next one comes back, in ms since the epoch. */
  nextVoteAt: Schema.NullOr(Schema.Number),
  /** The member is on the blocklist, so their votes don't count. */
  blocked: Schema.Boolean,
  penalty: Schema.Boolean,
});
export type KarmaStanding = typeof KarmaStanding.Type;

/** The member's karma in a guild where it's off, kept for when it's back on. */
export const KarmaOff = Schema.Struct({ guild: GuildSummary, own: Schema.Number, off: Schema.Literal(true) });
export type KarmaOff = typeof KarmaOff.Type;

const KarmaRuleInput = Schema.Struct({
  when: Schema.Literals(["above", "below"]),
  value: Schema.Number.check(Schema.isInt({ message: "A whole number." })),
  action: Schema.Literals(["role", "message", "kick", "ban"]),
  roleId: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
export type KarmaRuleInput = typeof KarmaRuleInput.Type;

/**
 * Karma as members with `karma.config` set it: the `karma` section of the
 * settings. The form checks the numbers before it sends anything; the bot
 * checks the rest with the settings, and its problems come back with their
 * paths, like `/karma/upvotes/0: …`.
 */
export const KarmaInput = Schema.Struct({
  upvotes: Schema.Array(Schema.String),
  downvotes: Schema.Array(Schema.String),
  votesPerHour: Schema.Number.check(
    Schema.isInt({ message: "A whole number, 1 or more." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "A whole number, 1 or more." }),
  ),
  penalty: Schema.Boolean,
  /** User IDs. */
  blocklist: Schema.Array(Schema.String),
  rules: Schema.Array(KarmaRuleInput),
});
export type KarmaInput = typeof KarmaInput.Type;

/** What the karma settings form needs. */
export const KarmaSetup = Schema.Struct({
  on: Schema.Boolean,
  /** As it's set now, or what turning it on starts with. */
  config: KarmaInput,
  /** Names of the blocked members still in the server, by user ID. */
  blocked: Schema.Record(Schema.String, Schema.String),
  /** Roles, highest first, @everyone left out. */
  roles: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** The server's custom emoji. */
  emojis: Schema.Array(Schema.Struct({ text: Schema.String, name: Schema.String, url: Schema.String })),
});
export type KarmaSetup = typeof KarmaSetup.Type;

/**
 * The settings didn't validate, one line per problem, each starting with its
 * path in the settings, like `/polls/defaultHours: Expected …`.
 */
export class SettingsRejected extends Schema.TaggedError<SettingsRejected>()("SettingsRejected", {
  problems: Schema.Array(Schema.String),
}) {}

/** What the Admin tab needs to show and change the bot settings. */
export const AdminSetup = Schema.Struct({
  /**
   * The bot settings with defaults filled in, as `!settings export` gives
   * them. The settings schema in src/config.ts says what's in them; the bot
   * checks them again on every change.
   */
  settings: Schema.Unknown,
  /** Text channels, in the order the client lists them. */
  channels: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, nsfw: Schema.Boolean })),
  /** Roles, highest first, @everyone left out. */
  roles: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.Number })),
  /** The server's custom emoji. */
  emojis: Schema.Array(Schema.Struct({ text: Schema.String, name: Schema.String, url: Schema.String })),
  /** Every permission a rule can name. */
  permissions: Schema.Array(Schema.String),
});
export type AdminSetup = typeof AdminSetup.Type;

/** A change to the bot settings, as `!settings log` lists it. */
export const SettingsChangeInfo = Schema.Struct({
  /** In milliseconds since 1970. */
  at: Schema.Number,
  /** Null when the bot stored the first settings itself. */
  by: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
  source: Schema.Literals(["defaults", "command"]),
  sections: Schema.Array(Schema.String),
});
export type SettingsChangeInfo = typeof SettingsChangeInfo.Type;

/** A command option, as `!help` shows it. */
const CommandOption = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Like `<name>`, `[reason...]` or `<image: attachment or link>`. */
  usage: Schema.String,
});

/** A command the member may run. */
export const CommandInfo = Schema.Struct({
  /** What goes after the prefix, like `karma set`. */
  name: Schema.String,
  /** One line, like `!help` lists it. */
  description: Schema.String,
  /** What `!help <command>` adds to the description; null when nothing. */
  details: Schema.NullOr(Schema.String),
  /** The options in the order they're given, as `!help` shows them. */
  usage: Schema.String,
  options: Schema.Array(CommandOption),
  /** The permission it takes, null when everyone may run it. */
  permission: Schema.NullOr(Schema.String),
  /** Only the guild owner and members with Administrator may run it. */
  adminOnly: Schema.Boolean,
});
export type CommandInfo = typeof CommandInfo.Type;

/** A feature's commands, like karma's, or the general ones. */
export const CommandSection = Schema.Struct({
  /** Like `Karma`, `Polls` or `General`. */
  title: Schema.String,
  commands: Schema.Array(CommandInfo),
});
export type CommandSection = typeof CommandSection.Type;

/** A Unicode emoji for the picker, named the way Fluxer names it. */
export const UnicodeEmoji = Schema.Struct({
  unicode: Schema.String,
  /** Without the colons, like `star`. */
  name: Schema.String,
  /** Every name and keyword it can be found by, in lowercase. */
  terms: Schema.Array(Schema.String),
});
export type UnicodeEmoji = typeof UnicodeEmoji.Type;

/** One of Fluxer's emoji categories, like People or Food. */
export const EmojiCategory = Schema.Struct({ label: Schema.String, emojis: Schema.Array(UnicodeEmoji) });
export type EmojiCategory = typeof EmojiCategory.Type;

export const WebRpcs = RpcGroup.make(
  /** Who is signed in, and what the app needs to show them. */
  Rpc.make("session", { success: Session }),
  /** The commands the member may run, like `!help` lists them, in the order the bot has them. */
  Rpc.make("commands", { payload: { guildId: GuildId }, success: Schema.Array(CommandSection) }),
  /** The bot settings and what they can name, for the Admin tab. */
  Rpc.make("adminSetup", { payload: { guildId: GuildId }, success: AdminSetup, error: Refused }),
  /**
   * Replaces the given sections of the bot settings, and removes those given
   * as null, leaving the rest as it is. Answers the sections that changed.
   */
  Rpc.make("saveSettings", {
    payload: { guildId: GuildId, sections: Schema.Record(Schema.String, Schema.Unknown) },
    success: Schema.Array(Schema.String),
    error: Schema.Union([Refused, SettingsRejected]),
  }),
  /** Replaces all bot settings, like `!settings import`. Answers the sections that changed. */
  Rpc.make("importSettings", {
    payload: { guildId: GuildId, document: Schema.Unknown },
    success: Schema.Array(Schema.String),
    error: Schema.Union([Refused, SettingsRejected]),
  }),
  /** The latest changes to the bot settings, newest first, like `!settings log`. */
  Rpc.make("settingsLog", {
    payload: { guildId: GuildId },
    success: Schema.Array(SettingsChangeInfo),
    error: Refused,
  }),
  /** The Unicode emoji, in Fluxer's categories, for the emoji picker. */
  Rpc.make("unicodeEmoji", { success: Schema.Array(EmojiCategory) }),
  /** The karma scoreboard, null while karma is off. */
  Rpc.make("karma", { payload: { guildId: GuildId }, success: Schema.NullOr(KarmaBoard) }),
  /** Members with karma whose names match `query`, most karma first. */
  Rpc.make("karmaSearch", {
    payload: { guildId: GuildId, query: Schema.String.check(Schema.isMaxLength(100)) },
    success: Schema.Array(KarmaEntry),
  }),
  /** The member's karma in each guild they share with the bot, by guild name. */
  Rpc.make("myKarma", { success: Schema.Array(Schema.Union([KarmaStanding, KarmaOff])) }),
  /** The karma settings, for members with `karma.config`. */
  Rpc.make("karmaSetup", { payload: { guildId: GuildId }, success: KarmaSetup, error: Refused }),
  /** Turns karma on with these settings, or changes them. */
  Rpc.make("setKarma", {
    payload: { guildId: GuildId, karma: KarmaInput },
    error: Schema.Union([Refused, SettingsRejected]),
  }),
  /** Turns karma off. Members keep their karma for when it's back on. */
  Rpc.make("disableKarma", { payload: { guildId: GuildId }, error: Refused }),
)
  .middleware(Authentication)
  // The last middleware runs first, so calls that don't get past
  // Authentication are logged too.
  .middleware(CallLog);

/**
 * Why a sign-in failed, in the `error` query parameter the callback sends the
 * browser back to the app with.
 */
export const SignInError = Schema.Literals(["denied", "expired", "failed"]);
export type SignInError = typeof SignInError.Type;
