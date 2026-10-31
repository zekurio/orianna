import { eq, lt } from "drizzle-orm";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import { Database } from "../db/index.ts";
import { webSessions } from "../db/schema.ts";

/** The cookie that holds a member's session token. */
export const SESSION_COOKIE = "orianna_session";
/** How long a member stays signed in. */
export const SESSION_TTL = Duration.days(30);

/** Who is signed in to the web interface, by the token in their session cookie. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** Signs `userId` in and returns the token for the cookie. */
    readonly create: (userId: string) => Effect.Effect<string>;
    /** The user a token signs in, unless it's unknown or expired. */
    readonly find: (token: string) => Effect.Effect<string | undefined>;
    readonly remove: (token: string) => Effect.Effect<void>;
  }
>()("orianna/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const db = yield* Database;

      return {
        create: (userId) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const token = randomToken();
            // Expired sessions go whenever someone signs in, which keeps the table small.
            db.delete(webSessions).where(lt(webSessions.expiresAt, new Date(now))).run();
            db.insert(webSessions)
              .values({
                tokenHash: hash(token),
                userId,
                createdAt: new Date(now),
                expiresAt: new Date(now + Duration.toMillis(SESSION_TTL)),
              })
              .run();
            return token;
          }),
        find: (token) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const row = db.select().from(webSessions).where(eq(webSessions.tokenHash, hash(token))).get();
            return row && row.expiresAt.getTime() > now ? row.userId : undefined;
          }),
        remove: (token) =>
          Effect.sync(() => {
            db.delete(webSessions).where(eq(webSessions.tokenHash, hash(token))).run();
          }),
      };
    }),
  );
}

/** 256 random bits, safe in cookies and URLs. */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function hash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
