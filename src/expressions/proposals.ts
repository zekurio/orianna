import { and, asc, count, eq } from "drizzle-orm";
import { type Cause, Clock, Context, Data, Effect, Exit } from "effect";
import { refuse, type UserError } from "../commands/command.ts";
import type { ProposalConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { polls, proposalImages, proposals } from "../db/schema.ts";
import type { FluxerError } from "../fluxer.ts";
import { defuseEveryone } from "../messages/body.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { type Poll, type PollHandler, PollService, type Tally, timestamp } from "../polls/service.ts";
import { SOURCE_MAX_BYTES } from "./image.ts";
import { ImageMagick, type ProcessedImage, pieceCount } from "./process.ts";

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
export class ExpressionGuild extends Context.Service<
  ExpressionGuild,
  {
    readonly list: (type: ExpressionType) => Effect.Effect<Expression[], FluxerError>;
    /** Fails with ExpressionRejected when Fluxer refuses it for good. */
    readonly create: (
      type: ExpressionType,
      expression: NewExpression,
    ) => Effect.Effect<CreatedExpression, ExpressionRejected | FluxerError>;
    /**
     * Deletes an expression; one that is already gone counts as deleted.
     * Fails with ExpressionRejected when Fluxer refuses for good.
     */
    readonly remove: (
      type: ExpressionType,
      id: string,
      reason: string,
    ) => Effect.Effect<void, ExpressionRejected | FluxerError>;
    /** Mentions in `content` notify only the users in `notify`. */
    readonly send: (
      channelId: string,
      content: string,
      notify: readonly string[],
      replyTo?: string,
    ) => Effect.Effect<void, FluxerError>;
    /** IDs of the non-bot members who can see the channel. */
    readonly voters: (channelId: string) => Effect.Effect<string[], FluxerError>;
  }
>()("orianna/ExpressionGuild") {}

/** Fluxer refused the request (bad image, slot limit, missing permission, ...); retrying won't help. */
export class ExpressionRejected extends Data.TaggedError("ExpressionRejected")<{
  readonly message: string;
}> {}

/** How one kind of expression differs from the other. */
export interface ExpressionKind {
  type: ExpressionType;
  /** Poll kind registered with the poll service. */
  pollKind: string;
  /** "emoji", "sticker" */
  noun: string;
  /** "emojis", "stickers" */
  plural: string;
  /** Fails with a UserError when Fluxer would refuse the name. */
  checkName(name: string): Effect.Effect<void, UserError>;
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
const EMOJI_NAME = new RegExp(`^[A-Za-z0-9_]{2,${EMOJI_NAME_MAX}}$`);

export const EMOJI: ExpressionKind = {
  type: "emoji",
  pollKind: "emoji-proposal",
  noun: "emoji",
  plural: "emojis",
  checkName: (name) =>
    EMOJI_NAME.test(name)
      ? Effect.void
      : refuse(
          `Emoji names must be 2 to ${EMOJI_NAME_MAX} characters long and use only letters, digits and underscores.`,
        ),
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
  checkName: (name) =>
    name.length < 2 || name.length > STICKER_NAME_MAX
      ? refuse(`Sticker names must be 2 to ${STICKER_NAME_MAX} characters long.`)
      : Effect.void,
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
export function parseTags(input: string | undefined): Effect.Effect<string[], UserError> {
  if (!input) return Effect.succeed([]);
  const tags = [
    ...new Set(
      input
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (tags.length > STICKER_TAGS_MAX) {
    return refuse(`A sticker can have at most ${STICKER_TAGS_MAX} tags.`);
  }
  const long = tags.find((t) => t.length > STICKER_TAG_LENGTH_MAX);
  if (long) {
    return refuse(`Tags can be at most ${STICKER_TAG_LENGTH_MAX} characters long: \`${long}\`.`);
  }
  return Effect.succeed(tags);
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
  | { status: "failed"; cause: Cause.Cause<FluxerError>; kept: string[] };

export interface ProposalSettings {
  config: ProposalConfig;
  guildId: string;
  /** Where proposal polls are posted. */
  channelId: string;
}

export type ExpressionProposals = Effect.Success<ReturnType<typeof makeExpressionProposals>>;

/** Proposals for one kind of expression. Registers its poll kind with the poll service. */
export const makeExpressionProposals = Effect.fnUntraced(function* (
  kind: ExpressionKind,
  { config, guildId, channelId }: ProposalSettings,
) {
  const db = yield* Database;
  const pollService = yield* PollService;
  const guild = yield* ExpressionGuild;
  const access = yield* GuildAccess;
  const magick = yield* ImageMagick;
  /** Lowercased names a command is adding or proposing right now. */
  const reserved = new Set<string>();
  /** Proposals each user has in the works, which count towards `maxOpenPerUser`. */
  const preparing = new Map<string, number>();

  function get(pollId: number): Proposal | undefined {
    return db
      .select()
      .from(proposals)
      .where(and(eq(proposals.pollId, pollId), eq(proposals.type, kind.type)))
      .get();
  }

  /** The images a proposal adds, in order. */
  function images(pollId: number): ProposalImage[] {
    return db
      .select()
      .from(proposalImages)
      .where(eq(proposalImages.pollId, pollId))
      .orderBy(asc(proposalImages.position))
      .all();
  }

  function pending(): { proposal: Proposal; poll: Poll }[] {
    return db
      .select({ proposal: proposals, poll: polls })
      .from(proposals)
      .innerJoin(polls, eq(polls.id, proposals.pollId))
      .where(and(eq(proposals.type, kind.type), eq(proposals.status, "pending")))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  /** Puts the expression up for a vote. Returns the poll and the names it would add. */
  const propose = Effect.fn("ExpressionProposals.propose")(function* (
    proposerId: string,
    input: ExpressionInput,
  ) {
    // Proposals still being prepared count too, so commands sent at the same
    // time can't get past the limit while their images are processed.
    const inWorks = preparing.get(proposerId) ?? 0;
    const open = pending().filter((p) => p.proposal.proposerId === proposerId).length + inWorks;
    if (open >= config.maxOpenPerUser) {
      return yield* refuse(
        `You already have ${open} open ${kind.noun} proposals; wait for one to finish first.`,
      );
    }

    preparing.set(proposerId, inWorks + 1);
    return yield* withDraft(input, (draft) => post(proposerId, draft)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const left = preparing.get(proposerId)! - 1;
          if (left > 0) preparing.set(proposerId, left);
          else preparing.delete(proposerId);
        }),
      ),
    );
  });

  /** Posts the poll for a proposal and stores it. */
  const post = Effect.fnUntraced(function* (proposerId: string, { name, description, tags, pieces }: Draft) {
    const names = pieces.map((p) => p.name);

    // The bar is set now, so people who join later and config changes don't
    // move it for votes already running. It rounds up from just below the
    // exact share, since 0.7 × 10 comes out as 7.000000000000001.
    const voters = yield* guild.voters(channelId);
    const members = Math.max(1, voters.length);
    const requiredYes = Math.max(1, Math.ceil(members * config.threshold - 1e-9));
    const needs =
      requiredYes < members
        ? `${requiredYes} of the ${members} people here to vote yes`
        : members === 1
          ? "a yes vote"
          : `all ${members} people here to vote yes`;

    // The poll lets @everyone and @here notify, for the @here at the end, so
    // they're defused in the name, description and tags the proposer typed.
    const details = [
      description && `> ${defuseEveryone(description)}`,
      tags.length > 0 && `Tags: ${tags.map((t) => `\`${defuseEveryone(t)}\``).join(", ")}`,
      names.length > 1 &&
        `Cut into ${names.length} ${kind.plural}: ${names.map((n) => kind.code(defuseEveryone(n))).join(" ")}`,
    ].filter(Boolean);
    const now = yield* Clock.currentTimeMillis;
    const poll = yield* pollService.create({
      kind: kind.pollKind,
      guildId,
      channelId,
      question: `Add the ${kind.display(defuseEveryone(name))}?`,
      description: [...details, `Proposed by <@${proposerId}>. Needs ${needs}.`, "@here"].join("\n"),
      options: [
        { key: "yes", emoji: "✅", label: "Add it" },
        { key: "no", emoji: "❌", label: "Don't add it" },
      ],
      mode: "single",
      closesAt: new Date(now + config.votingHours * 3_600_000),
      createdBy: proposerId,
      files: pieces.map((p) => ({ name: `${p.name}.${p.type.ext}`, data: p.image })),
      // Proposals ping @here, as they always have.
      everyone: true,
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
  });

  /**
   * Adds the expression right away, without a vote. The pieces of a cut image
   * go in together or not at all.
   */
  const add = Effect.fn("ExpressionProposals.add")(function* (userId: string, input: ExpressionInput) {
    return yield* withDraft(input, (draft) => addNow(userId, draft));
  });

  const addNow = Effect.fnUntraced(function* (userId: string, { name, description, tags, pieces }: Draft) {
    const outcome = yield* addPieces(
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
        return yield* refuse(
          pieces.length === 1
            ? `Couldn't add the ${kind.display(name)}: ${outcome.problem}.`
            : `Couldn't add ${kind.code(outcome.piece)}: ${outcome.problem}. ` +
                rolledBack(kind, pieces.length, outcome.kept),
        );
      case "failed":
        if (outcome.kept.length === 0) return yield* Effect.failCause(outcome.cause);
        yield* Effect.logError(`adding the ${kind.noun} ${name} failed`, outcome.cause);
        return yield* refuse(`Adding the ${kind.display(name)} failed. ${notRemoved(kind, outcome.kept)}`);
    }
  });

  /** Someone with the decide permission approves or rejects before the vote ends. */
  const decide = Effect.fn("ExpressionProposals.decide")(function* (
    slug: string,
    deciderId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    const { poll } = yield* requirePending(slug);
    setStatus(poll.id, { decision, decidedBy: deciderId, reason });

    if (!(yield* pollService.close(poll.id))) {
      // The vote ended on its own in the meantime; let that outcome stand.
      db.update(proposals)
        .set({ decision: null, decidedBy: null, reason: null })
        .where(and(eq(proposals.pollId, poll.id), eq(proposals.status, "pending")))
        .run();
      return yield* refuse(`Voting on poll \`${poll.slug}\` has already ended.`);
    }
  });

  /** The proposer, or someone with the cancel-any permission, withdraws a proposal. */
  const cancel = Effect.fn("ExpressionProposals.cancel")(function* (slug: string, userId: string) {
    const { proposal, poll } = yield* requirePending(slug);
    const anyone = `${kind.type}.cancel-any` as const;
    if (proposal.proposerId !== userId && !(yield* access.can(userId, anyone))) {
      return yield* refuse(`Only the proposer, or someone with \`${anyone}\`, can cancel a proposal.`);
    }
    if (!(yield* pollService.cancel(poll.id))) {
      return yield* refuse(`Voting on poll \`${poll.slug}\` has already ended.`);
    }
    setStatus(poll.id, { status: "cancelled", decidedBy: userId });
  });

  const onClose = Effect.fnUntraced(function* (poll: Poll, tally: Tally) {
    const proposal = get(poll.id);
    if (!proposal) {
      yield* Effect.logWarning(`poll ${poll.id}: no ${kind.noun} proposal stored for it`);
      return;
    }
    if (proposal.status !== "pending") return;

    const yes = tally.counts.yes ?? 0;
    const no = tally.counts.no ?? 0;
    const approved = proposal.decision ? proposal.decision === "approve" : passes(proposal, tally);

    const why = proposal.decision
      ? `${proposal.decision === "approve" ? "approved" : "rejected"} by <@${proposal.decidedBy}>` +
        (proposal.reason ? `: ${proposal.reason}` : "")
      : `${yes} yes, ${no} no, ${proposal.requiredYes} needed`;
    const subject = `the ${kind.display(proposal.name)}`;
    const mention = `<@${proposal.proposerId}>`;

    if (!approved) {
      setStatus(poll.id, { status: "rejected" });
      yield* announce(poll, proposal, `${mention} ${subject} was not added (${why}).`);
      return;
    }

    const stored = images(poll.id);
    const outcome = yield* addPieces(
      stored.map((image) => ({
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
        save: (piece, expressionId) => setExpressionId(poll.id, piece.position, expressionId),
      },
    );
    if (outcome.status === "failed") return yield* Effect.failCause(outcome.cause);
    if (outcome.status === "refused") {
      setStatus(poll.id, { status: "failed", error: outcome.problem });
      yield* announce(
        poll,
        proposal,
        stored.length === 1
          ? `${mention} ${subject} was approved (${why}) but couldn't be added: ${outcome.problem}.`
          : `${mention} ${subject} was approved (${why}) but ${kind.code(outcome.piece)} ` +
              `couldn't be added: ${outcome.problem}. ${rolledBack(kind, stored.length, outcome.kept)}`,
      );
      return;
    }

    setStatus(poll.id, { status: "added" });
    const as = stored.length > 1 ? ` as ${stored.map((i) => kind.code(i.name)).join(" ")}` : "";
    yield* announce(poll, proposal, `${mention} ${subject} has been added${as} (${why}).`);
  });

  function describe(proposal: Proposal, poll: Poll): string {
    const pieces = db
      .select({ n: count() })
      .from(proposalImages)
      .where(eq(proposalImages.pollId, poll.id))
      .get()!.n;
    const cut = pieces > 1 ? ` in ${pieces} pieces` : "";
    return `\`${poll.slug}\` ${kind.display(proposal.name)}${cut} by <@${proposal.proposerId}>, needs ${proposal.requiredYes} yes, closes ${timestamp(poll.closesAt)}`;
  }

  /**
   * Checks the input, gets its image ready and hands the result to `use`.
   * The names stay reserved until `use` is done, so another command can't take
   * them while this one is still processing the image or posting the poll.
   */
  function withDraft<A, E>(input: ExpressionInput, use: (draft: Draft) => Effect.Effect<A, E>) {
    return Effect.gen(function* () {
      const description = input.description?.trim() || null;

      yield* kind.checkName(input.name);
      if (description && description.length > STICKER_DESCRIPTION_MAX) {
        return yield* refuse(`Descriptions can be at most ${STICKER_DESCRIPTION_MAX} characters long.`);
      }

      const info = yield* magick.inspect(input.image);
      const names = kind.pieceNames(input.name, pieceCount(info, kind.maxPieces));
      return yield* Effect.acquireUseRelease(
        reserve(names),
        () =>
          Effect.gen(function* () {
            yield* checkNotInGuild(names);
            const images = yield* magick.cut(input.image, info, {
              count: names.length,
              size: kind.size,
              maxBytes: config.maxImageBytes,
            });
            return yield* use({
              name: input.name,
              description,
              tags: input.tags ?? [],
              pieces: images.map((image, i) => ({ ...image, name: names[i]! })),
            });
          }),
        () =>
          Effect.sync(() => {
            for (const name of names) reserved.delete(name.toLowerCase());
          }),
      );
    });
  }

  /**
   * Claims the names, or fails when one is up for a vote or being added by
   * another command. Nothing in here yields, so two commands can't both pass.
   */
  function reserve(names: string[]): Effect.Effect<void, UserError> {
    return Effect.suspend(() => {
      const wanted = names.map((n) => n.toLowerCase());

      const busy = names.find((n) => reserved.has(n.toLowerCase()));
      if (busy) return refuse(`Someone else is adding the ${kind.display(busy)} right now.`);

      const taken = db
        .select({ name: proposalImages.name, slug: polls.slug })
        .from(proposalImages)
        .innerJoin(proposals, eq(proposals.pollId, proposalImages.pollId))
        .innerJoin(polls, eq(polls.id, proposalImages.pollId))
        .where(and(eq(proposals.type, kind.type), eq(proposals.status, "pending")))
        .all()
        .find((p) => wanted.includes(p.name.toLowerCase()));
      if (taken) {
        return refuse(`The ${kind.display(taken.name)} is already up for a vote in poll \`${taken.slug}\`.`);
      }

      for (const name of wanted) reserved.add(name);
      return Effect.void;
    });
  }

  /** Fails when the guild already has one of the names. */
  const checkNotInGuild = Effect.fnUntraced(function* (names: string[]) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const existing = (yield* guild.list(kind.type)).find((e) => wanted.has(e.name.toLowerCase()));
    if (existing) return yield* refuse(`The ${kind.display(existing.name)} already exists.`);
  });

  function requirePending(slug: string): Effect.Effect<{ proposal: Proposal; poll: Poll }, UserError> {
    const poll = pollService.bySlug(slug);
    const proposal = poll?.kind === kind.pollKind ? get(poll.id) : undefined;
    if (!poll || !proposal || proposal.status !== "pending") {
      return refuse(`There is no open ${kind.noun} proposal \`${slug}\`.`);
    }
    return Effect.succeed({ proposal, poll });
  }

  /**
   * Adds the pieces that have no ID yet, in order, so that they go in together
   * or not at all. When Fluxer refuses one, or someone else has since added an
   * expression with its name, the pieces added so far are deleted again. Runs
   * to the end even when interrupted, so a rollback is never cut short.
   */
  function addPieces(pieces: Piece[], options: AddOptions): Effect.Effect<AddOutcome, FluxerError> {
    return Effect.gen(function* () {
      const created: CreatedExpression[] = [];
      let current: Piece | undefined;
      let refusal: { piece: string; problem: string } | undefined;

      const exit = yield* Effect.gen(function* () {
        const existing = yield* guild.list(kind.type);
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
            return;
          }
          let id = same?.id;
          if (!id) {
            const added = yield* guild.create(kind.type, {
              name: piece.name,
              image: piece.image,
              description: options.description,
              tags: options.tags,
              reason: options.reason,
            });
            created.push(added);
            id = added.id;
          }
          setPieceId(piece, id, options);
        }
      }).pipe(
        Effect.catchTag("ExpressionRejected", (err) =>
          Effect.sync(() => {
            refusal = { piece: current!.name, problem: `Fluxer refused it (${err.message})` };
          }),
        ),
        Effect.exit,
      );

      if (Exit.isFailure(exit)) {
        if (options.resume) return yield* Effect.failCause(exit.cause);
        const kept = yield* removePieces(pieces, `Rolled back: adding ${current?.name} failed`, options);
        const outcome: AddOutcome = { status: "failed", cause: exit.cause, kept };
        return outcome;
      }
      if (!refusal) {
        const outcome: AddOutcome = { status: "added", created };
        return outcome;
      }
      const kept = yield* removePieces(pieces, `Rolled back: ${refusal.piece} couldn't be added`, options);
      const outcome: AddOutcome = { status: "refused", ...refusal, kept };
      return outcome;
    }).pipe(Effect.uninterruptible);
  }

  /**
   * Deletes the pieces that have an ID and returns the names of those left
   * in the guild. When resuming, failures other than a refusal are passed on
   * instead; the next attempt runs into the same problem and finishes the job.
   */
  const removePieces = Effect.fnUntraced(function* (pieces: Piece[], reason: string, options: AddOptions) {
    const kept: string[] = [];
    for (const piece of pieces) {
      if (!piece.expressionId) continue;
      const removed = yield* guild.remove(kind.type, piece.expressionId, reason).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          options.resume && err._tag !== "ExpressionRejected"
            ? Effect.fail(err)
            : Effect.logWarning(`could not roll back the ${kind.display(piece.name)}: ${err.message}`).pipe(
                Effect.as(false),
              ),
        ),
      );
      if (!removed) {
        kept.push(piece.name);
        continue;
      }
      setPieceId(piece, null, options);
    }
    return kept;
  });

  function setPieceId(piece: Piece, expressionId: string | null, options: AddOptions) {
    piece.expressionId = expressionId;
    options.save?.(piece, expressionId);
  }

  function setExpressionId(pollId: number, position: number, expressionId: string | null) {
    db.update(proposalImages)
      .set({ expressionId })
      .where(and(eq(proposalImages.pollId, pollId), eq(proposalImages.position, position)))
      .run();
  }

  function setStatus(pollId: number, values: Partial<Proposal>) {
    db.update(proposals).set(values).where(eq(proposals.pollId, pollId)).run();
  }

  /** Pings only the proposer; the name and the decider's reason may hold mentions too. */
  function announce(poll: Poll, proposal: Proposal, content: string) {
    return guild
      .send(poll.channelId, content, [proposal.proposerId], poll.messageId ?? undefined)
      .pipe(Effect.catch((err) => Effect.logWarning(`poll ${poll.id}: could not announce result: ${err.reason}`)));
  }

  const handler: PollHandler = {
    onClose,
    /** Ends the vote as soon as it has enough yes votes. */
    isDecided(poll, tally) {
      const proposal = get(poll.id);
      return proposal?.status === "pending" && passes(proposal, tally);
    },
  };
  pollService.register(kind.pollKind, handler);

  return {
    kind,
    /** Largest image worth downloading. */
    downloadLimit: Math.max(SOURCE_MAX_BYTES, config.maxImageBytes),
    pending,
    describe,
    propose,
    add,
    decide,
    cancel,
  };
});

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
