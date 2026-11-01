import { Context, Effect, SubscriptionRef } from "effect";
import { eq } from "drizzle-orm";
import { Database } from "../db/index.ts";
import { starboardOptOuts } from "../db/schema.ts";
import { Guilds } from "../guilds.ts";
import { LiveStarboard } from "./starboard.ts";

// The starboard opt-out, which holds in every guild, as on shinpuru.

/** Whether the member keeps their messages out of every starboard. */
export const optedOut = Effect.fnUntraced(function* (userId: string) {
  const db = yield* Database;
  return db.select().from(starboardOptOuts).where(eq(starboardOptOuts.userId, userId)).get() !== undefined;
});

/** Keeps the member's messages out of every starboard and takes down their posts. Returns how many. */
export const optOut = Effect.fnUntraced(function* (userId: string) {
  const db = yield* Database;
  db.insert(starboardOptOuts).values({ userId, optedOutAt: new Date() }).onConflictDoNothing().run();
  let removed = 0;
  for (const context of (yield* (yield* Guilds).built).values()) {
    const starboard = yield* SubscriptionRef.get(Context.get(context, LiveStarboard));
    if (starboard) removed += yield* starboard.takeDownAuthor(userId);
  }
  return removed;
});

/** Returns false when the member hadn't opted out. */
export const optIn = Effect.fnUntraced(function* (userId: string) {
  const db = yield* Database;
  return db.delete(starboardOptOuts).where(eq(starboardOptOuts.userId, userId)).returning().all().length > 0;
});
