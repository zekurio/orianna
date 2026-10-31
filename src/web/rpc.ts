import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { parseEmoji } from "../emoji.ts";

// The calls the app makes to the bot. handlers.ts implements them and
// app/api.ts calls them, both from these schemas, so the two sides agree on
// what goes over the wire and check it when it arrives.

/** The browser has no session, or it ran out. */
export class SignedOut extends Schema.TaggedError<SignedOut>()("SignedOut", {}) {}

/** The member signed in, but has left the guild since. */
export class NotMember extends Schema.TaggedError<NotMember>()("NotMember", {}) {}

/** The member making a call, for the handlers. */
export class CurrentMember extends Context.Service<
  CurrentMember,
  {
    readonly userId: string;
    /** The guild owner or a member with Administrator. */
    readonly admin: boolean;
  }
>()("orianna/web/CurrentMember") {}

/** Every call needs a member of the guild who is signed in. */
export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentMember }>()(
  "orianna/web/Authentication",
  { error: Schema.Union([SignedOut, NotMember]) },
) {}

export const Session = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    /** The display name, or the username without one. */
    name: Schema.String,
    /** The username, with the discriminator on instances that use them, like `orianna#0001`. */
    tag: Schema.String,
    avatarUrl: Schema.String,
  }),
  /** The guild owner or a member with Administrator, who may change the bot settings. */
  admin: Schema.Boolean,
  /** The member has `starboard.config`, so may change the starboard. */
  configStarboard: Schema.Boolean,
  /** What commands start with. */
  prefix: Schema.String,
  /**
   * Where the instance serves its pictures of Unicode emoji, as
   * `<emojiImages>/<codepoints>.svg`, the way Fluxer's own client draws them.
   */
  emojiImages: Schema.String,
});
export type Session = typeof Session.Type;

/** The bot won't do what the member asked, and says why. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

/** The starboard, when it's on and the member can see its channel. */
export const StarboardInfo = Schema.Struct({
  /** As a message has it: the Unicode emoji, or `<:name:id>`. */
  emoji: Schema.String,
  /** The picture of a custom emoji, null for a Unicode one. */
  emojiUrl: Schema.NullOr(Schema.String),
  channelId: Schema.String,
  channelName: Schema.String,
  threshold: Schema.Number,
  nsfw: Schema.Boolean,
});
export type StarboardInfo = typeof StarboardInfo.Type;

const Media = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["image", "video", "file"]),
  /** A blurred copy of an NSFW image. */
  blurred: Schema.optionalKey(Schema.Boolean),
  /** From a link in the text. */
  linked: Schema.optionalKey(Schema.Boolean),
});

/** A message in the starboard, as its post shows it. */
export const StarboardEntry = Schema.Struct({
  messageId: Schema.String,
  channelId: Schema.String,
  authorId: Schema.String,
  authorName: Schema.NullOr(Schema.String),
  authorAvatar: Schema.NullOr(Schema.String),
  /** Null until the bot catches up on a post from before it kept them. */
  content: Schema.NullOr(Schema.String),
  media: Schema.Array(Media),
  /** The votes, the author's own included. */
  score: Schema.Number,
  messageUrl: Schema.String,
});
export type StarboardEntry = typeof StarboardEntry.Type;

/** How many entries `starboardEntries` answers with at a time, as many as shinpuru loads. */
export const STARBOARD_PAGE_SIZE = 10;

export const StarboardSort = Schema.Literals(["latest", "top"]);
export type StarboardSort = typeof StarboardSort.Type;

/**
 * Names for the members and channels the entries mention, and pictures of
 * the custom emoji in them, by ID. A channel the member can't see has no name.
 */
const Names = Schema.Struct({
  users: Schema.Record(Schema.String, Schema.String),
  channels: Schema.Record(Schema.String, Schema.String),
  emojis: Schema.Record(Schema.String, Schema.String),
});
export type Names = typeof Names.Type;

/**
 * The starboard as members with `starboard.config` set it, like
 * `!starboard set`. The checks are the settings schema's, worded for the
 * form, which shows them under each field before it sends anything.
 */
export const StarboardInput = Schema.Struct({
  channelId: Schema.String.check(Schema.isPattern(/^[0-9]+$/, { message: "Pick a channel." })),
  threshold: Schema.Number.check(
    Schema.isInt({ message: "A whole number, 1 or more." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "A whole number, 1 or more." }),
  ),
  /** A Unicode emoji, or a custom one as `<:name:id>`. */
  emoji: Schema.String.check(
    Schema.isNonEmpty({ message: "Pick an emoji." }),
    Schema.makeFilter((emoji: string) => parseEmoji(emoji) !== undefined, { message: "That isn't an emoji." }),
  ),
});
export type StarboardInput = typeof StarboardInput.Type;

/** What the starboard settings form needs. */
export const StarboardSetup = Schema.Struct({
  /** As it's set now; `channelId` is null while the starboard is off. */
  config: Schema.Struct({
    channelId: Schema.NullOr(Schema.String),
    threshold: Schema.Number,
    emoji: Schema.String,
    emojiUrl: Schema.NullOr(Schema.String),
  }),
  /** Channels the starboard can go in, of those the member can see. */
  channels: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, nsfw: Schema.Boolean })),
  /** The server's custom emoji. */
  emojis: Schema.Array(Schema.Struct({ text: Schema.String, name: Schema.String, url: Schema.String })),
});
export type StarboardSetup = typeof StarboardSetup.Type;

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
  /** The starboard, null while it's off or its channel is hidden from the member. */
  Rpc.make("starboard", { success: Schema.NullOr(StarboardInfo) }),
  /** A page of the starboard's entries, and how many there are. */
  Rpc.make("starboardEntries", {
    payload: { sort: StarboardSort, offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
    success: Schema.Struct({ entries: Schema.Array(StarboardEntry), total: Schema.Number, names: Names }),
  }),
  /** Whether the member opted out from the starboard, like `!starboard optout`. */
  Rpc.make("starboardOptOut", { success: Schema.Boolean }),
  /**
   * Opts the member out from the starboard, or back in, like
   * `!starboard optout` and `optin`. Answers how many posts came down.
   */
  Rpc.make("setStarboardOptOut", { payload: { optedOut: Schema.Boolean }, success: Schema.Number }),
  /** The Unicode emoji, in Fluxer's categories, for the emoji picker. */
  Rpc.make("unicodeEmoji", { success: Schema.Array(EmojiCategory) }),
  /** The starboard settings, for members with `starboard.config`. */
  Rpc.make("starboardSetup", { success: StarboardSetup, error: Refused }),
  /** Sets the starboard, like `!starboard set`. */
  Rpc.make("setStarboard", { payload: { starboard: StarboardInput }, error: Refused }),
  /** Disables the starboard, like `!starboard disable`. */
  Rpc.make("disableStarboard", { error: Refused }),
).middleware(Authentication);

/**
 * Why a sign-in failed, in the `error` query parameter the callback sends the
 * browser back to the app with.
 */
export const SignInError = Schema.Literals(["denied", "expired", "failed", "not-member"]);
export type SignInError = typeof SignInError.Type;
