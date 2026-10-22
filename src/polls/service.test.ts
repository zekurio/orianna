import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../db/index.ts";
import { polls } from "../db/schema.ts";
import { FakeClock, FakeTransport } from "../testing/fakes.ts";
import { type CreatePollInput, type Poll, PollService, type Tally, renderPoll } from "./service.ts";

const HOUR = 3_600_000;

let clock: FakeClock;
let transport: FakeTransport;
let db: ReturnType<typeof openDatabase>;
let service: PollService;
let closed: { poll: Poll; tally: Tally }[];

beforeEach(() => {
  clock = new FakeClock();
  transport = new FakeTransport();
  db = openDatabase(":memory:");
  service = new PollService(db, transport, { now: clock.now });
  closed = [];
  service.register("test", {
    async onClose(poll, tally) {
      closed.push({ poll, tally });
    },
  });
});

function input(overrides: Partial<CreatePollInput> = {}): CreatePollInput {
  return {
    kind: "test",
    guildId: "1",
    channelId: "2",
    question: "Pizza tonight?",
    options: [
      { key: "yes", emoji: "✅", label: "Yes" },
      { key: "no", emoji: "❌", label: "No" },
    ],
    mode: "single",
    closesAt: new Date(clock.now() + HOUR),
    createdBy: "9",
    ...overrides,
  };
}

const yes = { name: "✅" };
const no = { name: "❌" };

describe("create", () => {
  test("posts the poll and seeds one reaction per option", async () => {
    const poll = await service.create(input());
    const message = transport.message(poll.messageId!);

    expect(message.content).toContain("**Pizza tonight?**");
    expect(message.content).toContain(`Poll #${poll.id}`);
    expect([...message.reactions.keys()]).toEqual(["✅", "❌"]);
  });

  test("drops the row when posting fails", async () => {
    transport.failPost = true;
    await expect(service.create(input())).rejects.toThrow("post failed");
    expect(db.select().from(polls).all()).toEqual([]);
  });

  test("requires two or more options with unique keys", async () => {
    await expect(
      service.create(input({ options: [{ key: "a", emoji: "1️⃣", label: "A" }] })),
    ).rejects.toThrow();
  });
});

describe("voting", () => {
  test("single choice replaces the previous vote and removes its reaction", async () => {
    const poll = await service.create(input());
    await service.reactionAdded(poll.messageId!, "u1", yes);
    await service.reactionAdded(poll.messageId!, "u1", no);

    expect(service.tally(poll)).toEqual({ counts: { yes: 0, no: 1 }, voters: 1 });
    expect(transport.removed).toEqual([{ emoji: "✅", userId: "u1" }]);
  });

  test("multi choice keeps every vote", async () => {
    const poll = await service.create(input({ mode: "multi" }));
    await service.reactionAdded(poll.messageId!, "u1", yes);
    await service.reactionAdded(poll.messageId!, "u1", no);

    expect(service.tally(poll)).toEqual({ counts: { yes: 1, no: 1 }, voters: 1 });
    expect(transport.removed).toEqual([]);
  });

  test("removing a reaction removes the vote", async () => {
    const poll = await service.create(input());
    await service.reactionAdded(poll.messageId!, "u1", yes);
    service.reactionRemoved(poll.messageId!, "u1", yes);
    expect(service.tally(poll).voters).toBe(0);
  });

  test("ignores foreign emojis, unknown messages and closed polls", async () => {
    const poll = await service.create(input());
    await service.reactionAdded(poll.messageId!, "u1", { name: "🍕" });
    await service.reactionAdded("unknown", "u1", yes);

    clock.advance(HOUR);
    await service.reactionAdded(poll.messageId!, "u2", yes);
    expect(service.tally(poll).voters).toBe(0);
  });

  test("matches emojis with or without variation selectors", async () => {
    const poll = await service.create(
      input({
        options: [
          { key: "up", emoji: "👍", label: "Up" },
          { key: "heart", emoji: "❤️", label: "Heart" },
        ],
      }),
    );
    await service.reactionAdded(poll.messageId!, "u1", { name: "❤" });
    expect(service.tally(poll).counts.heart).toBe(1);
  });

  test("matches custom emojis by name and id", async () => {
    const poll = await service.create(
      input({
        options: [
          { key: "a", emoji: "party:123", label: "A" },
          { key: "b", emoji: "✅", label: "B" },
        ],
      }),
    );
    await service.reactionAdded(poll.messageId!, "u1", { name: "party", id: "123" });
    await service.reactionAdded(poll.messageId!, "u2", { name: "party", id: "456" });
    expect(service.tally(poll).counts).toEqual({ a: 1, b: 0 });
  });

  test("clearing reactions clears votes", async () => {
    const poll = await service.create(input({ mode: "multi" }));
    await service.reactionAdded(poll.messageId!, "u1", yes);
    await service.reactionAdded(poll.messageId!, "u2", no);

    service.reactionsCleared(poll.messageId!, no);
    expect(service.tally(poll).counts).toEqual({ yes: 1, no: 0 });
    service.reactionsCleared(poll.messageId!);
    expect(service.tally(poll).voters).toBe(0);
  });
});

