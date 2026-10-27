import { type CommandGroup, defineCommand } from "../commands/command.ts";
import type { ProposalConfig } from "../config.ts";
import { embedPages } from "../messages/body.ts";
import { adminOnly } from "../permissions.ts";
import { normalizeSlug } from "../polls/slug.ts";
import { downloadImage } from "./image.ts";
import { type ExpressionProposals, parseTags } from "./proposals.ts";

const id = { name: "id", description: "Poll name, e.g. green-panther", type: "string" } as const;
const reason = {
  name: "reason",
  description: "Shown in the result",
  type: "string",
  required: false,
  rest: true,
} as const;

const LIST_PAGE_SIZE = 10;

/** `!emoji ...` or `!sticker ...`, depending on the proposals' kind. */
export function proposalCommands(
  proposals: ExpressionProposals,
  config: ProposalConfig,
  pollsChannelId: string,
): CommandGroup {
  const { kind } = proposals;

  const proposeEmoji = defineCommand({
    name: "propose",
    description: "Propose a new emoji; attach the image or paste a direct link to it.",
    options: [
      { name: "name", description: "Emoji name", type: "string" },
      { name: "image", description: "The emoji image", type: "attachment" },
    ],
    async run(ctx) {
      kind.checkName(ctx.options.name);
      const image = await downloadImage(ctx.options.image.url, config.maxImageBytes);
      const poll = await proposals.propose(ctx.userId, { name: ctx.options.name, image });
      await ctx.reply(
        `Poll \`${poll.slug}\` for the ${kind.display(ctx.options.name)} is up for a vote in <#${poll.channelId}>.`,
      );
    },
  });

  const proposeSticker = defineCommand({
    name: "propose",
    description: "Propose a new sticker; attach the image or paste a direct link to it.",
    options: [
      { name: "name", description: "Sticker name; may contain spaces", type: "string", rest: true },
      { name: "image", description: "The sticker image", type: "attachment" },
      { name: "desc", description: "What the sticker shows", type: "string", required: false, named: true },
      { name: "tags", description: "Comma-separated search tags", type: "string", required: false, named: true },
    ],
    async run(ctx) {
      const { name, desc } = ctx.options;
      kind.checkName(name);
      const tags = parseTags(ctx.options.tags);
      const image = await downloadImage(ctx.options.image.url, config.maxImageBytes);
      const poll = await proposals.propose(ctx.userId, { name, image, description: desc, tags });
      await ctx.reply(
        `Poll \`${poll.slug}\` for the ${kind.display(name)} is up for a vote in <#${poll.channelId}>.`,
      );
    },
  });

  const list = defineCommand({
    name: "list",
    description: `Show open ${kind.noun} proposals.`,
    async run(ctx) {
      const open = proposals.pending();
      if (open.length === 0) {
        await ctx.reply(`There are no open ${kind.noun} proposals.`);
        return;
      }
      const lines = open.map((p) => proposals.describe(p.proposal, p.poll));
      await ctx.replyPages(embedPages(`Open ${kind.noun} proposals`, lines, LIST_PAGE_SIZE));
    },
  });

  const approve = defineCommand({
    name: "approve",
    description: `End the vote early and add the ${kind.noun}.`,
    options: [id, reason],
    guard: adminOnly,
    async run(ctx) {
      await proposals.decide(ctx.options.id, ctx.userId, "approve", ctx.options.reason);
      await ctx.reply(
        `Poll \`${normalizeSlug(ctx.options.id)}\` approved; the result is posted in <#${pollsChannelId}>.`,
      );
    },
  });

  const reject = defineCommand({
    name: "reject",
    description: `End the vote early without adding the ${kind.noun}.`,
    options: [id, reason],
    guard: adminOnly,
    async run(ctx) {
      await proposals.decide(ctx.options.id, ctx.userId, "reject", ctx.options.reason);
      await ctx.reply(
        `Poll \`${normalizeSlug(ctx.options.id)}\` rejected; the result is posted in <#${pollsChannelId}>.`,
      );
    },
  });

  const cancel = defineCommand({
    name: "cancel",
    description: "Withdraw a proposal (proposer or admin).",
    options: [id],
    async run(ctx) {
      await proposals.cancel(ctx.options.id, ctx.userId);
      await ctx.reply(`Poll \`${normalizeSlug(ctx.options.id)}\` was cancelled.`);
    },
  });

  return {
    name: kind.type,
    description: `${kind.noun[0]!.toUpperCase()}${kind.noun.slice(1)} proposals.`,
    subcommands: [
      kind.type === "sticker" ? proposeSticker : proposeEmoji,
      list,
      approve,
      reject,
      cancel,
    ],
  };
}
