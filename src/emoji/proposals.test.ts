import { beforeEach, describe, expect, test } from "bun:test";
import { UserError } from "../commands/command.ts";
import type { EmojiConfig } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { PollService } from "../polls/service.ts";
import { FakeAccess, FakeClock, FakeTransport, PNG } from "../testing/fakes.ts";
import { sniffImage } from "./image.ts";
import { EMOJI_POLL_KIND, type EmojiGuild, EmojiProposals, EmojiRejected } from "./proposals.ts";

class FakeGuild implements EmojiGuild {
  existing: { id: string; name: string }[] = [];
  created: { name: string; image: string }[] = [];
  sent: string[] = [];
  createError: Error | undefined;

  async emojis() {
    return this.existing;
  }
  async createEmoji(name: string, image: string) {
    if (this.createError) throw this.createError;
    this.created.push({ name, image });
    this.existing.push({ id: `e${this.created.length}`, name });
    return `e${this.created.length}`;
  }
  async send(_channelId: string, content: string) {
    this.sent.push(content);
  }
}

const config: EmojiConfig = {
  channelId: "50",
  votingHours: 48,
  minYesVotes: 2,
  maxOpenPerUser: 2,
  maxImageBytes: 1024,
  proposerRoleIds: [],
};

let clock: FakeClock;
let transport: FakeTransport;
let guild: FakeGuild;
let access: FakeAccess;
let db: ReturnType<typeof openDatabase>;
let polls: PollService;
let proposals: EmojiProposals;

beforeEach(() => {
  clock = new FakeClock();
  transport = new FakeTransport();
  guild = new FakeGuild();
  access = new FakeAccess();
  db = openDatabase(":memory:");
  polls = new PollService(db, transport, { now: clock.now });
  proposals = new EmojiProposals({
    db,
    polls,
    guild,
    access,
    config: { ...config },
    guildId: "1",
    now: clock.now,
  });
  polls.register(EMOJI_POLL_KIND, proposals);
});

async function vote(messageId: string, users: string[], emoji: "✅" | "❌") {
  for (const user of users) await polls.reactionAdded(messageId, user, { name: emoji });
}

async function finishVote() {
  clock.advance(config.votingHours * 3_600_000);
  await polls.tick();
}

