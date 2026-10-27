import { and, asc, count, eq } from "drizzle-orm";
import { UserError } from "../commands/command.ts";
import type { ProposalConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { polls, proposalImages, proposals } from "../db/schema.ts";
import type { GuildAccess } from "../permissions.ts";
import type { Poll, PollHandler, PollService, Tally } from "../polls/service.ts";
import { timestamp } from "../polls/service.ts";
import { cutImage, inspectImage, type ProcessedImage, pieceCount } from "./process.ts";

export type Proposal = typeof proposals.$inferSelect;
export type ProposalImage = typeof proposalImages.$inferSelect;
export type ExpressionType = Proposal["type"];

export interface Expression {
  id: string;
  name: string;
}

export interface NewExpression {
  name: string;
  /** `data:` URL of the image. */
  image: string;
  description: string | null;
  tags: string[];
  /** For the audit log, which shows the bot as the one who added it. */
  reason: string;
}

export interface CreatedExpression {
  id: string;
  /** How a message shows it, for emojis. */
  mention?: string;
}

/** What expression proposals need from the guild. */
export interface ExpressionGuild {
  list(type: ExpressionType): Promise<Expression[]>;
  /** Throws ExpressionRejected when Fluxer refuses it for good. */
  create(type: ExpressionType, expression: NewExpression): Promise<CreatedExpression>;
  send(channelId: string, content: string, replyTo?: string): Promise<void>;
  /** IDs of the non-bot members who can see the channel. */
  voters(channelId: string): Promise<string[]>;
}

/** Fluxer refused the expression (bad image, slot limit, ...); retrying won't help. */
export class ExpressionRejected extends Error {
  override name = "ExpressionRejected";
}

/** How one kind of expression differs from the other. */
export interface ExpressionKind {
  type: ExpressionType;
  /** Poll kind registered with the poll service. */
  pollKind: string;
  /** "emoji", "sticker" */
  noun: string;
  /** "emojis", "stickers" */
  plural: string;
  /** Throws UserError when Fluxer would refuse the name. */
  checkName(name: string): void;
  /**
   * Turns a name from elsewhere, like a 7TV emote's, into one Fluxer takes.
   * Undefined when too little of it is left.
   */
  fitName(name: string): string | undefined;
  /** How the name is written in messages, e.g. `` `:sadi:` ``. */
  code(name: string): string;
  /** How the name is shown in messages, e.g. "emoji `:sadi:`". */
  display(name: string): string;
  /** Most pieces a wide or tall image is cut into. */
  maxPieces: number;
  /** Longest side, in pixels, of an image the bot had to process. */
  size: number;
  /** Names for an image cut into `count` pieces; just the name for one. */
  pieceNames(name: string, count: number): string[];
}

const EMOJI_NAME_MAX = 32;

export const EMOJI: ExpressionKind = {
  type: "emoji",
  pollKind: "emoji-proposal",
  noun: "emoji",
  plural: "emojis",
  checkName(name) {
    if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) {
      throw new UserError(
        "Emoji names must be 2 to 32 characters long and use only letters, digits and underscores.",
      );
    }
  },
  fitName(name) {
    const fitted = name
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, EMOJI_NAME_MAX);
    return fitted.length >= 2 ? fitted : undefined;
  },
  code: (name) => `\`:${name}:\``,
  display: (name) => `emoji \`:${name}:\``,
  maxPieces: 5,
  // What Fluxer's own client scales static emojis to.
  size: 128,
  pieceNames: (name, count) => numbered(name, count, "_", EMOJI_NAME_MAX),
};

// Limits from Fluxer's GuildStickerCreateRequest schema.
const STICKER_NAME_MAX = 30;
const STICKER_DESCRIPTION_MAX = 500;
const STICKER_TAGS_MAX = 10;
const STICKER_TAG_LENGTH_MAX = 30;

export const STICKER: ExpressionKind = {
  type: "sticker",
  pollKind: "sticker-proposal",
  noun: "sticker",
  plural: "stickers",
  checkName(name) {
    if (name.length < 2 || name.length > STICKER_NAME_MAX) {
      throw new UserError(`Sticker names must be 2 to ${STICKER_NAME_MAX} characters long.`);
    }
  },
  fitName(name) {
    const fitted = name.trim().slice(0, STICKER_NAME_MAX).trimEnd();
    return fitted.length >= 2 ? fitted : undefined;
  },
  code: (name) => `\`${name}\``,
  display: (name) => `sticker \`${name}\``,
  // A message carries at most three stickers.
  maxPieces: 3,
  // What Fluxer's own client scales stickers to.
  size: 320,
  pieceNames: (name, count) => numbered(name, count, " ", STICKER_NAME_MAX),
};

