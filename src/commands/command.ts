import type { Bot } from "../bot.ts";

// Commands are written against this module only. The prefix adapter in
// router.ts turns a chat message into a CommandContext; slash commands will get
// their own adapter once Fluxer ships interactions, without touching commands.

export type OptionType = "string" | "integer" | "attachment";

export interface OptionSpec {
  name: string;
  description: string;
  type: OptionType;
  /** Defaults to true. */
  required?: boolean;
  /** Strings only: take the rest of the input, spaces included. Must come last. */
  rest?: boolean;
}

export interface Attachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

interface OptionValues {
  string: string;
  integer: number;
  attachment: Attachment;
}

export type OptionValue = OptionValues[OptionType];

/** Maps option specs to the typed `ctx.options` object a command receives. */
export type Options<O extends readonly OptionSpec[]> = {
  [S in O[number] as S["name"]]: S["required"] extends false
    ? OptionValues[S["type"]] | undefined
    : OptionValues[S["type"]];
};

/** An error whose message is meant for the user; the router replies with it. */
export class UserError extends Error {
  override name = "UserError";
}

export interface SentReply {
  edit(content: string): Promise<void>;
}

export interface CommandContext<O = {}> {
  bot: Bot;
  userId: string;
  guildId: string;
  channelId: string;
  options: O;
  reply(content: string): Promise<SentReply>;
}

/** Returns a reason to refuse the command, or undefined to allow it. */
export type Guard = (ctx: CommandContext<unknown>) => Promise<string | undefined>;

export interface Command<O extends readonly OptionSpec[] = readonly OptionSpec[]> {
  name: string;
  description: string;
  options?: O;
  guard?: Guard;
  run(ctx: CommandContext<Options<O>>): Promise<void>;
}

export interface CommandGroup {
  name: string;
  description: string;
  subcommands: Command[];
}

export type CommandEntry = Command | CommandGroup;

export function isGroup(entry: CommandEntry): entry is CommandGroup {
  return "subcommands" in entry;
}

/** Identity function that infers option names and types for `run`. */
export function defineCommand<const O extends readonly OptionSpec[] = []>(
  command: Command<O>,
): Command<O> {
  return command;
}

/** e.g. `<name> <image: attachment> [reason...]` */
export function formatUsage(options: readonly OptionSpec[] = []): string {
  return options
    .map((o) => {
      const label =
        o.type === "attachment" ? `${o.name}: attachment` : o.rest ? `${o.name}...` : o.name;
      return o.required === false ? `[${label}]` : `<${label}>`;
    })
    .join(" ");
}
