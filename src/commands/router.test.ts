import { describe, expect, test } from "bun:test";
import type { Message } from "@fluxerjs/core";
import type { Bot } from "../bot.ts";
import type { Config } from "../config.ts";
import { type Attachment, defineCommand, formatUsage, UserError } from "./command.ts";
import { CommandRouter } from "./router.ts";

const config: Config = {
  instance: "https://chat.example.org",
  guildId: "100",
  prefix: "!",
  database: ":memory:",
  adminRoleIds: [],
};

function fakeMessage(
  content: string,
  overrides: { bot?: boolean; guildId?: string | null; attachments?: Attachment[] } = {},
) {
  const replies: string[] = [];
  const attachments = new Map(
    (overrides.attachments ?? []).map((a, i) => [String(i), { ...a, id: String(i) }]),
  );
  const message = {
    content,
    author: { id: "7", bot: overrides.bot ?? false },
    guildId: overrides.guildId === undefined ? config.guildId : overrides.guildId,
    channelId: "200",
    attachments,
    async reply(text: string) {
      replies.push(text);
      return { edit: async () => {} };
    },
  } as unknown as Message;
  return { message, replies };
}

function setup() {
  const calls: unknown[] = [];

  const echo = defineCommand({
    name: "echo",
    description: "Echo text.",
    options: [{ name: "text", description: "", type: "string", rest: true }],
    async run(ctx) {
      // Compile-time check: `text` is inferred as a required string.
      const text: string = ctx.options.text;
      calls.push({ text, userId: ctx.userId, channelId: ctx.channelId });
      await ctx.reply(text);
    },
  });

  const propose = defineCommand({
    name: "propose",
    description: "Propose an emoji.",
    options: [
      { name: "name", description: "", type: "string" },
      { name: "image", description: "", type: "attachment" },
    ],
    async run(ctx) {
      calls.push(ctx.options);
    },
  });

  const boom = defineCommand({
    name: "boom",
    description: "Always fails.",
    async run() {
      throw new Error("kaboom");
    },
  });

  const secret = defineCommand({
    name: "secret",
    description: "Admins only.",
    guard: async (ctx) => (ctx.userId === "admin" ? undefined : "Only admins can do that."),
    async run(ctx) {
      calls.push("secret");
      throw new UserError("Nothing to see here.");
    },
  });

  const router = new CommandRouter([
    echo,
    boom,
    secret,
    { name: "emoji", description: "Emoji proposals.", subcommands: [propose] },
  ]);
  const bot = { config, router } as unknown as Bot;
  return { bot, router, calls };
}

describe("CommandRouter.handleMessage", () => {
  test("runs a command with parsed options and message context", async () => {
    const { bot, router, calls } = setup();
    const { message, replies } = fakeMessage("!ECHO hello  world");
    await router.handleMessage(bot, message);
    expect(calls).toEqual([{ text: "hello  world", userId: "7", channelId: "200" }]);
    expect(replies).toEqual(["hello  world"]);
  });

  test("dispatches subcommands and passes attachments", async () => {
    const { bot, router, calls } = setup();
    const image = { url: "https://m/a.png", filename: "a.png", contentType: "image/png", size: 1 };
    const { message } = fakeMessage("!emoji propose party_cat", { attachments: [image] });
    await router.handleMessage(bot, message);
    expect(calls).toEqual([{ name: "party_cat", image }]);
  });

  test("replies with usage on bad arguments", async () => {
    const { bot, router, calls } = setup();
    const { message, replies } = fakeMessage("!emoji propose party_cat");
    await router.handleMessage(bot, message);
    expect(calls).toEqual([]);
    expect(replies).toEqual([
      "missing image\nUsage: `!emoji propose <name> <image: attachment>`: Propose an emoji.",
    ]);
  });

  test("lists subcommands when none or an unknown one is given", async () => {
    const { bot, router } = setup();
    for (const content of ["!emoji", "!emoji nope"]) {
      const { message, replies } = fakeMessage(content);
      await router.handleMessage(bot, message);
      expect(replies).toEqual([
        "`!emoji propose <name> <image: attachment>`: Propose an emoji.",
      ]);
    }
  });

  test("ignores bots, other guilds, DMs, unknown commands and plain chat", async () => {
    const { bot, router, calls } = setup();
    const cases = [
      fakeMessage("!echo hi", { bot: true }),
      fakeMessage("!echo hi", { guildId: "999" }),
      fakeMessage("!echo hi", { guildId: null }),
      fakeMessage("!nope"),
      fakeMessage("echo hi"),
    ];
    for (const { message, replies } of cases) {
      await router.handleMessage(bot, message);
      expect(replies).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  test("reports command failures without throwing", async () => {
    const { bot, router } = setup();
    const { message, replies } = fakeMessage("!boom");
    const error = console.error;
    console.error = () => {};
    try {
      await router.handleMessage(bot, message);
    } finally {
      console.error = error;
    }
    expect(replies).toEqual(["Something went wrong running that command."]);
  });

  test("guards refuse with their message", async () => {
    const { bot, router, calls } = setup();
    const { message, replies } = fakeMessage("!secret");
    await router.handleMessage(bot, message);
    expect(calls).toEqual([]);
    expect(replies).toEqual(["Only admins can do that."]);
  });

  test("UserErrors become plain replies", async () => {
    const { bot, router, calls } = setup();
    const { message, replies } = fakeMessage("!secret");
    (message.author as { id: string }).id = "admin";
    await router.handleMessage(bot, message);
    expect(calls).toEqual(["secret"]);
    expect(replies).toEqual(["Nothing to see here."]);
  });

  test("rejects duplicate names", () => {
    const ping = defineCommand({ name: "ping", description: "", async run() {} });
    expect(() => new CommandRouter([ping, ping])).toThrow("duplicate command: ping");
  });
});

describe("formatUsage", () => {
  test("marks optional, rest and attachment options", () => {
    expect(
      formatUsage([
        { name: "id", description: "", type: "integer" },
        { name: "file", description: "", type: "attachment", required: false },
        { name: "reason", description: "", type: "string", required: false, rest: true },
      ]),
    ).toBe("<id> [file: attachment] [reason...]");
  });
});
