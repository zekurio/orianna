import { Effect } from "effect";
import { type CommandGroup, defineCommand, refuse } from "../commands/command.ts";
import type { BoardConfig } from "../config.ts";
import { ACCENT } from "../messages/body.ts";
import { BoardGuild, type Boards } from "./boards.ts";
import { type BoardChanges, createBoard, deleteBoard, editBoard, listBoards } from "./manage.ts";

/** What `create` and `edit` take besides the name, as `--threshold 5`. */
const SETTINGS_OPTIONS = [
  {
    name: "threshold",
    description: "How many members besides the author have to react",
    type: "integer",
    required: false,
    named: true,
  },
  {
    name: "keep",
    description: "yes to leave posts up when reactions drop again",
    type: "string",
    required: false,
    named: true,
  },
  {
    name: "ignore",
    description: "Channels whose messages never go up, or none",
    type: "string",
    required: false,
    named: true,
  },
] as const;

/** `!board top`, `optout`, `optin` and `remove`, and `list`, `create`, `edit` and `delete` to set boards up. */
export const boardCommands = Effect.fnUntraced(function* (boards: Boards) {
  // Commands only get the services every command gets, so this one comes along.
  const guild = yield* BoardGuild;
  const withGuild = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, BoardGuild, guild);

  const top = defineCommand({
    name: "top",
    description: "Show who has the most messages on a board.",
    options: [
      {
        name: "board",
        description: `A board, ${boards.boards[0]?.name ?? "the first one"} by default`,
        type: "string",
        required: false,
      },
    ],
    run: (ctx) =>
      Effect.gen(function* () {
        const { board, rows } = yield* boards.top(ctx.options.board);
        const title = `Top of ${board.name}`;
        if (rows.length === 0) {
          return yield* Effect.asVoid(ctx.reply(`Nothing has made it onto ${board.name} yet.`));
        }
        const lines = rows.map(
          (r, i) =>
            `**${i + 1}.** <@${r.authorId}>: ${r.posts} ${r.posts === 1 ? "message" : "messages"}, ` +
            `${r.reactions} ${board.emoji.text}`,
        );
        yield* ctx.reply({ embeds: [{ title, description: lines.join("\n"), color: ACCENT }] });
      }),
  });

  const optOut = defineCommand({
    name: "optout",
    description: "Keep your messages off the boards and take down the ones already there.",
    run: (ctx) =>
      Effect.gen(function* () {
        const removed = yield* boards.optOut(ctx.userId);
        const taken = removed === 0 ? "" : ` Took down ${removed} ${removed === 1 ? "post" : "posts"}.`;
        yield* ctx.reply(`Your messages stay off the boards now.${taken} \`optin\` undoes it.`);
      }),
  });

  const optIn = defineCommand({
    name: "optin",
    description: "Let your messages go on the boards again.",
    run: (ctx) =>
      Effect.gen(function* () {
        const changed = yield* boards.optIn(ctx.userId);
        yield* ctx.reply(changed ? "Your messages can go on the boards again." : "You hadn't opted out.");
      }),
  });

  const remove = defineCommand({
    name: "remove",
    description: "Take a message off the boards for good.",
    options: [
      {
        name: "message",
        description: "A link to the message or its post, or either ID",
        type: "string",
      },
    ],
    permission: "boards.remove",
    run: (ctx) =>
      Effect.gen(function* () {
        const names = yield* boards.remove(ctx.options.message);
        yield* ctx.reply(`Took it off ${names.join(" and ")}. It won't go up again.`);
      }),
  });

  const list = defineCommand({
    name: "list",
    description: "Show the boards and what it takes to get on them.",
    run: (ctx) =>
      Effect.gen(function* () {
        const all = yield* listBoards;
        if (all.length === 0) return yield* Effect.asVoid(ctx.reply("There are no boards yet."));
        yield* ctx.reply({ embeds: [{ title: "Boards", description: all.map(describe).join("\n"), color: ACCENT }] });
      }),
  });

  const create = defineCommand({
    name: "create",
    description: "Add a board.",
    options: [
      { name: "name", description: "What members call it, like gems", type: "string" },
      { name: "emoji", description: "The emoji members react with", type: "string" },
      { name: "channel", description: "Where the bot posts", type: "string" },
      ...SETTINGS_OPTIONS,
    ] as const,
    permission: "boards.manage",
    run: (ctx) =>
      Effect.gen(function* () {
        const { name, emoji, channel } = ctx.options;
        const changes = yield* settingsOf(ctx.options);
        const channelId = yield* channelOf(channel);
        const board = yield* createBoard({ ...changes, name, emoji, channelId }, ctx.userId);
        yield* ctx.reply(`Created ${describe(board)}`);
      }).pipe(withGuild),
  });

  const edit = defineCommand({
    name: "edit",
    description: "Change a board. Anything you leave out stays as it is.",
    options: [
      { name: "board", description: "The board to change", type: "string" },
      { name: "name", description: "A new name; its posts come along", type: "string", required: false, named: true },
      { name: "emoji", description: "The emoji members react with", type: "string", required: false, named: true },
      { name: "channel", description: "Where the bot posts from now on", type: "string", required: false, named: true },
      ...SETTINGS_OPTIONS,
    ] as const,
    permission: "boards.manage",
    run: (ctx) =>
      Effect.gen(function* () {
        const { name, emoji, channel } = ctx.options;
        const changes: BoardChanges = {
          ...(yield* settingsOf(ctx.options)),
          ...(name !== undefined && { name }),
          ...(emoji !== undefined && { emoji }),
          ...(channel !== undefined && { channelId: yield* channelOf(channel) }),
        };
        if (Object.keys(changes).length === 0) {
          return yield* refuse("Say what to change, like `--threshold 8` or `--channel #gems`.");
        }
        const { board, changed } = yield* editBoard(ctx.options.board, changes, ctx.userId);
        yield* ctx.reply(changed ? `Changed ${describe(board)}` : `Nothing changed: ${describe(board)}`);
      }).pipe(withGuild),
  });

  const deleteBoardCommand = defineCommand({
    name: "delete",
    description: "Delete a board. Its posts stay in its channel.",
    options: [{ name: "board", description: "The board to delete", type: "string" }] as const,
    permission: "boards.manage",
    run: (ctx) =>
      Effect.gen(function* () {
        const board = yield* deleteBoard(ctx.options.board, ctx.userId);
        yield* ctx.reply(`Deleted **${board.name}**. Its posts stay in <#${board.channelId}>.`);
      }).pipe(withGuild),
  });

  const group: CommandGroup = {
    name: "board",
    description: "Starboards, where messages with enough reactions go up.",
    subcommands: [list, top, optOut, optIn, remove, create, edit, deleteBoardCommand],
  };
  return group;
});