/** `name_1`, `name_2`, ...: the name is cut short to leave room for the number. */
function numbered(name: string, count: number, separator: string, max: number): string[] {
  if (count === 1) return [name];
  return Array.from({ length: count }, (_, i) => {
    const suffix = `${separator}${i + 1}`;
    return name.slice(0, max - suffix.length).trimEnd() + suffix;
  });
}

/**
 * Splits `sad, cry,Sad` into `["sad", "cry"]`: trimmed, lowercased, empty
 * entries and duplicates dropped.
 */
export function parseTags(input: string | undefined): string[] {
  if (!input) return [];
  const tags = [
    ...new Set(
      input
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (tags.length > STICKER_TAGS_MAX) {
    throw new UserError(`A sticker can have at most ${STICKER_TAGS_MAX} tags.`);
  }
  const long = tags.find((t) => t.length > STICKER_TAG_LENGTH_MAX);
  if (long) {
    throw new UserError(`Tags can be at most ${STICKER_TAG_LENGTH_MAX} characters long: \`${long}\`.`);
  }
  return tags;
}

export interface ExpressionInput {
  name: string;
  image: Uint8Array;
  /** Stickers only. */
  description?: string;
  /** Stickers only. */
  tags?: string[];
}

/** Input that passed the checks, with its image ready for Fluxer. */
interface Draft {
  name: string;
  description: string | null;
  tags: string[];
  pieces: (ProcessedImage & { name: string })[];
}

export interface ExpressionProposalsDeps {
  db: DB;
  polls: PollService;
  guild: ExpressionGuild;
  access: GuildAccess;
  config: ProposalConfig;
  guildId: string;
  /** Where proposal polls are posted. */
  channelId: string;
  now?: () => number;
}

/** Proposals for one kind of expression; register one instance per kind. */
export class ExpressionProposals implements PollHandler {
  private readonly now: () => number;

  constructor(
    readonly kind: ExpressionKind,
    private readonly deps: ExpressionProposalsDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get(pollId: number): Proposal | undefined {
    return this.deps.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.pollId, pollId), eq(proposals.type, this.kind.type)))
      .get();
  }

  /** The images a proposal adds, in order. */
  images(pollId: number): ProposalImage[] {
    return this.deps.db
      .select()
      .from(proposalImages)
      .where(eq(proposalImages.pollId, pollId))
      .orderBy(asc(proposalImages.position))
      .all();
  }

  pending(): { proposal: Proposal; poll: Poll }[] {
    return this.deps.db
      .select({ proposal: proposals, poll: polls })
      .from(proposals)
      .innerJoin(polls, eq(polls.id, proposals.pollId))
      .where(and(eq(proposals.type, this.kind.type), eq(proposals.status, "pending")))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  /** Puts the expression up for a vote. Returns the poll and the names it would add. */
  async propose(proposerId: string, input: ExpressionInput): Promise<{ poll: Poll; names: string[] }> {
    const { config, db, access, guild } = this.deps;
    const { kind } = this;

    if (
      config.proposerRoleIds.length > 0 &&
      !(await access.hasAnyRole(proposerId, config.proposerRoleIds))
    ) {
      throw new UserError(`You don't have a role that can propose ${kind.plural}.`);
    }
    const open = this.pending().filter((p) => p.proposal.proposerId === proposerId);
    if (open.length >= config.maxOpenPerUser) {
      throw new UserError(
        `You already have ${open.length} open ${kind.noun} proposals; wait for one to finish first.`,
      );
    }

    const { name, description, tags, pieces } = await this.draft(input);
    const names = pieces.map((p) => p.name);

    // Everyone who can see the polls channel right now has to vote yes; people
    // who join later don't raise the bar for votes already running.
    const voters = await guild.voters(this.deps.channelId);
    const requiredYes = Math.max(1, voters.length);

    const details = [
      description && `> ${description}`,
      tags.length > 0 && `Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`,
      names.length > 1 && `Cut into ${names.length} ${kind.plural}: ${names.map(kind.code).join(" ")}`,
    ].filter(Boolean);
    const poll = await this.deps.polls.create({
      kind: kind.pollKind,
      guildId: this.deps.guildId,
      channelId: this.deps.channelId,
      question: `Add the ${kind.display(name)}?`,
      description: [
        ...details,
        `Proposed by <@${proposerId}>. Needs ${requiredYes} yes ${requiredYes === 1 ? "vote" : "votes"}, one from everyone here.`,
        "@here",
      ].join("\n"),
      options: [
        { key: "yes", emoji: "✅", label: "Add it" },
        { key: "no", emoji: "❌", label: "Don't add it" },
      ],
      mode: "single",
      closesAt: new Date(this.now() + config.votingHours * 3_600_000),
      createdBy: proposerId,
      files: pieces.map((p) => ({ name: `${p.name}.${p.type.ext}`, data: p.image })),
      // Proposals ping @here, as they always have.
      mentions: true,
    });

    db.transaction((tx) => {
      tx.insert(proposals)
        .values({ pollId: poll.id, type: kind.type, name, description, tags, proposerId, requiredYes })
        .run();
      tx.insert(proposalImages)
        .values(
          pieces.map((p, position) => ({
            pollId: poll.id,
            position,
            name: p.name,
            image: Buffer.from(p.image),
            contentType: p.type.mime,
          })),
        )
        .run();
    });
    return { poll, names };
  }

  /** Adds the expression right away, without a vote. */
  async add(userId: string, input: ExpressionInput): Promise<CreatedExpression[]> {
    const { kind } = this;
    const { description, tags, pieces } = await this.draft(input);

    const created: CreatedExpression[] = [];
    for (const piece of pieces) {
      try {
        created.push(
          await this.deps.guild.create(kind.type, {
            name: piece.name,
            image: dataUrl(piece.type.mime, piece.image),
            description,
            tags,
            reason: `Added without a vote by user ${userId}`,
          }),
        );
      } catch (err) {
        if (!(err instanceof ExpressionRejected)) throw err;
        const added = pieces.slice(0, created.length).map((p) => kind.code(p.name));
        const before =
          added.length > 0 ? `${added.join(" ")} ${added.length === 1 ? "was" : "were"} added, but ` : "";
        throw new UserError(`${before}Fluxer refused the ${kind.display(piece.name)}: ${err.message}`);
      }
    }
    return created;
  }

  /** An admin approves or rejects before the vote ends. */
  async decide(
    slug: string,
    adminId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    const { poll } = this.requirePending(slug);
    this.setStatus(poll.id, { decision, decidedBy: adminId, reason });

    if (!(await this.deps.polls.close(poll.id))) {
      // The vote ended on its own in the meantime; let that outcome stand.
      this.deps.db
        .update(proposals)
        .set({ decision: null, decidedBy: null, reason: null })
        .where(and(eq(proposals.pollId, poll.id), eq(proposals.status, "pending")))
        .run();
      throw new UserError(`Voting on poll \`${poll.slug}\` has already ended.`);
    }
  }

  /** The proposer or an admin withdraws a proposal. */
  async cancel(slug: string, userId: string) {
    const { proposal, poll } = this.requirePending(slug);
    if (proposal.proposerId !== userId && !(await this.deps.access.isAdmin(userId))) {
      throw new UserError("Only the proposer or an admin can cancel a proposal.");
    }
    if (!(await this.deps.polls.cancel(poll.id))) {
      throw new UserError(`Voting on poll \`${poll.slug}\` has already ended.`);
    }
    this.setStatus(poll.id, { status: "cancelled", decidedBy: userId });
  }

  /** Ends the vote as soon as it has enough yes votes. */
  isDecided(poll: Poll, tally: Tally): boolean {
    const proposal = this.get(poll.id);
    return proposal?.status === "pending" && passes(proposal, tally);
  }

  async onClose(poll: Poll, tally: Tally) {
    const proposal = this.get(poll.id);
    if (!proposal) {
      console.warn(`poll ${poll.id}: no ${this.kind.noun} proposal stored for it`);
      return;
    }
    if (proposal.status !== "pending") return;

    const yes = tally.counts.yes ?? 0;
    const no = tally.counts.no ?? 0;
    const approved = proposal.decision
      ? proposal.decision === "approve"
      : passes(proposal, tally);

    const why = proposal.decision
      ? `${proposal.decision === "approve" ? "approved" : "rejected"} by <@${proposal.decidedBy}>` +
        (proposal.reason ? `: ${proposal.reason}` : "")
      : `${yes} yes, ${no} no, ${proposal.requiredYes} needed`;
    const subject = `the ${this.kind.display(proposal.name)}`;
    const mention = `<@${proposal.proposerId}>`;

    if (!approved) {
      this.setStatus(poll.id, { status: "rejected" });
      await this.announce(poll, `${mention} ${subject} was not added (${why}).`);
      return;
    }

    const images = this.images(poll.id);
    let existing: Expression[] | undefined;
    for (const image of images) {
      // Pieces added by an earlier attempt are skipped.
      if (image.expressionId) continue;
      try {
        // A previous attempt may also have added it before the bot went down.
        existing ??= await this.deps.guild.list(this.kind.type);
        const expressionId =
          existing.find((e) => e.name === image.name)?.id ??
          (
            await this.deps.guild.create(this.kind.type, {
              name: image.name,
              image: dataUrl(image.contentType, image.image),
              description: proposal.description,
              tags: proposal.tags,
              reason: `Voted in with poll ${poll.slug}, proposed by user ${proposal.proposerId}`,
            })
          ).id;
        this.deps.db
          .update(proposalImages)
          .set({ expressionId })
          .where(
            and(eq(proposalImages.pollId, poll.id), eq(proposalImages.position, image.position)),
          )
          .run();
      } catch (err) {
        if (!(err instanceof ExpressionRejected)) throw err;
        this.setStatus(poll.id, { status: "failed", error: err.message });
        const refused = images.length > 1 ? this.kind.code(image.name) : "it";
        await this.announce(
          poll,
          `${mention} ${subject} was approved (${why}) but Fluxer refused ${refused}: ${err.message}`,
        );
        return;
      }
    }

    this.setStatus(poll.id, { status: "added" });
    const as = images.length > 1 ? ` as ${images.map((i) => this.kind.code(i.name)).join(" ")}` : "";
    await this.announce(poll, `${mention} ${subject} has been added${as} (${why}).`);
  }

  describe(proposal: Proposal, poll: Poll): string {
    const pieces =
      this.deps.db
        .select({ n: count() })
        .from(proposalImages)
        .where(eq(proposalImages.pollId, poll.id))
        .get()?.n ?? 1;
    const cut = pieces > 1 ? ` in ${pieces} pieces` : "";
    return `\`${poll.slug}\` ${this.kind.display(proposal.name)}${cut} by <@${proposal.proposerId}>, needs ${proposal.requiredYes} yes, closes ${timestamp(poll.closesAt)}`;
  }

  /** Checks the input and gets its image ready, cut into pieces if it's wide or tall. */
  private async draft(input: ExpressionInput): Promise<Draft> {
    const { kind } = this;
    const description = input.description?.trim() || null;

    kind.checkName(input.name);
    if (description && description.length > STICKER_DESCRIPTION_MAX) {
      throw new UserError(`Descriptions can be at most ${STICKER_DESCRIPTION_MAX} characters long.`);
    }

    const info = await inspectImage(input.image);
    const names = kind.pieceNames(input.name, pieceCount(info, kind.maxPieces));
    await this.checkNamesFree(names);
    const images = await cutImage(input.image, info, {
      count: names.length,
      size: kind.size,
      maxBytes: this.deps.config.maxImageBytes,
    });
    return {
      name: input.name,
      description,
      tags: input.tags ?? [],
      pieces: images.map((image, i) => ({ ...image, name: names[i]! })),
    };
  }

  /** Throws when one of the names is taken or already up for a vote. */
  private async checkNamesFree(names: string[]) {
    const { kind } = this;
    const wanted = new Set(names.map((n) => n.toLowerCase()));

    const existing = (await this.deps.guild.list(kind.type)).find((e) =>
      wanted.has(e.name.toLowerCase()),
    );
    if (existing) throw new UserError(`The ${kind.display(existing.name)} already exists.`);

    const pending = this.deps.db
      .select({ name: proposalImages.name, slug: polls.slug })
      .from(proposalImages)
      .innerJoin(proposals, eq(proposals.pollId, proposalImages.pollId))
      .innerJoin(polls, eq(polls.id, proposalImages.pollId))
      .where(and(eq(proposals.type, kind.type), eq(proposals.status, "pending")))
      .all()
      .find((p) => wanted.has(p.name.toLowerCase()));
    if (pending) {
      throw new UserError(
        `The ${kind.display(pending.name)} is already up for a vote in poll \`${pending.slug}\`.`,
      );
    }
  }

  private requirePending(slug: string): { proposal: Proposal; poll: Poll } {
    const poll = this.deps.polls.bySlug(slug);
    const proposal = poll?.kind === this.kind.pollKind ? this.get(poll.id) : undefined;
    if (!poll || !proposal || proposal.status !== "pending") {
      throw new UserError(`There is no open ${this.kind.noun} proposal \`${slug}\`.`);
    }
    return { proposal, poll };
  }

  private setStatus(pollId: number, values: Partial<Proposal>) {
    this.deps.db.update(proposals).set(values).where(eq(proposals.pollId, pollId)).run();
  }

  private async announce(poll: Poll, content: string) {
    await this.deps.guild
      .send(poll.channelId, content, poll.messageId ?? undefined)
      .catch((err) => console.warn(`poll ${poll.id}: could not announce result:`, err));
  }
}

/** Enough yes votes, and more yes than no. */
function passes(proposal: Proposal, tally: Tally): boolean {
  const yes = tally.counts.yes ?? 0;
  const no = tally.counts.no ?? 0;
  return yes >= proposal.requiredYes && yes > no;
}

function dataUrl(mime: string, image: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(image).toString("base64")}`;
}
