import { type CommandEntry, defineCommand } from "../commands/command.ts";
import { embedPages } from "../messages/body.ts";
import type { CommunityPolls } from "./community.ts";

const LIST_PAGE_SIZE = 10;

/** `!poll` starts a poll, `!polls` lists the open ones. */
export function pollCommands(community: CommunityPolls): CommandEntry[] {
  const poll = defineCommand({
    name: "poll",
    description:
      'Start a poll. Quote the question and up to 10 answers, e.g. `"Dinner?" "🍕 Pizza" "🍣 Sushi" 3h`. ' +
      "Start an answer with an emoji to vote with it. Add a duration (`30m`, `3h`, `3d`, `1w`; " +
      "4 weeks at most) or `multi` to allow several answers. Without quotes it's a yes/no question. " +
      "🛑 ends your poll early; deleting it calls it off.",
    options: [
      {
        name: "question",
        description: "The question and answers in quotes, then a duration or multi",
        type: "string",
        rest: true,
      },
    ],
    async run(ctx) {
      await community.start(ctx.userId, ctx.channelId, ctx.options.question);
      // The poll stands in for the command, the way a slash command's reply would.
      await ctx.deleteInvocation();
    },
  });

  const list = defineCommand({
    name: "polls",
    description: "Show open polls.",
    async run(ctx) {
      const open = community.open();
      if (open.length === 0) {
        await ctx.reply("There are no open polls.");
        return;
      }
      const lines = open.map((p) => community.describe(p));
      await ctx.replyPages(embedPages("Open polls", lines, LIST_PAGE_SIZE));
    },
  });

  return [poll, list];
}
