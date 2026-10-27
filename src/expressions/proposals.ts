import { and, asc, count, eq } from "drizzle-orm";
import { UserError } from "../commands/command.ts";
import type { ProposalConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { polls, proposalImages, proposals } from "../db/schema.ts";
import type { GuildAccess } from "../permissions.ts";
import type { Poll, PollHandler, PollService, Tally } from "../polls/service.ts";
import { timestamp } from "../polls/service.ts";
import { SOURCE_MAX_BYTES } from "./image.ts";
import { cutImage, inspectImage, type ProcessedImage, pieceCount } from "./process.ts";

export type Proposal = typeof proposals.$inferSelect;
export type ProposalImage = typeof proposalImages.$inferSelect;
export type ExpressionType = Proposal["type"];

export interface Expression {
  id: string;
  name: string;
  /** Whether the bot added it. */
  mine: boolean;
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
  /**
   * Deletes an expression; one that is already gone counts as deleted.
   * Throws ExpressionRejected when Fluxer refuses for good.
   */
  remove(type: ExpressionType, id: string, reason: string): Promise<void>;
  send(channelId: string, content: string, replyTo?: string): Promise<void>;
  /** IDs of the non-bot members who can see the channel. */
  voters(channelId: string): Promise<string[]>;
}

/** Fluxer refused the request (bad image, slot limit, missing permission, ...); retrying won't help. */
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
    const fitted = truncate(name.trim(), STICKER_NAME_MAX).trimEnd();
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
    return truncate(name, max - suffix.length).trimEnd() + suffix;
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts text to at most `max` UTF-16 code units, which is how Fluxer counts,
 * without splitting a character such as an emoji.
 */
function truncate(text: string, max: number): string {
  let cut = "";
  for (const { segment } of graphemes.segment(text)) {
    if (cut.length + segment.length > max) break;
    cut += segment;
  }
  return cut;
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

/** One emoji or sticker being added, and how far it got. */
interface Piece {
  position: number;
  name: string;
  /** `data:` URL of the image. */
  image: string;
  /** Set once Fluxer has it, possibly by an earlier attempt. */
  expressionId: string | null;
}

interface AddOptions {
  description: string | null;
  tags: string[];
  /** For the audit log. */
  reason: string;
  /**
   * Keep what was added when Fluxer can't be reached, for a later attempt to
   * pick up. Without it, those errors roll back too.
   */
  resume: boolean;
  /** Stores a piece's ID as soon as it is added or deleted. */
  save?(piece: Piece, expressionId: string | null): void;
}

type AddOutcome =
  | { status: "added"; created: CreatedExpression[] }
  /** A piece couldn't be added; the ones before it were rolled back, except `kept`. */
  | { status: "refused"; piece: string; problem: string; kept: string[] }
  /** Only without `resume`: something else went wrong, and was rolled back except `kept`. */
  | { status: "failed"; error: unknown; kept: string[] };

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
  /** Lowercased names a command is adding or proposing right now. */
  private readonly reserved = new Set<string>();
  /** Proposals each user has in the works, which count towards `maxOpenPerUser`. */
  private readonly preparing = new Map<string, number>();

  constructor(
    readonly kind: ExpressionKind,
    private readonly deps: ExpressionProposalsDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Largest image worth downloading. */
  get downloadLimit(): number {
    return Math.max(SOURCE_MAX_BYTES, this.deps.config.maxImageBytes);
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
    const { config, access } = this.deps;
    const { kind } = this;

    if (
      config.proposerRoleIds.length > 0 &&
      !(await access.hasAnyRole(proposerId, config.proposerRoleIds))
    ) {
      throw new UserError(`You don't have a role that can propose ${kind.plural}.`);
    }
    // Proposals still being prepared count too, so commands sent at the same
    // time can't get past the limit while their images are processed.
    const preparing = this.preparing.get(proposerId) ?? 0;
    const open =
      this.pending().filter((p) => p.proposal.proposerId === proposerId).length + preparing;
    if (open >= config.maxOpenPerUser) {
      throw new UserError(
        `You already have ${open} open ${kind.noun} proposals; wait for one to finish first.`,
      );
    }

    this.preparing.set(proposerId, preparing + 1);
    try {
      return await this.withDraft(input, (draft) => this.post(proposerId, draft));
    } finally {
      const left = this.preparing.get(proposerId)! - 1;
      if (left > 0) this.preparing.set(proposerId, left);
      else this.preparing.delete(proposerId);
    }
  }

  /** Posts the poll for a proposal and stores it. */
  private async post(
    proposerId: string,
    { name, description, tags, pieces }: Draft,
  ): Promise<{ poll: Poll; names: string[] }> {
    const { config, db, guild } = this.deps;
    const { kind } = this;
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

  /**
   * Adds the expression right away, without a vote. The pieces of a cut image
   * go in together or not at all.
   */
  async add(userId: string, input: ExpressionInput): Promise<CreatedExpression[]> {
    return this.withDraft(input, (draft) => this.addNow(userId, draft));
  }

  private async addNow(
    userId: string,
    { name, description, tags, pieces }: Draft,
  ): Promise<CreatedExpression[]> {
    const { kind } = this;

    const outcome = await this.addPieces(
      pieces.map((p, position) => ({
        position,
        name: p.name,
        image: dataUrl(p.type.mime, p.image),
        expressionId: null,
      })),
      { description, tags, reason: `Added without a vote by user ${userId}`, resume: false },
    );
    switch (outcome.status) {
      case "added":
        return outcome.created;
      case "refused":
        throw new UserError(
          pieces.length === 1
            ? `Couldn't add the ${kind.display(name)}: ${outcome.problem}.`
            : `Couldn't add ${kind.code(outcome.piece)}: ${outcome.problem}. ` +
                rolledBack(kind, pieces.length, outcome.kept),
        );
      case "failed":
        if (outcome.kept.length === 0) throw outcome.error;
        console.error(`adding the ${kind.noun} ${name} failed:`, outcome.error);
        throw new UserError(`Adding the ${kind.display(name)} failed. ${notRemoved(kind, outcome.kept)}`);
    }
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
    const outcome = await this.addPieces(
      images.map((image) => ({
        position: image.position,
        name: image.name,
        image: dataUrl(image.contentType, image.image),
        expressionId: image.expressionId,
      })),
      {
        description: proposal.description,
        tags: proposal.tags,
        reason: `Voted in with poll ${poll.slug}, proposed by user ${proposal.proposerId}`,
        // Network trouble leaves the poll closed; the next attempt picks up here.
        resume: true,
        save: (piece, expressionId) => this.setExpressionId(poll.id, piece.position, expressionId),
      },
    );
    if (outcome.status === "failed") throw outcome.error;
    if (outcome.status === "refused") {
      this.setStatus(poll.id, { status: "failed", error: outcome.problem });
      await this.announce(
        poll,
        images.length === 1
          ? `${mention} ${subject} was approved (${why}) but couldn't be added: ${outcome.problem}.`
          : `${mention} ${subject} was approved (${why}) but ${this.kind.code(outcome.piece)} ` +
              `couldn't be added: ${outcome.problem}. ${rolledBack(this.kind, images.length, outcome.kept)}`,
      );
      return;
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

  /**
   * Checks the input, gets its image ready and hands the result to `use`.
   * The names stay reserved until `use` is done, so another command can't take
   * them while this one is still processing the image or posting the poll.
   */
  private async withDraft<T>(input: ExpressionInput, use: (draft: Draft) => Promise<T>): Promise<T> {
    const { kind } = this;
    const description = input.description?.trim() || null;

    kind.checkName(input.name);
    if (description && description.length > STICKER_DESCRIPTION_MAX) {
      throw new UserError(`Descriptions can be at most ${STICKER_DESCRIPTION_MAX} characters long.`);
    }

    const info = await inspectImage(input.image);
    const names = kind.pieceNames(input.name, pieceCount(info, kind.maxPieces));
    this.reserve(names);
    try {
      await this.checkNotInGuild(names);
      const images = await cutImage(input.image, info, {
        count: names.length,
        size: kind.size,
        maxBytes: this.deps.config.maxImageBytes,
      });
      return await use({
        name: input.name,
        description,
        tags: input.tags ?? [],
        pieces: images.map((image, i) => ({ ...image, name: names[i]! })),
      });
    } finally {
      for (const name of names) this.reserved.delete(name.toLowerCase());
    }
  }

  /**
   * Claims the names, or throws when one is up for a vote or being added by
   * another command. Nothing in here awaits, so two commands can't both pass.
   */
  private reserve(names: string[]) {
    const { kind } = this;
    const wanted = names.map((n) => n.toLowerCase());

    const busy = names.find((n) => this.reserved.has(n.toLowerCase()));
    if (busy) throw new UserError(`Someone else is adding the ${kind.display(busy)} right now.`);

    const pending = this.deps.db
      .select({ name: proposalImages.name, slug: polls.slug })
      .from(proposalImages)
      .innerJoin(proposals, eq(proposals.pollId, proposalImages.pollId))
      .innerJoin(polls, eq(polls.id, proposalImages.pollId))
      .where(and(eq(proposals.type, kind.type), eq(proposals.status, "pending")))
      .all()
      .find((p) => wanted.includes(p.name.toLowerCase()));
    if (pending) {
      throw new UserError(
        `The ${kind.display(pending.name)} is already up for a vote in poll \`${pending.slug}\`.`,
      );
    }

    for (const name of wanted) this.reserved.add(name);
  }

  /** Throws when the guild already has one of the names. */
  private async checkNotInGuild(names: string[]) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const existing = (await this.deps.guild.list(this.kind.type)).find((e) =>
      wanted.has(e.name.toLowerCase()),
    );
    if (existing) throw new UserError(`The ${this.kind.display(existing.name)} already exists.`);
  }

  private requirePending(slug: string): { proposal: Proposal; poll: Poll } {
    const poll = this.deps.polls.bySlug(slug);
    const proposal = poll?.kind === this.kind.pollKind ? this.get(poll.id) : undefined;
    if (!poll || !proposal || proposal.status !== "pending") {
      throw new UserError(`There is no open ${this.kind.noun} proposal \`${slug}\`.`);
    }
    return { proposal, poll };
  }

  /**
   * Adds the pieces that have no ID yet, in order, so that they go in together
   * or not at all. When Fluxer refuses one, or someone else has since added an
   * expression with its name, the pieces added so far are deleted again.
   */
  private async addPieces(pieces: Piece[], options: AddOptions): Promise<AddOutcome> {
    const { guild } = this.deps;
    const { kind } = this;
    const created: CreatedExpression[] = [];
    let current: Piece | undefined;
    let refusal: { piece: string; problem: string } | undefined;

    try {
      const existing = await guild.list(kind.type);
      for (const piece of pieces) {
        if (piece.expressionId) continue;
        current = piece;
        const lower = piece.name.toLowerCase();
        const same = existing.find((e) => e.name.toLowerCase() === lower);
        // When resuming, the bot may have added it just before it went down,
        // without saving the ID. Anyone else's is in the way.
        if (same && !(options.resume && same.mine)) {
          refusal = {
            piece: piece.name,
            problem: `another ${kind.noun} with that name was added in the meantime`,
          };
          break;
        }
        let id = same?.id;
        if (!id) {
          const added = await guild.create(kind.type, {
            name: piece.name,
            image: piece.image,
            description: options.description,
            tags: options.tags,
            reason: options.reason,
          });
          created.push(added);
          id = added.id;
        }
        this.setPieceId(piece, id, options);
      }
    } catch (err) {
      if (!(err instanceof ExpressionRejected)) {
        if (options.resume) throw err;
        const kept = await this.removePieces(pieces, `Rolled back: adding ${current?.name} failed`, options);
        return { status: "failed", error: err, kept };
      }
      refusal = { piece: current!.name, problem: `Fluxer refused it (${err.message})` };
    }

    if (!refusal) return { status: "added", created };
    const kept = await this.removePieces(
      pieces,
      `Rolled back: ${refusal.piece} couldn't be added`,
      options,
    );
    return { status: "refused", ...refusal, kept };
  }

  /**
   * Deletes the pieces that have an ID and returns the names of those left
   * in the guild. When resuming, errors other than a refusal are thrown
   * instead; the next attempt runs into the same problem and finishes the job.
   */
  private async removePieces(pieces: Piece[], reason: string, options: AddOptions): Promise<string[]> {
    const kept: string[] = [];
    for (const piece of pieces) {
      if (!piece.expressionId) continue;
      try {
        await this.deps.guild.remove(this.kind.type, piece.expressionId, reason);
      } catch (err) {
        if (options.resume && !(err instanceof ExpressionRejected)) throw err;
        console.warn(`could not roll back the ${this.kind.display(piece.name)}:`, err);
        kept.push(piece.name);
        continue;
      }
      this.setPieceId(piece, null, options);
    }
    return kept;
  }

  private setPieceId(piece: Piece, expressionId: string | null, options: AddOptions) {
    piece.expressionId = expressionId;
    options.save?.(piece, expressionId);
  }

  private setExpressionId(pollId: number, position: number, expressionId: string | null) {
    this.deps.db
      .update(proposalImages)
      .set({ expressionId })
      .where(and(eq(proposalImages.pollId, pollId), eq(proposalImages.position, position)))
      .run();
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

/** What a rollback of `count` pieces left behind, as a sentence. */
function rolledBack(kind: ExpressionKind, count: number, kept: string[]): string {
  return kept.length === 0 ? `None of the ${count} ${kind.plural} were added.` : notRemoved(kind, kept);
}

/** e.g. "`:sadi_1:` couldn't be removed again; it has to be deleted by hand." */
function notRemoved(kind: ExpressionKind, names: string[]): string {
  const subject = names.length === 1 ? "it has" : "they have";
  return `${names.map(kind.code).join(" ")} couldn't be removed again; ${subject} to be deleted by hand.`;
}

function dataUrl(mime: string, image: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(image).toString("base64")}`;
}
