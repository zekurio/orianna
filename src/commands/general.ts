import { Effect } from "effect";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { defineCommand } from "./command.ts";
import { commandList, helpFor } from "./help.ts";
import { CommandRouter } from "./router.ts";

export const ping = defineCommand({
  name: "ping",
  description: "Check that the bot is alive.",
  run: (ctx) =>
    Effect.gen(function* () {
      const started = performance.now();
      const reply = yield* ctx.reply("Pong!");
      const ms = Math.round(performance.now() - started);
      yield* reply.edit(`Pong! (${ms} ms round trip)`);
    }),
});

export const help = defineCommand({
  name: "help",
  description: "List the commands you may run, or show how to use one.",
  options: [
    {
      name: "command",
      description: "A command or group, like karma or karma set, to show only that",
      type: "string",
      required: false,
      rest: true,
    },
  ] as const,
  run: (ctx) =>
    Effect.gen(function* () {
      const { prefix } = yield* Settings.current;
      const permissions = yield* (yield* GuildAccess).permissionsOf(ctx.userId);
      const entries = yield* (yield* CommandRouter).entries(ctx.guildId);
      if (ctx.options.command === undefined) {
        return yield* ctx.replyPages(commandList(prefix, entries.values(), permissions));
      }
      yield* ctx.reply(yield* helpFor(prefix, entries, permissions, ctx.options.command));
    }),
});
