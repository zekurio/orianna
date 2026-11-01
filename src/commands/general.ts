import { Effect } from "effect";
import { embedPages } from "../messages/body.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import { defineCommand, isGroup, mayRun } from "./command.ts";
import { CommandRouter, usageLine } from "./router.ts";

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

const HELP_PAGE_SIZE = 8;

export const help = defineCommand({
  name: "help",
  description: "List the commands you may run.",
  run: (ctx) =>
    Effect.gen(function* () {
      const { prefix } = yield* Settings.current;
      const permissions = yield* (yield* GuildAccess).permissionsOf(ctx.userId);
      const entries = yield* (yield* CommandRouter).entries(ctx.guildId);
      const lines = [...entries.values()].flatMap((entry) =>
        isGroup(entry)
          ? entry.subcommands
              .filter((c) => mayRun(c, permissions))
              .map((c) => usageLine(prefix, `${entry.name} ${c.name}`, c))
          : mayRun(entry, permissions)
            ? [usageLine(prefix, entry.name, entry)]
            : [],
      );
      yield* ctx.replyPages(embedPages("Commands", lines, HELP_PAGE_SIZE));
    }),
});
