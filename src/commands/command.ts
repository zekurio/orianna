import type { Bot } from "../bot.ts";
import type { MessageBody } from "../messages/body.ts";
import type { MemberPermissions, Permission } from "../permissions/rules.ts";

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
  /**
   * Strings only: take the rest of the positional input, spaces included. Must
   * be the last positional option.
   */
  rest?: boolean;
  /**
   * Given as `--name value` anywhere after the positional options instead of by
   * position. The value runs until the next `--flag`, so it may contain spaces.
   */
  named?: boolean;
}

/**
 * A file for an attachment option. Prefix commands also accept a link in its
 * place; nothing is known about a linked file until it's downloaded.
 */
export interface Attachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  /** True when a member pasted a link; false for a file Fluxer handed over. */
  linked: boolean;
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

/**
 * An error whose message is meant for the user. Throw it from anywhere a
 * command calls into; the router answers with `ctx.error(message)`.
 */
export class UserError extends Error {
  override name = "UserError";
}

export interface SentReply {
  edit(body: MessageBody): Promise<void>;
}

export interface CommandContext<O = {}> {
  bot: Bot;
  userId: string;
  guildId: string;
  channelId: string;
  options: O;
  /**
   * Answers the invoking user. Mentions in the reply show but don't notify
   * anyone; only the invoking user is pinged, by the reply itself.
   */
  reply(body: MessageBody): Promise<SentReply>;
  /**
   * Answers with pages the invoking user can flip through. A single page is
   * sent as a plain reply.
   */
  replyPages(pages: readonly MessageBody[]): Promise<void>;
  /**
   * Answers the invoking user with an error, formatted the same way everywhere.
   * Use `return ctx.error(...)` to stop a command; deeper code can throw
   * `UserError` instead.
   */
  error(message: string): Promise<void>;
  /**
   * Deletes the message that ran the command, for commands whose result
   * stands on its own. Does nothing when the bot isn't allowed to.
   */
  deleteInvocation(): Promise<void>;
}

/** How every adapter renders `ctx.error`. */
export function formatError(message: string): string {
  return `⚠️ ${message}`;
}

export interface Command<O extends readonly OptionSpec[] = readonly OptionSpec[]> {
  name: string;
  description: string;
  options?: O;
  /** Members without it are refused, and `!help` leaves the command out for them. */
  permission?: Permission;
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

export function mayRun(command: Command, permissions: MemberPermissions): boolean {
  return command.permission === undefined || permissions.has(command.permission);
}

/** Identity function that infers option names and types for `run`. */
export function defineCommand<const O extends readonly OptionSpec[] = []>(
  command: Command<O>,
): Command<O> {
  return command;
}

/** e.g. `<name> <image: attachment or link> [reason...] [--tags tags]` */
export function formatUsage(options: readonly OptionSpec[] = []): string {
  return options
    .map((o) => {
      const label =
        o.type === "attachment"
          ? `${o.name}: attachment or link`
          : o.named
            ? `--${o.name} ${o.name}`
            : o.rest
              ? `${o.name}...`
              : o.name;
      return o.required === false ? `[${label}]` : `<${label}>`;
    })
    .join(" ");
}
