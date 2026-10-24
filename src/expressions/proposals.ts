import { and, asc, eq } from "drizzle-orm";
import { UserError } from "../commands/command.ts";
import type { ProposalConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { polls, proposals } from "../db/schema.ts";
import type { GuildAccess } from "../permissions.ts";
import type { Poll, PollHandler, PollService, Tally } from "../polls/service.ts";
import { timestamp } from "../polls/service.ts";
import { formatKiB, sniffImage } from "./image.ts";

export type Proposal = typeof proposals.$inferSelect;
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
}

/** What expression proposals need from the guild. */
export interface ExpressionGuild {
  list(type: ExpressionType): Promise<Expression[]>;
  /** Throws ExpressionRejected when Fluxer refuses it for good. */
  create(type: ExpressionType, expression: NewExpression): Promise<string>;
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
  /** How the name is shown in messages, e.g. "emoji `:sadi:`". */
  display(name: string): string;
}

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
  display: (name) => `emoji \`:${name}:\``,
};

// Limits from Fluxer's GuildStickerCreateRequest schema.
const STICKER_DESCRIPTION_MAX = 500;
const STICKER_TAGS_MAX = 10;
const STICKER_TAG_LENGTH_MAX = 30;

export const STICKER: ExpressionKind = {
  type: "sticker",
  pollKind: "sticker-proposal",
  noun: "sticker",
  plural: "stickers",
  checkName(name) {
    if (name.length < 2 || name.length > 30) {
      throw new UserError("Sticker names must be 2 to 30 characters long.");
    }
  },
  display: (name) => `sticker \`${name}\``,
};

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

export interface ProposeInput {
  name: string;
  image: Uint8Array;
  /** Stickers only. */
  description?: string;
  /** Stickers only. */
  tags?: string[];
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

  pending(): { proposal: Proposal; poll: Poll }[] {
    return this.deps.db
      .select({ proposal: proposals, poll: polls })
      .from(proposals)
      .innerJoin(polls, eq(polls.id, proposals.pollId))
      .where(and(eq(proposals.type, this.kind.type), eq(proposals.status, "pending")))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  async propose(proposerId: string, input: ProposeInput): Promise<Poll> {
    const { config, db, access, guild } = this.deps;
    const { kind } = this;
    const { name, image } = input;
    const description = input.description?.trim() || null;
    const tags = input.tags ?? [];

    kind.checkName(name);
    if (description && description.length > STICKER_DESCRIPTION_MAX) {
      throw new UserError(`Descriptions can be at most ${STICKER_DESCRIPTION_MAX} characters long.`);
    }
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

    const type = sniffImage(image);
    if (!type) throw new UserError("The image must be a PNG, JPEG, GIF, WebP or AVIF file.");
    if (image.length > config.maxImageBytes) {
      throw new UserError(
        `The image is ${formatKiB(image.length)}; the limit is ${formatKiB(config.maxImageBytes)}.`,
      );
    }

    const lower = name.toLowerCase();
    if ((await guild.list(kind.type)).some((e) => e.name.toLowerCase() === lower)) {
      throw new UserError(`The ${kind.display(name)} already exists.`);
    }
    const duplicate = this.pending().find((p) => p.proposal.name.toLowerCase() === lower);
    if (duplicate) {
      throw new UserError(
        `The ${kind.display(name)} is already up for a vote in poll \`${duplicate.poll.slug}\`.`,
      );
    }

    // Everyone who can see the polls channel right now has to vote yes; people
    // who join later don't raise the bar for votes already running.
    const voters = await guild.voters(this.deps.channelId);
    const requiredYes = Math.max(1, voters.length);

    const details = [
      description && `> ${description}`,
      tags.length > 0 && `Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`,
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
      files: [{ name: `${name}.${type.ext}`, data: image }],
    });

    db.insert(proposals)
      .values({
        pollId: poll.id,
        type: kind.type,
        name,
        description,
        tags,
        image: Buffer.from(image),
        contentType: type.mime,
        proposerId,
        requiredYes,
      })
      .run();
    return poll;
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

    let expressionId: string;
    try {
      // A previous attempt may have created it before the bot went down.
      const existing = (await this.deps.guild.list(this.kind.type)).find(
        (e) => e.name === proposal.name,
      );
      expressionId =
        existing?.id ??
        (await this.deps.guild.create(this.kind.type, {
          name: proposal.name,
          image: `data:${proposal.contentType};base64,${proposal.image.toString("base64")}`,
          description: proposal.description,
          tags: proposal.tags,
        }));
    } catch (err) {
      if (!(err instanceof ExpressionRejected)) throw err;
      this.setStatus(poll.id, { status: "failed", error: err.message });
      await this.announce(
        poll,
        `${mention} ${subject} was approved (${why}) but Fluxer refused it: ${err.message}`,
      );
      return;
    }

    this.setStatus(poll.id, { status: "added", expressionId });
    await this.announce(poll, `${mention} ${subject} has been added (${why}).`);
  }

  describe(proposal: Proposal, poll: Poll): string {
    return `\`${poll.slug}\` ${this.kind.display(proposal.name)} by <@${proposal.proposerId}>, needs ${proposal.requiredYes} yes, closes ${timestamp(poll.closesAt)}`;
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
