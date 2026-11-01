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
  /**
   * Attachments only: the file has to come with the message. A pasted link is
   * refused instead of downloaded.
   */
  attachedOnly?: boolean;
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
  description: string;
  options?: O;
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

/** e.g. `<name> <image: attachment or link> [reason...] [--tags tags]` */
export function formatUsage(options: readonly OptionSpec[] = []): string {
  return options
    .map((o) => {
      const label =
        o.type === "attachment"
          ? o.attachedOnly
            ? `${o.name}: attachment`
            : `${o.name}: attachment or link`
          : o.named
            ? `--${o.name} ${o.name}`
            : o.rest
              ? `${o.name}...`
              : o.name;
      return o.required === false ? `[${label}]` : `<${label}>`;
    })
    .join(" ");
}
