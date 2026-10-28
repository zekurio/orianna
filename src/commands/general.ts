import { embedPages } from "../messages/body.ts";
import { defineCommand, isGroup, mayRun } from "./command.ts";
import { usageLine } from "./router.ts";

export const ping = defineCommand({
  name: "ping",
  description: "Check that the bot is alive.",
  async run(ctx) {
    const started = performance.now();
    const reply = await ctx.reply("Pong!");
    const ms = Math.round(performance.now() - started);
    await reply.edit(`Pong! (${ms} ms round trip)`);
  },
});

const HELP_PAGE_SIZE = 8;

export const help = defineCommand({
  name: "help",
  description: "List the commands you may run.",
  async run(ctx) {
    const { prefix } = ctx.bot.config;
    const permissions = await ctx.bot.access.permissionsOf(ctx.userId);
    const lines = [...ctx.bot.router.entries.values()].flatMap((entry) =>
      isGroup(entry)
        ? entry.subcommands
            .filter((c) => mayRun(c, permissions))
            .map((c) => usageLine(prefix, `${entry.name} ${c.name}`, c))
        : mayRun(entry, permissions)
          ? [usageLine(prefix, entry.name, entry)]
          : [],
    );
    await ctx.replyPages(embedPages("Commands", lines, HELP_PAGE_SIZE));
  },
});
