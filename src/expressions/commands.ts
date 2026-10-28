import {
  type Attachment,
  type CommandContext,
  type CommandGroup,
  defineCommand,
  UserError,
} from "../commands/command.ts";
import { embedPages } from "../messages/body.ts";
import { normalizeSlug } from "../polls/slug.ts";
import { downloadImage } from "./image.ts";
import { type ExpressionInput, type ExpressionProposals, parseTags } from "./proposals.ts";
import { fetchSevenTvEmote, sevenTvEmoteId } from "./seventv.ts";

const id = { name: "id", description: "Poll name, e.g. green-panther", type: "string" } as const;
const reason = {
  name: "reason",
  description: "Shown in the result",
  type: "string",
  required: false,
  rest: true,
} as const;

const emojiOptions = [
  {
    name: "name",
    description: "Emoji name; a 7TV emote brings its own",
    type: "string",
    required: false,
  },
  { name: "image", description: "The emoji image or a 7TV emote", type: "attachment" },
] as const;

const stickerOptions = [
  {
    name: "name",
    description: "Sticker name, which may contain spaces; a 7TV emote brings its own",
    type: "string",
    required: false,
    rest: true,
  },
  { name: "image", description: "The sticker image or a 7TV emote", type: "attachment" },
  { name: "desc", description: "What the sticker shows", type: "string", required: false, named: true },
  { name: "tags", description: "Comma-separated search tags", type: "string", required: false, named: true },
] as const;

/** What the propose and add commands take, for either kind. */
interface InputOptions {
  name?: string;
  image: Attachment;
  desc?: string;
  tags?: string;
}

const LIST_PAGE_SIZE = 10;

/** `!emoji ...` or `!sticker ...`, depending on the proposals' kind. */
export function proposalCommands(
  proposals: ExpressionProposals,
  pollsChannelId: string,
): CommandGroup {
  const { kind } = proposals;
  const linkHelp = "attach the image, or paste a link to it or to a 7TV emote";

  /** Checks what's cheap first, then downloads the image. */
  async function readInput(options: InputOptions): Promise<ExpressionInput> {
    if (options.name !== undefined) kind.checkName(options.name);
    const tags = parseTags(options.tags);

    const emote = sevenTvEmoteId(options.image.url);
    const source = emote
      ? await fetchSevenTvEmote(emote, proposals.downloadLimit)
      : { name: undefined, image: await downloadImage(options.image.url, proposals.downloadLimit) };

    const name = options.name ?? (source.name !== undefined ? kind.fitName(source.name) : undefined);
    if (name === undefined) {
      throw new UserError(
        source.name === undefined
          ? `Give the ${kind.noun} a name.`
          : `\`${source.name}\` doesn't work as a ${kind.noun} name; give it one.`,
      );
    }
    return { name, image: source.image, description: options.desc, tags };
  }

  async function propose(ctx: CommandContext<InputOptions>) {
    const input = await readInput(ctx.options);
    const { poll, names } = await proposals.propose(ctx.userId, input);
    const cut =
      names.length > 1
        ? ` The image was cut into ${names.length} ${kind.plural}: ${names.map(kind.code).join(" ")}.`
        : "";
    await ctx.reply(
      `Poll \`${poll.slug}\` for the ${kind.display(input.name)} is up for a vote in <#${poll.channelId}>.${cut}`,
    );
  }

  async function add(ctx: CommandContext<InputOptions>) {
    const input = await readInput(ctx.options);
    const created = await proposals.add(ctx.userId, input);
    const mentions = created.map((c) => c.mention).filter(Boolean);
    const cut = created.length > 1 ? ` as ${created.length} ${kind.plural}` : "";
    // Without spaces, the pieces of a wide emoji line up.
    const shown = mentions.length > 0 ? `: ${mentions.join("")}` : ".";
    await ctx.reply(`Added the ${kind.display(input.name)}${cut}${shown}`);
  }

  // Emoji and sticker options differ, but both fit InputOptions.
  const options = kind.type === "sticker" ? stickerOptions : emojiOptions;
  const inputCommands = [
    defineCommand({
      name: "propose",
      description: `Propose a new ${kind.noun}; ${linkHelp}.`,
      options,
      permission: `${kind.type}.propose`,
      run: propose,
    }),
    defineCommand({
      name: "add",
      description: `Add the ${kind.noun} right away, without a vote.`,
      options,
      permission: `${kind.type}.add`,
      run: add,
    }),
  ];

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
    permission: `${kind.type}.decide`,
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
    permission: `${kind.type}.decide`,
    async run(ctx) {
      await proposals.decide(ctx.options.id, ctx.userId, "reject", ctx.options.reason);
      await ctx.reply(
        `Poll \`${normalizeSlug(ctx.options.id)}\` rejected; the result is posted in <#${pollsChannelId}>.`,
      );
    },
  });

  const cancel = defineCommand({
    name: "cancel",
    description: `Withdraw your proposal, or anyone's with \`${kind.type}.cancel-any\`.`,
    options: [id],
    async run(ctx) {
      await proposals.cancel(ctx.options.id, ctx.userId);
      await ctx.reply(`Poll \`${normalizeSlug(ctx.options.id)}\` was cancelled.`);
    },
  });

  return {
    name: kind.type,
    description: `${kind.noun[0]!.toUpperCase()}${kind.noun.slice(1)} proposals.`,
    subcommands: [...inputCommands, list, approve, reject, cancel],
  };
}