describe("reconcile", () => {
  test("rebuilds votes from reactions made while offline", async () => {
    const poll = await service.create(input());
    // "gone" voted, then removed the reaction while the bot was offline;
    // "new" reacted while offline.
    await service.reactionAdded(poll.messageId!, "gone", yes);
    transport.addReaction(poll.messageId!, "❌", "kept");
    await service.reactionAdded(poll.messageId!, "kept", no);
    transport.addReaction(poll.messageId!, "✅", "new");

    await service.reconcile();
    expect(service.tally(poll)).toEqual({ counts: { yes: 1, no: 1 }, voters: 2 });
  });

  test("keeps the stored vote when a single-choice user has several reactions", async () => {
    const poll = await service.create(input());
    transport.addReaction(poll.messageId!, "❌", "u1");
    await service.reactionAdded(poll.messageId!, "u1", no);
    transport.addReaction(poll.messageId!, "✅", "u1");

    await service.reconcile();
    expect(service.tally(poll).counts).toEqual({ yes: 0, no: 1 });
  });
});

describe("closing", () => {
  test("tick closes due polls, shows the tally and runs the handler once", async () => {
    const poll = await service.create(input());
    await service.reactionAdded(poll.messageId!, "u1", yes);

    await service.tick();
    expect(closed).toEqual([]);

    clock.advance(HOUR);
    await service.tick();
    await service.tick();

    expect(closed).toHaveLength(1);
    expect(closed[0]!.tally).toEqual({ counts: { yes: 1, no: 0 }, voters: 1 });
    expect(service.get(poll.id)!.status).toBe("resolved");
    expect(transport.message(poll.messageId!).content).toContain("(closed)");
    expect(transport.message(poll.messageId!).content).toContain("✅ Yes: **1**");
  });

  test("a failing handler leaves the poll closed and is retried", async () => {
    let attempts = 0;
    service.register("flaky", {
      async onClose() {
        if (++attempts === 1) throw new Error("try again");
      },
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const poll = await service.create(input({ kind: "flaky" }));

    expect(await service.close(poll.id)).toBe(true);
    expect(service.get(poll.id)!.status).toBe("closed");

    await service.tick();
    expect(service.get(poll.id)!.status).toBe("resolved");
    expect(attempts).toBe(2);
    error.mockRestore();
  });

  test("close and cancel only act on open polls", async () => {
    const poll = await service.create(input());
    expect(await service.cancel(poll.id)).toBe(true);
    expect(await service.close(poll.id)).toBe(false);
    expect(await service.cancel(poll.id)).toBe(false);
    expect(closed).toEqual([]);
    expect(transport.message(poll.messageId!).content).toContain("(cancelled)");
  });

  test("start drops polls that were never posted", async () => {
    db.insert(polls)
      .values({ ...input(), createdAt: new Date(clock.now()) })
      .run();
    const posted = await service.create(input());

    service.start();
    service.stop();
    expect(db.select().from(polls).all().map((p) => p.id)).toEqual([posted.id]);
  });
});

describe("renderPoll", () => {
  test("describes how to vote and when the poll closes", async () => {
    const poll = await service.create(input({ description: "Friday edition" }));
    const closesAt = Math.floor((clock.now() + HOUR) / 1000);
    expect(renderPoll(poll)).toBe(
      [
        "**Pizza tonight?**",
        "Friday edition",
        "",
        "✅ Yes",
        "❌ No",
        "",
        `React to vote. Closes <t:${closesAt}:R>. Poll #${poll.id}`,
      ].join("\n"),
    );
  });
});
