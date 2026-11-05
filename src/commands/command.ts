import { Data, Effect } from "effect";
import type { AppConfig } from "../config.ts";
import type { Fluxer, FluxerError } from "../fluxer.ts";
import type { CurrentGuild } from "../guild.ts";
import type { MessageBody } from "../messages/body.ts";
import type { GuildAccess, MemberPermissions, Permission } from "../permissions/rules.ts";
import type { Settings } from "../settings/settings.ts";
import type { CommandRouter } from "./router.ts";

// Commands are written against this module only. The prefix adapter in
// router.ts turns a chat message into a CommandContext; slash commands will get
// their own adapter once Fluxer ships interactions, without touching commands.

export type OptionType = "string" | "integer" | "attachment";

/**
 * Options are given by position, in order, like chat bots took them before
 * slash commands: one word each, or a quoted value with spaces. Attachments
 * don't take a position; see `parseOptions` in options.ts.
 * `checkOptions` holds every command to that when it's registered.
 */
export interface OptionSpec {
  name: string;
  description: string;
  type: OptionType;
  /**
   * Defaults to true. Required strings and integers can't come after
   * optional ones; an empty pair of quotes skips an optional one.
   */
  required?: boolean;
  /**
   * Strings only: take the rest of the input as typed, spaces and quotes
   * included. Must be the last string or integer option.
   */
  rest?: boolean;
  /**
   * Attachments only: the file has to come with the message. A pasted link is
   * refused instead of downloaded.
   */
  attachedOnly?: boolean;
  /**
   * Rest strings only: the pieces the command reads out of the text itself,
   * like a poll's question, answers and duration. Usage and help show them in
   * place of the option; parsing still hands over the whole text.
   */
  parts?: readonly OptionPart[];
}

