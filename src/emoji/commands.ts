import { type CommandGroup, defineCommand } from "../commands/command.ts";
import type { EmojiConfig } from "../config.ts";
import { adminOnly } from "../permissions.ts";
import { downloadImage } from "./image.ts";
import { checkName, describeProposal, type EmojiProposals } from "./proposals.ts";

const id = { name: "id", description: "Proposal number", type: "integer" } as const;
const reason = {
  name: "reason",
  description: "Shown in the result",
  type: "string",
  required: false,
  rest: true,
} as const;

export function emojiCommands(proposals: EmojiProposals, config: EmojiConfig): CommandGroup {
  const propose = defineCommand({
    name: "propose",
    description: "Propose a new emoji; attach the image to your message.",
    options: [
      { name: "name", description: "Emoji name", type: "string" },
      { name: "image", description: "The emoji image", type: "attachment" },
    ],
    async run(ctx) {
      const { name, image } = ctx.options;
      checkName(name);
      const bytes = await downloadImage(image.url, config.maxImageBytes);
      const poll = await proposals.propose(ctx.userId, name, bytes);
      await ctx.reply(`Proposal #${poll.id} for \`:${name}:\` is up for a vote in <#${poll.channelId}>.`);
    },
  });

  const list = defineCommand({
    name: "list",
    description: "Show open emoji proposals.",
    async run(ctx) {
      const open = proposals.pending();
      await ctx.reply(
        open.length === 0
          ? "There are no open emoji proposals."
          : open.map((p) => describeProposal(p.proposal, p.poll)).join("\n"),
      );
    },
  });

  const approve = defineCommand({
    name: "approve",
    description: "End the vote early and add the emoji.",
    options: [id, reason],
    guard: adminOnly,
    async run(ctx) {
      await proposals.decide(ctx.options.id, ctx.userId, "approve", ctx.options.reason);
      await ctx.reply(`Proposal #${ctx.options.id} approved; the result is posted in <#${config.channelId}>.`);
    },
  });

  const reject = defineCommand({
    name: "reject",
    description: "End the vote early without adding the emoji.",
    options: [id, reason],
    guard: adminOnly,
    async run(ctx) {
      await proposals.decide(ctx.options.id, ctx.userId, "reject", ctx.options.reason);
      await ctx.reply(`Proposal #${ctx.options.id} rejected; the result is posted in <#${config.channelId}>.`);
    },
  });

  const cancel = defineCommand({
    name: "cancel",
    description: "Withdraw a proposal (proposer or admin).",
    options: [id],
    async run(ctx) {
      await proposals.cancel(ctx.options.id, ctx.userId);
      await ctx.reply(`Proposal #${ctx.options.id} was cancelled.`);
    },
  });

  return {
    name: "emoji",
    description: "Emoji proposals.",
    subcommands: [propose, list, approve, reject, cancel],
  };
}