describe("propose", () => {
  test("posts a yes/no poll with the image in the proposal channel", async () => {
    const poll = await proposals.propose("u1", "party_cat", PNG);
    const message = transport.message(poll.messageId!);

    expect(message.channelId).toBe("50");
    expect(message.content).toContain("Add the emoji `:party_cat:`?");
    expect(message.content).toContain("Proposed by <@u1>");
    expect(message.files?.[0]?.name).toBe("party_cat.png");
    expect(proposals.get(poll.id)?.image).toEqual(Buffer.from(PNG));
  });

  const rejects = async (promise: Promise<unknown>, message: string) => {
    const err = (await promise.catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain(message);
  };

  test("validates the name", async () => {
    await rejects(proposals.propose("u1", "a", PNG), "2 to 32 characters");
    await rejects(proposals.propose("u1", "party-cat", PNG), "letters, digits and underscores");
  });

  test("validates the image", async () => {
    await rejects(proposals.propose("u1", "cat", new Uint8Array(32)), "PNG, JPEG, GIF");
    const big = new Uint8Array(2048);
    big.set(PNG);
    await rejects(proposals.propose("u1", "cat", big), "the limit is 1 KiB");
  });

  test("refuses names that exist or are already proposed, ignoring case", async () => {
    guild.existing = [{ id: "1", name: "Party_Cat" }];
    await rejects(proposals.propose("u1", "party_cat", PNG), "already exists");

    const poll = await proposals.propose("u1", "dog", PNG);
    await rejects(proposals.propose("u2", "DOG", PNG), `proposal #${poll.id}`);
  });

  test("limits open proposals per user", async () => {
    await proposals.propose("u1", "one", PNG);
    await proposals.propose("u1", "two", PNG);
    await rejects(proposals.propose("u1", "three", PNG), "already have 2 open proposals");
  });

  test("restricts proposers when roles are configured", async () => {
    proposals = new EmojiProposals({
      db,
      polls,
      guild,
      access,
      config: { ...config, proposerRoleIds: ["r1"] },
      guildId: "1",
      now: clock.now,
    });
    await rejects(proposals.propose("u1", "cat", PNG), "don't have a role");
    access.roles.set("u1", ["r1"]);
    expect((await proposals.propose("u1", "cat", PNG)).id).toBeGreaterThan(0);
  });
});

describe("vote outcome", () => {
  test("adds the emoji when the vote passes", async () => {
    const poll = await proposals.propose("u1", "party_cat", PNG);
    await vote(poll.messageId!, ["a", "b"], "✅");
    await vote(poll.messageId!, ["c"], "❌");
    await finishVote();

    expect(guild.created).toEqual([
      { name: "party_cat", image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` },
    ]);
    expect(proposals.get(poll.id)).toMatchObject({ status: "added", emojiId: "e1" });
    expect(guild.sent).toEqual(["<@u1> `:party_cat:` has been added (2 yes, 1 no)."]);
  });

  test("rejects without enough yes votes or without a majority", async () => {
    const few = await proposals.propose("u1", "few", PNG);
    await vote(few.messageId!, ["a"], "✅");
    const tie = await proposals.propose("u2", "tie", PNG);
    await vote(tie.messageId!, ["a", "b"], "✅");
    await vote(tie.messageId!, ["c", "d"], "❌");
    await finishVote();

    expect(guild.created).toEqual([]);
    expect(proposals.get(few.id)?.status).toBe("rejected");
    expect(proposals.get(tie.id)?.status).toBe("rejected");
    expect(guild.sent).toContain("<@u2> `:tie:` was not added (2 yes, 2 no).");
  });

  test("records a permanent refusal from Fluxer as failed", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await vote(poll.messageId!, ["a", "b"], "✅");
    guild.createError = new EmojiRejected("Maximum number of emojis reached");
    await finishVote();

    expect(proposals.get(poll.id)).toMatchObject({
      status: "failed",
      error: "Maximum number of emojis reached",
    });
    expect(polls.get(poll.id)?.status).toBe("resolved");
  });

  test("retries after a temporary failure without creating a duplicate", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await vote(poll.messageId!, ["a", "b"], "✅");
    guild.createError = new Error("socket hang up");
    const error = console.error;
    console.error = () => {};
    try {
      await finishVote();
    } finally {
      console.error = error;
    }
    expect(polls.get(poll.id)?.status).toBe("closed");
    expect(proposals.get(poll.id)?.status).toBe("pending");

    guild.createError = undefined;
    await polls.tick();
    await polls.tick();
    expect(guild.created).toHaveLength(1);
    expect(proposals.get(poll.id)?.status).toBe("added");
  });
});

describe("admin actions", () => {
  test("approve ends the vote early and overrides the tally", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await vote(poll.messageId!, ["a"], "❌");
    await proposals.decide(poll.id, "admin", "approve", "too good to wait");

    expect(proposals.get(poll.id)?.status).toBe("added");
    expect(guild.sent).toEqual([
      "<@u1> `:cat:` has been added (approved by <@admin>: too good to wait).",
    ]);
  });

  test("reject ends the vote early", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await vote(poll.messageId!, ["a", "b", "c"], "✅");
    await proposals.decide(poll.id, "admin", "reject");

    expect(guild.created).toEqual([]);
    expect(guild.sent).toEqual(["<@u1> `:cat:` was not added (rejected by <@admin>)."]);
  });

  test("decisions on finished proposals are refused", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await finishVote();
    await expect(proposals.decide(poll.id, "admin", "approve")).rejects.toThrow(
      "no open emoji proposal",
    );
  });

  test("only the proposer or an admin can cancel", async () => {
    const poll = await proposals.propose("u1", "cat", PNG);
    await expect(proposals.cancel(poll.id, "u2")).rejects.toThrow("Only the proposer");

    await proposals.cancel(poll.id, "u1");
    expect(proposals.get(poll.id)?.status).toBe("cancelled");
    expect(polls.get(poll.id)?.status).toBe("cancelled");
    expect(proposals.pending()).toEqual([]);

    const other = await proposals.propose("u1", "dog", PNG);
    access.admins.add("mod");
    await proposals.cancel(other.id, "mod");
    expect(proposals.get(other.id)?.status).toBe("cancelled");
  });
});

describe("sniffImage", () => {
  const pad = (bytes: number[] | string) => {
    const head = typeof bytes === "string" ? [...bytes].map((c) => c.charCodeAt(0)) : bytes;
    return new Uint8Array([...head, ...new Array(16).fill(0)]);
  };

  test("recognises supported formats", () => {
    expect(sniffImage(PNG)?.mime).toBe("image/png");
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffImage(pad("GIF89a"))?.mime).toBe("image/gif");
    expect(sniffImage(pad("RIFF\0\0\0\0WEBP"))?.mime).toBe("image/webp");
    expect(sniffImage(pad("\0\0\0\x1cftypavif"))?.mime).toBe("image/avif");
  });

  test("rejects anything else", () => {
    expect(sniffImage(pad("<svg xmlns=")))?.toBeNull();
    expect(sniffImage(new Uint8Array(4))).toBeNull();
  });
});
