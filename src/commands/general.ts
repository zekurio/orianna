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
    await ctx.reply(lines.join("\n"));
  },
});
