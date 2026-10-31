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

export const WebRpcs = RpcGroup.make(
  /** Who is signed in, and what the app needs to show them. */
  Rpc.make("session", { success: Session }),
).middleware(Authentication);

/**
 * Why a sign-in failed, in the `error` query parameter the callback sends the
 * browser back to the app with.
 */
export const SignInError = Schema.Literals(["denied", "expired", "failed", "not-member"]);
export type SignInError = typeof SignInError.Type;