/** e.g. "**gems** 💎 in #gems: 5 reactions, posts stay up, ignores #staff" */
export function describe(board: BoardConfig): string {
  const parts = [`${board.threshold} ${board.threshold === 1 ? "reaction" : "reactions"}`];
  if (board.keep) parts.push("posts stay up");
  if (board.ignoredChannelIds.length > 0) {
    parts.push(`ignores ${board.ignoredChannelIds.map((id) => `<#${id}>`).join(", ")}`);
  }
  return `**${board.name}** ${board.emoji} in <#${board.channelId}>: ${parts.join(", ")}`;
}

/** A channel mention like `<#123>`, or a bare ID. */
function channelOf(input: string) {
  const id = /^<#(\d+)>$|^(\d+)$/.exec(input.trim());
  if (id) return Effect.succeed(id[1] ?? id[2]!);
  return refuse(`${input} isn't a channel. Mention it, like #general, or give its ID.`);
}

/** `--threshold`, `--keep` and `--ignore`, as far as they were given. */
const settingsOf = Effect.fnUntraced(function* (options: {
  threshold?: number | undefined;
  keep?: string | undefined;
  ignore?: string | undefined;
}) {
  const changes: { -readonly [K in keyof BoardChanges]: BoardChanges[K] } = {};
  if (options.threshold !== undefined) changes.threshold = options.threshold;
  if (options.keep !== undefined) {
    const keep = YES_NO[options.keep.toLowerCase()];
    if (keep === undefined) return yield* refuse(`--keep takes yes or no, not ${options.keep}.`);
    changes.keep = keep;
  }
  if (options.ignore !== undefined) {
    const words = options.ignore.split(/[\s,]+/).filter(Boolean);
    changes.ignoredChannelIds =
      words.length === 1 && words[0]!.toLowerCase() === "none" ? [] : yield* Effect.forEach(words, channelOf);
  }
  return changes;
});

const YES_NO: Record<string, boolean> = { yes: true, on: true, true: true, no: false, off: false, false: false };
