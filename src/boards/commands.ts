import { Effect } from "effect";
import { type CommandGroup, defineCommand } from "../commands/command.ts";
import { ACCENT } from "../messages/body.ts";
import type { Boards } from "./boards.ts";

/** `!board top`, `!board optout`, `!board optin` and `!board remove`. */
export function boardCommands(boards: Boards): CommandGroup {
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

  return {
    name: "board",
    description: "Starboards, where messages with enough reactions go up.",
    subcommands: [top, optOut, optIn, remove],
  };
}
