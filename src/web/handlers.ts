import { Effect, Layer, Option } from "effect";
import { Headers } from "effect/http";
import { Fluxer, logFailure, request } from "../fluxer.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { Authentication, CurrentMember, NotMember, SignedOut, WebRpcs } from "./rpc.ts";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";

// The server side of the calls in rpc.ts. A failure a member should read is
// one of the errors in the schemas. Anything else is logged, and the app only
// learns that something went wrong, without the details.

const PROBLEM = "The bot ran into a problem. Its log says what happened.";

/** Logs why `what` failed and hands the app nothing but {@link PROBLEM}. */
const hide =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catchCause(effect, (cause) => logFailure(what)(cause).pipe(Effect.andThen(Effect.die(PROBLEM))));

/** Finds the member by the session cookie, and checks they're still in the guild. */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const access = yield* GuildAccess;

    return (effect, { headers }) =>
      Effect.gen(function* () {
        const cookies = new Bun.CookieMap(Option.getOrElse(Headers.get(headers, "cookie"), () => ""));
        const token = cookies.get(SESSION_COOKIE);
        const userId = token ? yield* sessions.find(token) : undefined;
        if (!userId) return yield* new SignedOut();

        const permissions = yield* access.permissionsOf(userId).pipe(
          Effect.catchTag("UserError", () => Effect.succeed(undefined)),
          hide("checking who's signed in"),
        );
        if (!permissions) return yield* new NotMember();
        return yield* Effect.provideService(effect, CurrentMember, {
          userId,
          admin: permissions.bypass !== null,
        });
      });
  }),
);

export const HandlersLive = WebRpcs.toLayer(
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const settings = yield* Settings;

    return {
      session: () =>
        Effect.gen(function* () {
          const { userId, admin } = yield* CurrentMember;
          const user = yield* request("fetching a user", () => client.users.fetch(userId));
          const { prefix } = yield* settings.get;
          return {
            user: {
              id: user.id,
              name: user.globalName ?? user.username,
              tag: tagOf(user),
              avatarUrl: user.displayAvatarURL({ size: 64 }),
            },
            admin,
            prefix,
          };
        }).pipe(hide("loading the session")),
    };
  }),
);

/**
 * `name#0001`, or the bare username. An instance can make usernames unique
 * instead, and then every discriminator is zeros.
 */
function tagOf({ username, discriminator }: { username: string; discriminator: string }): string {
  return /^0*$/.test(discriminator) ? username : `${username}#${discriminator}`;
}
