import { Effect } from "effect";
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
    permission: "polls.create",
    run: (ctx) =>
      Effect.gen(function* () {
        yield* community.start(ctx.userId, ctx.channelId, ctx.options.question);
        // The poll stands in for the command, the way a slash command's reply would.
        yield* ctx.deleteInvocation();
      }),
  });

  const list = defineCommand({
    name: "polls",
    description: "Show open polls.",
    run: (ctx) =>
      Effect.gen(function* () {
        const open = community.open();
        if (open.length === 0) return yield* Effect.asVoid(ctx.reply("There are no open polls."));
        const lines = open.map((p) => community.describe(p));
        yield* ctx.replyPages(embedPages("Open polls", lines, LIST_PAGE_SIZE));
      }),
  });

  return [poll, list];
}
