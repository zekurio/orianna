import { Effect } from "effect";
import { type CommandEntry, defineCommand } from "../commands/command.ts";
import { embedPages } from "../messages/body.ts";
import type { CommunityPolls } from "./community.ts";
import { plural } from "./duration.ts";

const LIST_PAGE_SIZE = 10;

/**
 * `!poll` starts a poll, `!polls` lists the open ones. Polls without a
 * duration run for `defaultHours`.
 */
export function pollCommands(community: CommunityPolls, defaultHours: number): CommandEntry[] {
  const poll = defineCommand({
    name: "poll",
    description: "Start a poll.",
    section: "Polls",
    details: 'Like `"Dinner?" "🍕 Pizza" "🍣 Sushi" 3h`. React with 🛑 to end it early.',
    options: [
      {
        name: "poll",
        description: "The question, the answers, how long it runs and whether to allow several answers",
        type: "string",
        rest: true,
        // parsePollInput reads these out of the text.
        parts: [
          {
            name: "question",
            description: "What to ask, in quotes if you add answers. Without answers it's yes or no",
          },
          {
            name: "answers",
            description: "Up to 10, each in quotes. Start one with an emoji to vote with it",
            required: false,
            repeated: true,
          },
          {
            name: "duration",
            description: `Like \`3h\` or \`2d\`, up to 4 weeks. Defaults to ${plural(defaultHours, "hour")}`,
            required: false,
          },
          {
            name: "multi",
            description: "Let members pick more than one answer",
            required: false,
          },
        ],
      },
    ],
    permission: "polls.create",
    run: (ctx) =>
      Effect.gen(function* () {
        yield* community.start(ctx.userId, ctx.channelId, ctx.options.poll);
        // The poll stands in for the command, the way a slash command's reply would.
        yield* ctx.deleteInvocation();
      }),
  });

  const list = defineCommand({
    name: "polls",
    description: "Show open polls.",
    section: "Polls",
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
