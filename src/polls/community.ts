import { and, asc, eq } from "drizzle-orm";
import { Clock, Context, Effect } from "effect";
import { refuse, type UserError } from "../commands/command.ts";
import type { PollsConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { type PollOption, polls } from "../db/schema.ts";
import { emojiKey, type ParsedEmoji, parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import type { FluxerError } from "../fluxer.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { HOUR, looksLikeDuration, MINUTE, parseDuration, plural, WEEK } from "./duration.ts";
import { type Poll, type PollHandler, PollService, type Tally, timestamp } from "./service.ts";
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
export class CommunityPollChat extends Context.Service<
  CommunityPollChat,
  Pick<PollTransport["Service"], "react" | "removeReaction" | "reactionUsers"> & {
    /** Replies to a poll message. Only the `notify` users are pinged. */
    readonly reply: (
      channelId: string,
      messageId: string,
      content: string,
      notify: readonly string[],
    ) => Effect.Effect<void, FluxerError>;
    /** Removes every reaction with `emoji`. */
    readonly clearReaction: (
      channelId: string,
      messageId: string,
      emoji: string,
    ) => Effect.Effect<void, FluxerError>;
    /** IDs of the guild's custom emoji. */
    readonly emojiIds: Effect.Effect<string[], FluxerError>;
    /** A link that jumps to the message. */
    readonly messageLink: (channelId: string, messageId: string) => string;
  }
>()("orianna/CommunityPollChat") {}

/** A poll as typed after `!poll`. */
export interface PollInput {
  question: string;
  options: PollOption[];
  /** In milliseconds; undefined when none was given. */
  duration?: number;
  multi: boolean;
}

export type CommunityPolls = Effect.Success<ReturnType<typeof makeCommunityPolls>>;

/** Polls members start themselves, like Discord's. Handles their poll kind until the scope closes. */
export const makeCommunityPolls = Effect.fnUntraced(function* (config: PollsConfig, guildId: string) {
  const db = yield* Database;
  const service = yield* PollService;
  const chat = yield* CommunityPollChat;
  const access = yield* GuildAccess;

  /** Open community polls, the ones closing soonest first. */
  function open(): Poll[] {
    return db
      .select()
      .from(polls)
      .where(and(eq(polls.kind, COMMUNITY_POLL), eq(polls.status, "open")))
      .orderBy(asc(polls.closesAt))
      .all();
  }

  /** Posts a poll in `channelId`. `text` is read by {@link parsePollInput}. */
  const start = Effect.fn("CommunityPolls.start")(function* (
    userId: string,
    channelId: string,
    text: string,
  ) {
    const input = yield* parsePollInput(text);
    yield* checkCustomEmoji(input.options);

    const mine = open().filter((p) => p.createdBy === userId);
    if (mine.length >= config.maxOpenPerUser) {
      return yield* refuse(
        `You already have ${mine.length} open polls; end one with ${STOP} or wait for one to finish.`,
      );
    }

    const now = yield* Clock.currentTimeMillis;
    const poll = yield* service.create({
      kind: COMMUNITY_POLL,
      guildId,
      channelId,
      question: input.question,
      options: input.options,
      mode: input.multi ? "multi" : "single",
      closesAt: new Date(now + (input.duration ?? config.defaultHours * HOUR)),
      createdBy: userId,
    });
    // Best effort, like the answers: anyone may add it themselves.
    yield* chat.react(channelId, poll.messageId!, STOP).pipe(Effect.catch(warn(poll, `could not add ${STOP}`)));
    return poll;
  });

  /** A deleted poll message calls the poll off. */
  const messageDeleted = Effect.fnUntraced(function* (messageId: string) {
    const poll = service.byMessage(messageId);
    if (poll?.kind !== COMMUNITY_POLL) return;
    yield* service.cancel(poll.id, { messageDeleted: true });
  });

  /** Acts on 🛑 reactions added while the bot was offline. */
  const reconcile = Effect.fn("CommunityPolls.reconcile")(function* () {
    for (const poll of open()) {
      const { messageId } = poll;
      if (!messageId) continue;
      yield* Effect.gen(function* () {
        const users = yield* chat.reactionUsers(poll.channelId, messageId, STOP);
        for (const userId of users) {
          if (yield* mayEnd(poll, userId)) {
            yield* service.close(poll.id);
            break;
          }
          yield* takeBackStop(poll, userId);
        }
      }).pipe(
        Effect.catch((err) => Effect.logWarning(`poll ${poll.id}: could not check ${STOP} reactions: ${err.message}`)),
      );
    }
  });

  function describe(poll: Poll): string {
    const question = truncate(poll.question, 60).replace(/[[\]]/g, "");
    const title = poll.messageId
      ? `[${question}](${chat.messageLink(poll.channelId, poll.messageId)})`
      : question;
    return `${title} by <@${poll.createdBy}> in <#${poll.channelId}>, ends ${timestamp(poll.closesAt)}`;
  }

  /** The bot can only react with custom emoji from its own guild. */
  const checkCustomEmoji = Effect.fnUntraced(function* (options: readonly PollOption[]) {
    const custom = options.filter((o) => /^\d+$/.test(emojiKey(o.emoji)));
    if (custom.length === 0) return;
    const known = new Set(yield* chat.emojiIds);
    const foreign = custom.find((o) => !known.has(emojiKey(o.emoji)));
    if (foreign) {
      return yield* refuse(`${emojiText(foreign)} isn't an emoji of this server, so I can't react with it.`);
    }
  });

  function mayEnd(poll: Poll, userId: string): Effect.Effect<boolean, UserError | FluxerError> {
    return poll.createdBy === userId ? Effect.succeed(true) : access.can(userId, "polls.end-any");
  }

  function takeBackStop(poll: Poll, userId: string): Effect.Effect<void> {
    if (!poll.messageId) return Effect.void;
    return chat
      .removeReaction(poll.channelId, poll.messageId, STOP, userId)
      .pipe(Effect.catch(warn(poll, `could not remove ${STOP}`)));
  }

  const handler: PollHandler = {
    render: renderCommunityPoll,

    /**
     * 🛑 from the creator, or someone with `polls.end-any`, ends the poll.
     * Anyone else's is taken back.
     */
    onOtherReaction: (poll, userId, emoji) =>
      Effect.gen(function* () {
        if (reactionKey(emoji) !== emojiKey(STOP)) return;
        if (yield* mayEnd(poll, userId)) {
          yield* service.close(poll.id);
        } else {
          yield* takeBackStop(poll, userId);
        }
      }),

    onClose: (poll, tally) =>
      Effect.gen(function* () {
        if (!poll.messageId) return;
        yield* chat
          .clearReaction(poll.channelId, poll.messageId, STOP)
          .pipe(Effect.catch(warn(poll, `could not clear ${STOP}`)));
        yield* chat
          .reply(poll.channelId, poll.messageId, announcement(poll, tally), [poll.createdBy])
          .pipe(Effect.catch(warn(poll, "could not announce the result")));
      }),
  };
  yield* service.register(COMMUNITY_POLL, handler);

  return { open, start, messageDeleted, reconcile, describe };
});

/**
 * Reads what follows `!poll`. Quoted parts are the question and then the
 * answers, and each word outside quotes is a setting: a duration like `3h`
 * or `multi`. Without any quotes, the whole text is a yes/no question.
 */
export const parsePollInput = Effect.fnUntraced(function* (text: string) {
  const parts = text.split(QUOTE);
  if (parts.length === 1) {
    const question = yield* checkQuestion(clean(text));
    const input: PollInput = { question, options: YES_NO, multi: false };
    return input;
  }
  if (parts.length % 2 === 0) {
    return yield* refuse(`One of the quotes isn't closed. Quote the question and each answer: ${EXAMPLE}`);
  }

  // Odd parts were inside quotes.
  const quoted = parts.filter((_, i) => i % 2 === 1).map(clean);
  if (quoted.includes("")) return yield* refuse("There's an empty pair of quotes in the poll.");
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
      if (duration !== undefined) return yield* refuse("Give the poll only one duration.");
      duration = yield* checkDuration(word);
    } else {
      return yield* refuse(
        `I don't know what \`${word}\` means there. Put the question and each answer in quotes, ` +
          `then add a duration or \`multi\` if you like: ${EXAMPLE}`,
      );
    }
  }

  const [question, ...answers] = quoted;
  const input: PollInput = {
    question: yield* checkQuestion(question!),
    options: yield* parseAnswers(answers),
    duration,
    multi,
  };
  return input;
});

