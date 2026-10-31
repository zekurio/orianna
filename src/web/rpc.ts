import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

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
  /** What commands start with. */
  prefix: Schema.String,
});
export type Session = typeof Session.Type;

/** The bot won't do what the member asked, and says why. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

/** A board the member can see. */
export const Board = Schema.Struct({
  name: Schema.String,
  /** As a message has it: the Unicode emoji, or `<:name:id>`. */
  emoji: Schema.String,
  /** The picture of a custom emoji, null for a Unicode one. */
  emojiUrl: Schema.NullOr(Schema.String),
  channelId: Schema.String,
  channelName: Schema.String,
  threshold: Schema.Number,
  keep: Schema.Boolean,
  nsfw: Schema.Boolean,
});
export type Board = typeof Board.Type;

const Media = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["image", "video", "file"]),
  /** A blurred copy of an NSFW image. */
  blurred: Schema.optionalKey(Schema.Boolean),
  /** From a link in the text. */
  linked: Schema.optionalKey(Schema.Boolean),
});

/** A message on a board, as its post shows it. */
export const BoardPost = Schema.Struct({
  messageId: Schema.String,
  postId: Schema.String,
  channelId: Schema.String,
  authorId: Schema.String,
  authorName: Schema.NullOr(Schema.String),
  authorAvatar: Schema.NullOr(Schema.String),
  /** Null until the bot catches up on a post from before it kept them. */
  content: Schema.NullOr(Schema.String),
  media: Schema.Array(Media),
  /** Members other than the author who reacted. */
  count: Schema.Number,
  /** In milliseconds since 1970, like `Date.now()`. */
  sentAt: Schema.NullOr(Schema.Number),
  postedAt: Schema.Number,
  messageUrl: Schema.String,
  postUrl: Schema.String,
});
export type BoardPost = typeof BoardPost.Type;

/** How many posts `boardPosts` answers with at a time. */
export const BOARD_PAGE_SIZE = 20;

export const PostSort = Schema.Literals(["latest", "top"]);
export type PostSort = typeof PostSort.Type;

/**
 * Names for the members and channels the posts mention, and pictures of the
 * custom emoji in them, by ID. A channel the member can't see has no name.
 */
const Names = Schema.Struct({
  users: Schema.Record(Schema.String, Schema.String),
  channels: Schema.Record(Schema.String, Schema.String),
  emojis: Schema.Record(Schema.String, Schema.String),
});
export type Names = typeof Names.Type;

/** A member on a board's leaderboard. */
export const Leader = Schema.Struct({
  userId: Schema.String,
  /** Null when none of their posts says. */
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  posts: Schema.Number,
  reactions: Schema.Number,
});
export type Leader = typeof Leader.Type;

export const WebRpcs = RpcGroup.make(
  /** Who is signed in, and what the app needs to show them. */
  Rpc.make("session", { success: Session }),
  /** The boards whose channels the member can see, in the order of the settings. */
  Rpc.make("boards", {
    success: Schema.Struct({
      boards: Schema.Array(Board),
      /** The member has `boards.remove`. */
      canRemove: Schema.Boolean,
    }),
  }),
  /** A page of a board's posts, and how many there are. */
  Rpc.make("boardPosts", {
    payload: { board: Schema.String, sort: PostSort, offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
    success: Schema.Struct({ posts: Schema.Array(BoardPost), total: Schema.Number, names: Names }),
    error: Refused,
  }),
  /** The members with the most posts on a board, like `!board top`. */
  Rpc.make("boardTop", { payload: { board: Schema.String }, success: Schema.Array(Leader), error: Refused }),
  /** Takes a message off a board for good, like `!board remove` with a link to its post. */
  Rpc.make("removeFromBoard", { payload: { board: Schema.String, postId: Schema.String }, error: Refused }),
).middleware(Authentication);

/**
 * Why a sign-in failed, in the `error` query parameter the callback sends the
 * browser back to the app with.
 */
export const SignInError = Schema.Literals(["denied", "expired", "failed", "not-member"]);
export type SignInError = typeof SignInError.Type;
