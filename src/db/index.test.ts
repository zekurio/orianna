import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "./index.ts";
import { polls, votes } from "./schema.ts";

describe("openDatabase", () => {
  test("migrates a fresh database and round-trips JSON columns", () => {
    const db = openDatabase(":memory:");
    const now = new Date();

    const [poll] = db
      .insert(polls)
      .values({
        kind: "test",
        guildId: "1",
        channelId: "2",
        question: "Yes or no?",
        options: [
          { key: "yes", emoji: "✅", label: "Yes" },
          { key: "no", emoji: "❌", label: "No" },
        ],
        mode: "single",
        createdBy: "3",
        createdAt: now,
        closesAt: new Date(now.getTime() + 60_000),
      })
      .returning()
      .all();

    expect(poll?.status).toBe("open");
    expect(poll?.options[1]?.emoji).toBe("❌");
  });

  test("deleting a poll cascades to its votes", () => {
    const db = openDatabase(":memory:");
    const now = new Date();
    const [poll] = db
      .insert(polls)
      .values({
        kind: "test",
        guildId: "1",
        channelId: "2",
        question: "?",
        options: [],
        mode: "multi",
        createdBy: "3",
        createdAt: now,
        closesAt: now,
      })
      .returning()
      .all();

    db.insert(votes)
      .values({ pollId: poll!.id, userId: "4", optionKey: "yes", votedAt: now })
      .run();
    db.delete(polls).where(eq(polls.id, poll!.id)).run();

    expect(db.select().from(votes).all()).toHaveLength(0);
  });
});
