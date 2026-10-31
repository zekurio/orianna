import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import {
  type Attachment,
  type CommandContext,
  type CommandGroup,
  defineCommand,
  refuse,
} from "../commands/command.ts";
import { Fluxer } from "../fluxer.ts";
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
export const proposalCommands = Effect.fnUntraced(function* (
  proposals: ExpressionProposals,
  pollsChannelId: string,
) {
  const { kind } = proposals;
  const linkHelp = "attach the image, or paste a link to it or to a 7TV emote";
  const http = yield* Effect.context<HttpClient.HttpClient | Dns.Dns>();

  /** Checks what's cheap first, then downloads the image. */
  const readInput = ({ options }: CommandContext<InputOptions>) =>
    Effect.gen(function* () {
      if (options.name !== undefined) yield* kind.checkName(options.name);
      const tags = yield* parseTags(options.tags);

      // On a self-hosted instance, the media host and wherever Fluxer keeps
      // attachments may be on a private network, which downloadImage otherwise
      // refuses. Fluxer picks an attachment's URL, so its host is trusted; a
      // pasted link is trusted only when it points at the media host.
      const { image } = options;
      const { client } = yield* Fluxer;
      const media = client.instance.endpoints.media;
      const trusted = image.linked ? [media] : [media, image.url];
      const emote = sevenTvEmoteId(image.url);
      const source = emote
        ? yield* fetchSevenTvEmote(emote, proposals.downloadLimit)
        : {
            name: undefined,
            image: yield* downloadImage(image.url, proposals.downloadLimit, trusted),
          };

      const name = options.name ?? (source.name !== undefined ? kind.fitName(source.name) : undefined);
      if (name === undefined) {
        return yield* refuse(
          source.name === undefined
            ? `Give the ${kind.noun} a name.`
            : `\`${source.name}\` doesn't work as a ${kind.noun} name; give it one.`,
        );
      }
      const input: ExpressionInput = { name, image: source.image, description: options.desc, tags };
      return input;
    }).pipe(Effect.provideContext(http));

  const propose = (ctx: CommandContext<InputOptions>) =>
    Effect.gen(function* () {
      const input = yield* readInput(ctx);
      const { poll, names } = yield* proposals.propose(ctx.userId, input);
      const cut =
        names.length > 1
          ? ` The image was cut into ${names.length} ${kind.plural}: ${names.map(kind.code).join(" ")}.`
          : "";
      yield* ctx.reply(
        `Poll \`${poll.slug}\` for the ${kind.display(input.name)} is up for a vote in <#${poll.channelId}>.${cut}`,
      );
    });

  const add = (ctx: CommandContext<InputOptions>) =>
    Effect.gen(function* () {
      const input = yield* readInput(ctx);
      const created = yield* proposals.add(ctx.userId, input);
      const mentions = created.map((c) => c.mention).filter(Boolean);
      const cut = created.length > 1 ? ` as ${created.length} ${kind.plural}` : "";
      // Without spaces, the pieces of a wide emoji line up.
      const shown = mentions.length > 0 ? `: ${mentions.join("")}` : ".";
      yield* ctx.reply(`Added the ${kind.display(input.name)}${cut}${shown}`);
    });

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
    run: (ctx) =>
      Effect.gen(function* () {
        const open = proposals.pending();
        if (open.length === 0) {
          return yield* Effect.asVoid(ctx.reply(`There are no open ${kind.noun} proposals.`));
        }
        const lines = open.map((p) => proposals.describe(p.proposal, p.poll));
        yield* ctx.replyPages(embedPages(`Open ${kind.noun} proposals`, lines, LIST_PAGE_SIZE));
      }),
  });

  const approve = defineCommand({
    name: "approve",
    description: `End the vote early and add the ${kind.noun}.`,
    options: [id, reason],
    permission: `${kind.type}.decide`,
    run: (ctx) =>
      Effect.gen(function* () {
        yield* proposals.decide(ctx.options.id, ctx.userId, "approve", ctx.options.reason);
        yield* ctx.reply(
          `Poll \`${normalizeSlug(ctx.options.id)}\` approved; the result is posted in <#${pollsChannelId}>.`,
        );
      }),
  });

  const reject = defineCommand({
    name: "reject",
    description: `End the vote early without adding the ${kind.noun}.`,
    options: [id, reason],
    permission: `${kind.type}.decide`,
    run: (ctx) =>
      Effect.gen(function* () {
        yield* proposals.decide(ctx.options.id, ctx.userId, "reject", ctx.options.reason);
        yield* ctx.reply(
          `Poll \`${normalizeSlug(ctx.options.id)}\` rejected; the result is posted in <#${pollsChannelId}>.`,
        );
      }),
  });

  const cancel = defineCommand({
    name: "cancel",
    description: `Withdraw your proposal, or anyone's with \`${kind.type}.cancel-any\`.`,
    options: [id],
    run: (ctx) =>
      Effect.gen(function* () {
        yield* proposals.cancel(ctx.options.id, ctx.userId);
        yield* ctx.reply(`Poll \`${normalizeSlug(ctx.options.id)}\` was cancelled.`);
      }),
  });

  const group: CommandGroup = {
    name: kind.type,
    description: `${kind.noun[0]!.toUpperCase()}${kind.noun.slice(1)} proposals.`,
    subcommands: [...inputCommands, list, approve, reject, cancel],
  };
  return group;
});