/** A piece of a rest option's text, for usage and help only. */
export interface OptionPart {
  name: string;
  description: string;
  /** Defaults to true. */
  required?: boolean;
  /** May be given more than once, like a poll's answers. */
  repeated?: boolean;
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
 * An error whose message is meant for the user. Fail with it from anywhere a
 * command calls into; the router answers with `ctx.error(message)`.
 */
export class UserError extends Data.TaggedError("UserError")<{ readonly message: string }> {}

/** Fails with a UserError, for `return yield* refuse(...)`. */
export function refuse(message: string): Effect.Effect<never, UserError> {
  return Effect.fail(new UserError({ message }));
}

/** `<@id>`, `<@!id>` or a bare ID. */
const MEMBER = /^(?:<@!?(\d+)>|(\d+))$/;

/** The user ID of a member option, given as a mention or an ID. */
export function memberId(input: string): Effect.Effect<string, UserError> {
  const match = MEMBER.exec(input.trim());
  if (!match) return refuse(`${input} isn't a mention or a user ID.`);
  return Effect.succeed((match[1] ?? match[2])!);
}

/** Services every command may use. */
/** What every command may use: its guild's settings and access, and what all guilds share. */
export type CommandServices = AppConfig | CurrentGuild | Settings | GuildAccess | Fluxer | CommandRouter;

/** What a command may fail with. Anything else that goes wrong is a defect. */
export type CommandError = UserError | FluxerError;

export interface SentReply {
  edit(body: MessageBody): Effect.Effect<void, FluxerError>;
}

export interface CommandContext<O = {}> {
  userId: string;
  guildId: string;
  channelId: string;
  options: O;
  /**
   * Answers the invoking user. Mentions in the reply show but don't notify
   * anyone; only the invoking user is pinged, by the reply itself.
   */
  reply(body: MessageBody): Effect.Effect<SentReply, FluxerError>;
  /**
   * Answers with pages the invoking user can flip through. A single page is
   * sent as a plain reply.
   */
  replyPages(pages: readonly MessageBody[]): Effect.Effect<void, FluxerError>;
  /**
   * Answers the invoking user with an error, formatted the same way everywhere.
   * Use `return yield* ctx.error(...)` to stop a command; deeper code can fail
   * with `UserError` instead.
   */
  error(message: string): Effect.Effect<void, FluxerError>;
  /**
   * Deletes the message that ran the command, for commands whose result
   * stands on its own. Does nothing when the bot isn't allowed to.
   */
  deleteInvocation(): Effect.Effect<void>;
}

/** How every adapter renders `ctx.error`. */
export function formatError(message: string): string {
  return `⚠️ ${message}`;
}

export interface Command<O extends readonly OptionSpec[] = readonly OptionSpec[]> {
  name: string;
  /** One line; lists show only this. */
  description: string;
  /**
   * What doesn't fit in one line, like an example. Shown with the description
   * by `!help <command>` and on the web.
   */
  details?: string;
  options?: O;
  /**
   * For a command outside a group: the heading the commands page lists it
   * under with the rest of its feature, like Polls. Without one it goes under
   * General.
   */
  section?: string;
  /** Members without it are refused, and `!help` leaves the command out for them. */
  permission?: Permission;
  /**
   * Only the guild owner and members with Administrator may run it, and
   * `!help` leaves it out for everyone else. No rule can grant it.
   */
  adminOnly?: boolean;
  run(ctx: CommandContext<Options<O>>): Effect.Effect<void, CommandError, CommandServices>;
}

export interface CommandGroup {
  name: string;
  description: string;
  subcommands: Command[];
  /**
   * Runs on the group's name alone, or when the next word isn't a
   * subcommand, like `!karma @someone`. Without it, the group lists its
   * subcommands.
   */
  default?: Command;
}

export type CommandEntry = Command | CommandGroup;

export function isGroup(entry: CommandEntry): entry is CommandGroup {
  return "subcommands" in entry;
}

export function mayRun(command: Command, permissions: MemberPermissions): boolean {
  if (command.adminOnly && !permissions.bypass) return false;
  return command.permission === undefined || permissions.has(command.permission);
}

/** Identity function that infers option names and types for `run`. */
export function defineCommand<const O extends readonly OptionSpec[] = []>(
  command: Command<O>,
): Command<O> {
  return command;
}

/** e.g. `<name> <image: attachment or link> [reason...]` */
export function formatUsage(options: readonly OptionSpec[] = []): string {
  return options
    .map((o) => {
      if (o.parts) return o.parts.map(partUsage).join(" ");
      const label =
        o.type === "attachment"
          ? o.attachedOnly
            ? `${o.name}: attachment`
            : `${o.name}: attachment or link`
          : o.rest
            ? `${o.name}...`
            : o.name;
      return o.required === false ? `[${label}]` : `<${label}>`;
    })
    .join(" ");
}

function partUsage(part: OptionPart): string {
  const label = part.repeated ? `${part.name}...` : part.name;
  return part.required === false ? `[${label}]` : `<${label}>`;
}

/** Each option as help explains it, with an option's parts in its place. */
export function optionHelp(
  options: readonly OptionSpec[] = [],
): { name: string; usage: string; description: string }[] {
  return options.flatMap((o) =>
    o.parts
      ? o.parts.map((p) => ({ name: p.name, usage: partUsage(p), description: p.description }))
      : [{ name: o.name, usage: formatUsage([o]), description: o.description }],
  );
}

/**
 * Why the command's options can't be parsed by position, or undefined when
 * they can: a rest option that isn't last, parts without rest, or a required
 * value after an optional one.
 */
export function checkOptions(command: Command): string | undefined {
  const positional = (command.options ?? []).filter((o) => o.type !== "attachment");
  for (const [i, o] of positional.entries()) {
    if (o.rest && (o.type !== "string" || i !== positional.length - 1)) {
      return `${o.name} takes the rest of the input, so it has to be the last string option`;
    }
    if (o.parts && !o.rest) return `${o.name} has parts but doesn't take the rest of the input`;
    if (o.required !== false && positional.slice(0, i).some((p) => p.required === false)) {
      return `${o.name} is required but comes after an optional option`;
    }
  }
  return undefined;
}