function checkQuestion(question: string): Effect.Effect<string, UserError> {
  if (!question) return refuse("A poll needs a question.");
  if (question.length > QUESTION_MAX) {
    return refuse(`Questions can be at most ${QUESTION_MAX} characters long.`);
  }
  return Effect.succeed(question);
}

function checkDuration(word: string): Effect.Effect<number, UserError> {
  const ms = parseDuration(word);
  if (ms === undefined) {
    return refuse(
      `\`${word}\` isn't a duration I know. Use m, h, d or w, like \`30m\`, \`3h\`, \`3d\` or \`1w\`.`,
    );
  }
  if (ms < MINUTE) return refuse("A poll has to run for at least a minute.");
  if (ms > MAX_DURATION) return refuse("A poll can run for 4 weeks at most.");
  return Effect.succeed(ms);
}

/**
 * Turns the answers into poll options. An answer may start with the emoji to
 * vote with; the others get numbers. Without answers it's a yes/no question.
 */
const parseAnswers = Effect.fnUntraced(function* (answers: readonly string[]) {
  if (answers.length === 0) return YES_NO;
  if (answers.length === 1) {
    return yield* refuse("A poll needs at least two answers; leave them out for a yes/no poll.");
  }
  if (answers.length > MAX_ANSWERS) {
    return yield* refuse(`A poll can have at most ${MAX_ANSWERS} answers.`);
  }

  const parsed = answers.map(parseAnswer);
  const labels = new Set<string>();
  const taken = new Set<string>();
  for (const { emoji, label } of parsed) {
    if (label.length > ANSWER_MAX) {
      return yield* refuse(`Answers can be at most ${ANSWER_MAX} characters long.`);
    }
    const lower = label.toLowerCase();
    if (lower && labels.has(lower)) return yield* refuse(`\`${label}\` is an answer twice.`);
    labels.add(lower);
    if (!emoji) continue;
    if (emoji.key === emojiKey(STOP)) {
      return yield* refuse(`${STOP} is for ending the poll; pick another emoji for that answer.`);
    }
    if (taken.has(emoji.key)) {
      return yield* refuse(`Each answer needs its own emoji, but ${emoji.text} is used twice.`);
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
});

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
  return (err: FluxerError) => Effect.logWarning(`poll ${poll.id}: ${what}: ${err.reason}`);
}
