import { and, asc, eq } from "drizzle-orm";
import { UserError } from "../commands/command.ts";
import type { EmojiConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { emojiProposals, polls } from "../db/schema.ts";
import type { GuildAccess } from "../permissions.ts";
import type { Poll, PollHandler, PollService, Tally } from "../polls/service.ts";
import { timestamp } from "../polls/service.ts";
import { formatKiB, sniffImage } from "./image.ts";

export const EMOJI_POLL_KIND = "emoji-proposal";

export type Proposal = typeof emojiProposals.$inferSelect;

/** What emoji proposals need from the guild. */
export interface EmojiGuild {
  emojis(): Promise<{ id: string; name: string }[]>;
  /** Throws EmojiRejected when Fluxer refuses the emoji for good. */
  createEmoji(name: string, image: string): Promise<string>;
  send(channelId: string, content: string, replyTo?: string): Promise<void>;
}

/** Fluxer refused the emoji (bad image, slot limit, ...); retrying won't help. */
export class EmojiRejected extends Error {
  override name = "EmojiRejected";
}

const NAME = /^[A-Za-z0-9_]{2,32}$/;

export function checkName(name: string) {
  if (!NAME.test(name)) {
    throw new UserError(
      "Emoji names must be 2 to 32 characters long and use only letters, digits and underscores.",
    );
  }
}

export interface EmojiProposalsDeps {
  db: DB;
  polls: PollService;
  guild: EmojiGuild;
  access: GuildAccess;
  config: EmojiConfig;
  guildId: string;
  now?: () => number;
}

export class EmojiProposals implements PollHandler {
  private readonly now: () => number;

  constructor(private readonly deps: EmojiProposalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(pollId: number): Proposal | undefined {
    return this.deps.db
      .select()
      .from(emojiProposals)
      .where(eq(emojiProposals.pollId, pollId))
      .get();
  }

  pending(): { proposal: Proposal; poll: Poll }[] {
    return this.deps.db
      .select({ proposal: emojiProposals, poll: polls })
      .from(emojiProposals)
      .innerJoin(polls, eq(polls.id, emojiProposals.pollId))
      .where(eq(emojiProposals.status, "pending"))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  async propose(proposerId: string, name: string, image: Uint8Array): Promise<Poll> {
    const { config, db, access, guild } = this.deps;

    checkName(name);
    if (
      config.proposerRoleIds.length > 0 &&
      !(await access.hasAnyRole(proposerId, config.proposerRoleIds))
    ) {
      throw new UserError("You don't have a role that can propose emojis.");
    }

    const open = db
      .select({ id: emojiProposals.pollId })
      .from(emojiProposals)
      .where(
        and(eq(emojiProposals.proposerId, proposerId), eq(emojiProposals.status, "pending")),
      )
      .all();
    if (open.length >= config.maxOpenPerUser) {
      throw new UserError(
        `You already have ${open.length} open proposals; wait for one to finish first.`,
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
    if ((await guild.emojis()).some((e) => e.name.toLowerCase() === lower)) {
      throw new UserError(`An emoji called \`:${name}:\` already exists.`);
    }
    const duplicate = this.pending().find((p) => p.proposal.name.toLowerCase() === lower);
    if (duplicate) {
      throw new UserError(
        `\`:${name}:\` is already up for a vote in proposal #${duplicate.proposal.pollId}.`,
      );
    }

    const poll = await this.deps.polls.create({
      kind: EMOJI_POLL_KIND,
      guildId: this.deps.guildId,
      channelId: config.channelId,
      question: `Add the emoji \`:${name}:\`?`,
      description: `Proposed by <@${proposerId}>. Needs at least ${config.minYesVotes} yes votes and more yes than no.`,
      options: [
        { key: "yes", emoji: "✅", label: "Add it" },
        { key: "no", emoji: "❌", label: "Don't add it" },
      ],
      mode: "single",
      closesAt: new Date(this.now() + config.votingHours * 3_600_000),
      createdBy: proposerId,
      files: [{ name: `${name}.${type.ext}`, data: image }],
    });

    db.insert(emojiProposals)
      .values({
        pollId: poll.id,
        name,
        image: Buffer.from(image),
        contentType: type.mime,
        proposerId,
      })
      .run();
    return poll;
  }

  /** An admin approves or rejects before the vote ends. */
  async decide(
    pollId: number,
    adminId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    const proposal = this.requirePending(pollId);
    this.deps.db
      .update(emojiProposals)
      .set({ decision, decidedBy: adminId, reason })
      .where(eq(emojiProposals.pollId, proposal.pollId))
      .run();

    if (!(await this.deps.polls.close(pollId))) {
      // The vote ended on its own in the meantime; let that outcome stand.
      this.deps.db
        .update(emojiProposals)
        .set({ decision: null, decidedBy: null, reason: null })
        .where(and(eq(emojiProposals.pollId, pollId), eq(emojiProposals.status, "pending")))
        .run();
      throw new UserError(`Voting on proposal #${pollId} has already ended.`);
    }
  }

  /** The proposer or an admin withdraws a proposal. */
  async cancel(pollId: number, userId: string) {
    const proposal = this.requirePending(pollId);
    if (proposal.proposerId !== userId && !(await this.deps.access.isAdmin(userId))) {
      throw new UserError("Only the proposer or an admin can cancel a proposal.");
    }
    if (!(await this.deps.polls.cancel(pollId))) {
      throw new UserError(`Voting on proposal #${pollId} has already ended.`);
    }
    this.deps.db
      .update(emojiProposals)
      .set({ status: "cancelled", decidedBy: userId })
      .where(eq(emojiProposals.pollId, pollId))
      .run();
  }

  async onClose(poll: Poll, tally: Tally) {
    const proposal = this.get(poll.id);
    if (!proposal) {
      console.warn(`poll ${poll.id}: no emoji proposal stored for it`);
      return;
    }
    if (proposal.status !== "pending") return;

    const yes = tally.counts.yes ?? 0;
    const no = tally.counts.no ?? 0;
    const approved = proposal.decision
      ? proposal.decision === "approve"
      : yes >= this.deps.config.minYesVotes && yes > no;

    const why = proposal.decision
      ? `${proposal.decision === "approve" ? "approved" : "rejected"} by <@${proposal.decidedBy}>` +
        (proposal.reason ? `: ${proposal.reason}` : "")
      : `${yes} yes, ${no} no`;
    const name = `\`:${proposal.name}:\``;

    if (!approved) {
      this.setStatus(poll.id, { status: "rejected" });
      await this.announce(poll, `<@${proposal.proposerId}> ${name} was not added (${why}).`);
      return;
    }

    let emojiId: string;
    try {
      // A previous attempt may have created it before the bot went down.
      const existing = (await this.deps.guild.emojis()).find((e) => e.name === proposal.name);
      emojiId =
        existing?.id ??
        (await this.deps.guild.createEmoji(
          proposal.name,
          `data:${proposal.contentType};base64,${proposal.image.toString("base64")}`,
        ));
    } catch (err) {
      if (!(err instanceof EmojiRejected)) throw err;
      this.setStatus(poll.id, { status: "failed", error: err.message });
      await this.announce(
        poll,
        `<@${proposal.proposerId}> ${name} was approved (${why}) but Fluxer refused it: ${err.message}`,
      );
      return;
    }

    this.setStatus(poll.id, { status: "added", emojiId });
    await this.announce(poll, `<@${proposal.proposerId}> ${name} has been added (${why}).`);
  }

  private requirePending(pollId: number): Proposal {
    const proposal = this.get(pollId);
    if (!proposal || proposal.status !== "pending") {
      throw new UserError(`There is no open emoji proposal #${pollId}.`);
    }
    return proposal;
  }

  private setStatus(pollId: number, values: Partial<Proposal>) {
    this.deps.db
      .update(emojiProposals)
      .set(values)
      .where(eq(emojiProposals.pollId, pollId))
      .run();
  }

  private async announce(poll: Poll, content: string) {
    await this.deps.guild
      .send(poll.channelId, content, poll.messageId ?? undefined)
      .catch((err) => console.warn(`poll ${poll.id}: could not announce result:`, err));
  }
}

export function describeProposal(proposal: Proposal, poll: Poll): string {
  return `#${proposal.pollId} \`:${proposal.name}:\` by <@${proposal.proposerId}>, closes ${timestamp(poll.closesAt)}`;
}
