import { defineCommand, isGroup } from "./command.ts";
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
  description: "List available commands.",
  async run(ctx) {
    const { prefix } = ctx.bot.config;
    const lines = [...ctx.bot.router.entries.values()].flatMap((entry) =>
      isGroup(entry)
        ? entry.subcommands.map((c) => usageLine(prefix, `${entry.name} ${c.name}`, c))
        : [usageLine(prefix, entry.name, entry)],
    );
    const pages: string[] = [];
    for (let i = 0; i < lines.length; i += HELP_PAGE_SIZE) {
      pages.push(["**Commands**", ...lines.slice(i, i + HELP_PAGE_SIZE)].join("\n"));
    }
    await ctx.replyPages(pages);
  },
});
