import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { refuse, type UserError } from "../commands/command.ts";
import type { BoardConfig } from "../config.ts";
import type { Transaction } from "../db/index.ts";
import { boardEntries } from "../db/schema.ts";
import { parseEmoji } from "../emoji.ts";
import { Settings } from "../settings/settings.ts";
import { BoardGuild, noBoard } from "./boards.ts";

// Creating, changing and deleting boards, for `!board` and the web interface.
// Boards are the `boards` section of the bot settings, so each change is a
// settings change: it's recorded with who made it, and starts the boards over.

/** The settings schema's rule, checked first for a friendlier reply. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What a member sets on a board. On an edit, what's left out stays as it is. */
export interface BoardChanges {
  readonly name?: string;
  readonly emoji?: string;
  readonly channelId?: string;
  readonly threshold?: number;
  readonly keep?: boolean;
  readonly ignoredChannelIds?: readonly string[];
}

export type NewBoard = BoardChanges & Pick<BoardConfig, "name" | "emoji" | "channelId">;

/** Checks the changes against the guild, and returns them cleaned up. */
const check = Effect.fnUntraced(function* (changes: BoardChanges) {
  const guild = yield* BoardGuild;
  const checked: { -readonly [K in keyof BoardChanges]: BoardChanges[K] } = {};

  if (changes.name !== undefined) {
    const name = changes.name.trim().toLowerCase();
    if (!NAME.test(name)) {
      return yield* refuse(
        `${changes.name} can't be a board name. Use up to 32 lowercase letters, digits and hyphens, ` +
          "starting with a letter or digit.",
      );
    }
    checked.name = name;
  }
  if (changes.emoji !== undefined) {
    const emoji = changes.emoji.trim();
    if (!parseEmoji(emoji)) {
      return yield* refuse(`${emoji} isn't an emoji. Use a Unicode emoji or a custom one like <:name:id>.`);
    }
    checked.emoji = emoji;
  }
  if (changes.channelId !== undefined) {
    const channel = yield* guild.channel(changes.channelId);
    if (!channel) return yield* refuse(`There's no channel \`${changes.channelId}\` in this server.`);
    if (!channel.text) return yield* refuse(`<#${channel.id}> doesn't take messages, so a board can't post there.`);
    checked.channelId = channel.id;
  }
  if (changes.threshold !== undefined) {
    if (!Number.isInteger(changes.threshold) || changes.threshold < 1) {
      return yield* refuse("The threshold has to be a whole number, 1 or more.");
    }
    checked.threshold = changes.threshold;
  }
  if (changes.keep !== undefined) checked.keep = changes.keep;
  if (changes.ignoredChannelIds !== undefined) {
    const ids = [...new Set(changes.ignoredChannelIds)];
    for (const id of ids) {
      if (!(yield* guild.channel(id))) return yield* refuse(`There's no channel \`${id}\` in this server.`);
    }
    checked.ignoredChannelIds = ids;
  }
  return checked;
});

/** Stores the boards `change` makes of the current ones. Returns false when nothing changed. */
const save = Effect.fnUntraced(function* (
  userId: string,
  change: (boards: readonly BoardConfig[]) => Effect.Effect<BoardConfig[], UserError>,
  alongside?: (tx: Transaction) => void,
) {
  const settings = yield* Settings;
  const sections = yield* settings
    .update(
      (current) => change(current.boards ?? []).pipe(Effect.map((boards) => ({ ...current, boards }))),
      userId,
      alongside,
    )
    .pipe(
      // check() covers what members can get wrong, so this is down to the settings as a whole.
      Effect.catchTag("InvalidSettings", (err) =>
        refuse(`The settings would be invalid, so nothing changed:\n${err.problems.join("\n")}`),
      ),
    );
  return sections.length > 0;
});

/** The boards, in the order `!board top` picks the first of. */
export const listBoards = Settings.current.pipe(Effect.map((s): readonly BoardConfig[] => s.boards ?? []));

const find = (name: string) =>
  listBoards.pipe(
    Effect.flatMap((boards) => {
      const board = boards.find((b) => b.name === name);
      return board ? Effect.succeed(board) : noBoard(name, boards);
    }),
  );

/** Adds a board, with the defaults for what `input` leaves out. */
export const createBoard = Effect.fnUntraced(function* (input: NewBoard, userId: string) {
  const board = yield* check(input);
  const name = board.name!;
  yield* save(userId, (boards) =>
    boards.some((b) => b.name === name)
      ? refuse(`There's already a board called ${name}.`)
      : Effect.succeed([...boards, board as BoardConfig]),
  );
  return yield* find(name);
});

/**
 * Changes the board called `name`. Renaming it keeps its posts and
 * leaderboard. Returns the board, and whether anything changed.
 */
export const editBoard = Effect.fnUntraced(function* (name: string, input: BoardChanges, userId: string) {
  const changes = yield* check(input);
  const from = name.trim().toLowerCase();
  const to = changes.name ?? from;
  const changed = yield* save(
    userId,
    (boards) => {
      const i = boards.findIndex((b) => b.name === from);
      if (i < 0) return noBoard(name, boards);
      if (to !== from && boards.some((b) => b.name === to)) return refuse(`There's already a board called ${to}.`);
      return Effect.succeed(boards.with(i, { ...boards[i]!, ...changes }));
    },
    to === from
      ? undefined
      : (tx) => {
          // Left behind by a board of that name the settings import took away.
          tx.delete(boardEntries).where(eq(boardEntries.board, to)).run();
          tx.update(boardEntries).set({ board: to }).where(eq(boardEntries.board, from)).run();
        },
  );
  return { board: yield* find(to), changed };
});

/**
 * Deletes the board called `name` and forgets its posts, which stay in its
 * channel. Returns the board as it was.
 */
export const deleteBoard = Effect.fnUntraced(function* (name: string, userId: string) {
  const target = name.trim().toLowerCase();
  const board = yield* find(target);
  yield* save(
    userId,
    (boards) =>
      boards.some((b) => b.name === target)
        ? Effect.succeed(boards.filter((b) => b.name !== target))
        : noBoard(name, boards),
    (tx) => tx.delete(boardEntries).where(eq(boardEntries.board, target)).run(),
  );
  return board;
});
