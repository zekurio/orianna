import { and, asc, eq } from "drizzle-orm";
import { UserError } from "../commands/command.ts";
import type { PollsConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { type PollOption, polls } from "../db/schema.ts";
import { emojiKey, type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import type { GuildAccess } from "../permissions/rules.ts";
import { HOUR, looksLikeDuration, MINUTE, parseDuration, plural, WEEK } from "./duration.ts";
import { type Poll, type PollHandler, type PollService, type Tally, timestamp } from "./service.ts";
import type { PollTransport } from "./transport.ts";

/** Poll kind of the polls members start with `!poll`. */
export const COMMUNITY_POLL = "poll";

/** Ends a poll early when its creator, or someone with `polls.end-any`, reacts with it. */
const STOP = "🛑";

const QUESTION_MAX = 250;
const ANSWER_MAX = 80;
const MAX_DURATION = 4 * WEEK;

/** Votes for answers that don't bring their own emoji, hence at most ten answers. */
const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const MAX_ANSWERS = NUMBERS.length;

/** The answers of a poll that's only a question. */
const YES_NO: PollOption[] = [
  { key: "yes", emoji: "✅", label: "Yes" },
  { key: "no", emoji: "❌", label: "No" },
];

/**
 * Opens or closes a quoted part. Phones turn `"` into curly or language-specific
 * quotes, so any double quote counts. Single quotes don't, for answers like
 * `"Let's go"`.
 */
const QUOTE = /["“”„‟«»]/;

/** Shown when the input can't be read. */
const EXAMPLE = '`"What do we eat?" "🍍 Pineapple" "🍕 Pizza" 3h`';

/**
 * A custom emoji or a Unicode one at the very start of an answer. The
 * pictographic fallback catches emoji like ❤ typed without the variation
 * selector that `RGI_Emoji` expects.
 */
const LEADING_EMOJI = /^(?:<a?:\w+:\d+>|\p{RGI_Emoji}|\p{Extended_Pictographic})/v;
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/** Colour of polls that are over. */
const ENDED = 0x80848e;
const BAR_WIDTH = 10;
/** Close to the gold of `ACCENT`. */
const BAR_FILLED = "🟨";
const BAR_EMPTY = "⬛";

/** What community polls need from the chat platform besides the poll service. */
export interface CommunityPollChat
  extends Pick<PollTransport, "react" | "removeReaction" | "reactionUsers"> {
  /** Replies to a poll message. Only the `notify` users are pinged. */
  reply(
    channelId: string,
    messageId: string,
    content: string,
    notify: readonly string[],
  ): Promise<void>;
  /** Removes every reaction with `emoji`. */
  clearReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** IDs of the guild's custom emoji. */
  emojiIds(): Promise<string[]>;
  /** A link that jumps to the message. */
  messageLink(channelId: string, messageId: string): string;
}

export interface CommunityPollsDeps {
  db: DB;
  polls: PollService;
  chat: CommunityPollChat;
  access: GuildAccess;
  config: PollsConfig;
  guildId: string;
  now?: () => number;
}

/** A poll as typed after `!poll`. */
export interface PollInput {
  question: string;
  options: PollOption[];
  /** In milliseconds; undefined when none was given. */
  duration?: number;
  multi: boolean;
}

/** Polls members start themselves, like Discord's. */
export class CommunityPolls implements PollHandler {
  private readonly now: () => number;

  constructor(private readonly deps: CommunityPollsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Open community polls, the ones closing soonest first. */
  open(): Poll[] {
    return this.deps.db
      .select()
      .from(polls)
      .where(and(eq(polls.kind, COMMUNITY_POLL), eq(polls.status, "open")))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  /** Posts a poll in `channelId`. `text` is read by {@link parsePollInput}. */
  async start(userId: string, channelId: string, text: string): Promise<Poll> {
    const { config, chat } = this.deps;
    const input = parsePollInput(text);
    await this.checkCustomEmoji(input.options);

    const mine = this.open().filter((p) => p.createdBy === userId);
    if (mine.length >= config.maxOpenPerUser) {
      throw new UserError(
        `You already have ${mine.length} open polls; end one with ${STOP} or wait for one to finish.`,
      );
    }

    const poll = await this.deps.polls.create({
      kind: COMMUNITY_POLL,
      guildId: this.deps.guildId,
      channelId,
      question: input.question,
      options: input.options,
      mode: input.multi ? "multi" : "single",
      closesAt: new Date(this.now() + (input.duration ?? config.defaultHours * HOUR)),
      createdBy: userId,
    });
    // Best effort, like the answers: anyone may add it themselves.
    await chat.react(channelId, poll.messageId!, STOP).catch(warn(poll, `could not add ${STOP}`));
    return poll;
  }

  /**
   * 🛑 from the creator, or someone with `polls.end-any`, ends the poll.
   * Anyone else's is taken back.
   */
  async onOtherReaction(poll: Poll, userId: string, emoji: ReactionEmoji) {
    if (reactionKey(emoji) !== emojiKey(STOP)) return;
    if (await this.mayEnd(poll, userId)) {
      await this.deps.polls.close(poll.id);
    } else {
      await this.takeBackStop(poll, userId);
    }
  }

  /** A deleted poll message calls the poll off. */
  async messageDeleted(messageId: string) {
    const poll = this.deps.polls.byMessage(messageId);
    if (poll?.kind !== COMMUNITY_POLL) return;
    await this.deps.polls.cancel(poll.id, { messageDeleted: true });
  }

  /** Acts on 🛑 reactions added while the bot was offline. */
  async reconcile() {
    for (const poll of this.open()) {
      if (!poll.messageId) continue;
      try {
        const users = await this.deps.chat.reactionUsers(poll.channelId, poll.messageId, STOP);
        for (const userId of users) {
          if (await this.mayEnd(poll, userId)) {
            await this.deps.polls.close(poll.id);
            break;
          }
          await this.takeBackStop(poll, userId);
        }
      } catch (err) {
        warn(poll, `could not check ${STOP} reactions`)(err);
      }
    }
  }

  render(poll: Poll, tally: Tally): MessageBody {
    return renderCommunityPoll(poll, tally);
  }

  async onClose(poll: Poll, tally: Tally) {
    if (!poll.messageId) return;
    const { chat } = this.deps;
    await chat
      .clearReaction(poll.channelId, poll.messageId, STOP)
      .catch(warn(poll, `could not clear ${STOP}`));
    await chat
      .reply(poll.channelId, poll.messageId, announcement(poll, tally), [poll.createdBy])
      .catch(warn(poll, "could not announce the result"));
  }

  describe(poll: Poll): string {
    const question = truncate(poll.question, 60).replace(/[[\]]/g, "");
    const title = poll.messageId
      ? `[${question}](${this.deps.chat.messageLink(poll.channelId, poll.messageId)})`
      : question;
    return `${title} by <@${poll.createdBy}> in <#${poll.channelId}>, ends ${timestamp(poll.closesAt)}`;
  }

  /** The bot can only react with custom emoji from its own guild. */
  private async checkCustomEmoji(options: readonly PollOption[]) {
    const custom = options.filter((o) => /^\d+$/.test(emojiKey(o.emoji)));
    if (custom.length === 0) return;
    const known = new Set(await this.deps.chat.emojiIds());
    const foreign = custom.find((o) => !known.has(emojiKey(o.emoji)));
    if (foreign) {
      throw new UserError(
        `${emojiText(foreign)} isn't an emoji of this server, so I can't react with it.`,
      );
    }
  }

  private async mayEnd(poll: Poll, userId: string): Promise<boolean> {
    return poll.createdBy === userId || (await this.deps.access.can(userId, "polls.end-any"));
  }

  private async takeBackStop(poll: Poll, userId: string) {
    if (!poll.messageId) return;
    await this.deps.chat
      .removeReaction(poll.channelId, poll.messageId, STOP, userId)
      .catch(warn(poll, `could not remove ${STOP}`));
  }
}

/**
 * Reads what follows `!poll`. Quoted parts are the question and then the
 * answers, and each word outside quotes is a setting: a duration like `3h`
 * or `multi`. Without any quotes, the whole text is a yes/no question.
 */
export function parsePollInput(text: string): PollInput {
  const parts = text.split(QUOTE);
  if (parts.length === 1) {
    return { question: checkQuestion(clean(text)), options: YES_NO, multi: false };
  }
  if (parts.length % 2 === 0) {
    throw new UserError(`One of the quotes isn't closed. Quote the question and each answer: ${EXAMPLE}`);
  }

  // Odd parts were inside quotes.
  const quoted = parts.filter((_, i) => i % 2 === 1).map(clean);
  if (quoted.includes("")) throw new UserError("There's an empty pair of quotes in the poll.");
  const words = parts
    .filter((_, i) => i % 2 === 0)
    .flatMap((part) => part.split(/[\s,]+/))
    .filter(Boolean);

  let duration: number | undefined;
  let multi = false;
  for (const word of words) {
    if (word.toLowerCase() === "multi") {
      multi = true;
    } else if (looksLikeDuration(word)) {
      if (duration !== undefined) throw new UserError("Give the poll only one duration.");
      duration = checkDuration(word);
    } else {
      throw new UserError(
        `I don't know what \`${word}\` means there. Put the question and each answer in quotes, ` +
          `then add a duration or \`multi\` if you like: ${EXAMPLE}`,
      );
    }
  }

  const [question, ...answers] = quoted;
  return { question: checkQuestion(question!), options: parseAnswers(answers), duration, multi };
}

function checkQuestion(question: string): string {
  if (!question) throw new UserError("A poll needs a question.");
  if (question.length > QUESTION_MAX) {
    throw new UserError(`Questions can be at most ${QUESTION_MAX} characters long.`);
  }
  return question;
}

function checkDuration(word: string): number {
  const ms = parseDuration(word);
  if (ms === undefined) {
    throw new UserError(
      `\`${word}\` isn't a duration I know. Use m, h, d or w, like \`30m\`, \`3h\`, \`3d\` or \`1w\`.`,
    );
  }
  if (ms < MINUTE) throw new UserError("A poll has to run for at least a minute.");
  if (ms > MAX_DURATION) throw new UserError("A poll can run for 4 weeks at most.");
  return ms;
}

/**
 * Turns the answers into poll options. An answer may start with the emoji to
 * vote with; the others get numbers. Without answers it's a yes/no question.
 */
function parseAnswers(answers: readonly string[]): PollOption[] {
  if (answers.length === 0) return YES_NO;
  if (answers.length === 1) {
    throw new UserError("A poll needs at least two answers; leave them out for a yes/no poll.");
  }
  if (answers.length > MAX_ANSWERS) {
    throw new UserError(`A poll can have at most ${MAX_ANSWERS} answers.`);
  }

  const parsed = answers.map(parseAnswer);
  const labels = new Set<string>();
  const taken = new Set<string>();
  for (const { emoji, label } of parsed) {
    if (label.length > ANSWER_MAX) {
      throw new UserError(`Answers can be at most ${ANSWER_MAX} characters long.`);
    }
    const lower = label.toLowerCase();
    if (lower && labels.has(lower)) throw new UserError(`\`${label}\` is an answer twice.`);
    labels.add(lower);
    if (!emoji) continue;
    if (emoji.key === emojiKey(STOP)) {
      throw new UserError(`${STOP} is for ending the poll; pick another emoji for that answer.`);
    }
    if (taken.has(emoji.key)) {
      throw new UserError(`Each answer needs its own emoji, but ${emoji.text} is used twice.`);
    }
    taken.add(emoji.key);
  }

  return parsed.map(({ emoji, label }, i): PollOption => {
    let api = emoji?.api;
    if (!api) {
      // Its own number, unless another answer already uses that one.
      api = [NUMBERS[i]!, ...NUMBERS].find((n) => !taken.has(emojiKey(n)))!;
      taken.add(emojiKey(api));
    }
    return { key: String(i + 1), emoji: api, label };
  });
}

function parseAnswer(answer: string): { emoji?: ParsedEmoji; label: string } {
  const match = LEADING_EMOJI.exec(answer)?.[0];
  if (!match) return { label: answer };
  // ❤ typed bare becomes ❤️, the form reactions use.
  const full = !RGI_EMOJI.test(match) && RGI_EMOJI.test(`${match}\uFE0F`) ? `${match}\uFE0F` : match;
  const emoji = parseEmoji(full);
  if (!emoji) return { label: answer };
  return { emoji, label: answer.slice(match.length).trim() };
}

/** Collapses runs of whitespace, new lines included. */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function renderCommunityPoll(poll: Poll, tally: Tally): MessageBody {
  const open = poll.status === "open";
  const cancelled = poll.status === "cancelled";
  const top = Math.max(0, ...Object.values(tally.counts));

  const answers = poll.options.map((option) => {
    const name = answerText(option);
    if (cancelled) return name;
    const votes = tally.counts[option.key] ?? 0;
    const share = tally.voters === 0 ? 0 : votes / tally.voters;
    const won = !open && top > 0 && votes === top ? " 🏆" : "";
    return `${name}${won}\n${bar(share)} **${percent(share)}** · ${plural(votes, "vote")}`;
  });
  const about = open
    ? `Asked by <@${poll.createdBy}> · ends ${timestamp(poll.closesAt)}`
    : `Asked by <@${poll.createdBy}>`;

  const voters = plural(tally.voters, "voter");
  const how =
    poll.mode === "single" ? "React to vote, one answer each" : "React to vote, as many answers as you like";
  const footer = cancelled
    ? "Cancelled"
    : open
      ? `${how} · ${voters} · The asker can end it early with ${STOP}`
      : `Final results · ${voters}`;

  return {
    embeds: [
      {
        title: `📊 ${poll.question}`,
        description: `${answers.join(cancelled ? "\n" : "\n\n")}\n\n${about}`,
        color: open ? ACCENT : ENDED,
        footer,
      },
    ],
  };
}

/** The reply to a poll that just ended. */
function announcement(poll: Poll, tally: Tally): string {
  const intro = `<@${poll.createdBy}> your poll **${poll.question}** has ended`;
  const top = Math.max(0, ...Object.values(tally.counts));
  if (top === 0) return `${intro}. Nobody voted.`;

  const leaders = poll.options.filter((o) => (tally.counts[o.key] ?? 0) === top);
  const names = leaders.map(answerText);
  if (leaders.length > 1) {
    return `${intro} in a tie between ${list(names)}, with ${plural(top, "vote")} each.`;
  }
  return `${intro}: ${names[0]} won with ${plural(top, "vote")} (${percent(top / tally.voters)}).`;
}

/** How an option's emoji is written in a message. */
function emojiText(option: PollOption): string {
  return parseEmoji(option.emoji)?.text ?? option.emoji;
}

/** The answer's emoji and its label in bold. */
function answerText(option: PollOption): string {
  return option.label ? `${emojiText(option)} **${option.label}**` : emojiText(option);
}

/**
 * Emoji squares rather than block characters, which code fonts draw with
 * seams and dithering. Any vote shows at least one square, and only a share
 * of everyone fills the bar.
 */
function bar(share: number): string {
  let filled = Math.round(share * BAR_WIDTH);
  if (share > 0) filled = Math.max(filled, 1);
  if (share < 1) filled = Math.min(filled, BAR_WIDTH - 1);
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** `a`, `a and b`, `a, b and c` */
function list(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function warn(poll: Poll, what: string) {
  return (err: unknown) => console.warn(`poll ${poll.id}: ${what}:`, err);
}
