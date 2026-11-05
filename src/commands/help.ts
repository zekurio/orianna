import { Effect } from "effect";
import { ACCENT, appendFooter, type EmbedField, embedPages, type MessageBody } from "../messages/body.ts";
import type { MemberPermissions } from "../permissions/rules.ts";
import {
  type Command,
  type CommandEntry,
  type CommandGroup,
  formatUsage,
  isGroup,
  mayRun,
  optionHelp,
  refuse,
  type UserError,
} from "./command.ts";

// What `!help` shows. The full list and a group list each command with its
// description only; a single command shows its usage and every option.

const LIST_PAGE_SIZE = 15;

/** Whether the member may run the command, or anything in the group. */
function mayOpen(entry: CommandEntry, permissions: MemberPermissions): boolean {
  if (!isGroup(entry)) return mayRun(entry, permissions);
  return (
    (entry.default !== undefined && mayRun(entry.default, permissions)) ||
    entry.subcommands.some((c) => mayRun(c, permissions))
  );
}

function listLine(prefix: string, path: string, description: string): string {
  return `\`${prefix}${path}\`: ${description}`;
}

function usage(prefix: string, path: string, command: Command): string {
  const options = formatUsage(command.options);
  return `\`${prefix}${path}${options ? ` ${options}` : ""}\``;
}

function optionLines(command: Command): string[] {
  return optionHelp(command.options).map((o) => `\`${o.usage}\` ${o.description}`);
}

/** Every command and group the member may run, with its description. */
export function commandList(
  prefix: string,
  entries: Iterable<CommandEntry>,
  permissions: MemberPermissions,
): MessageBody[] {
  const lines = [...entries]
    .filter((entry) => mayOpen(entry, permissions))
    .map((entry) => listLine(prefix, entry.name, entry.description));
  return embedPages("Commands", lines, LIST_PAGE_SIZE).map((page) =>
    appendFooter(page, `${prefix}help <command> shows how to use one`),
  );
}

/**
 * The group's subcommands the member may run, with their descriptions, and
 * how to use the group on its own when it has a default. Undefined when
 * there's nothing in it they may run.
 */
export function groupHelp(
  prefix: string,
  group: CommandGroup,
  permissions: MemberPermissions,
): MessageBody | undefined {
  const subcommands = group.subcommands.filter((c) => mayRun(c, permissions));
  const alone = group.default && mayRun(group.default, permissions) ? group.default : undefined;
  if (!alone && subcommands.length === 0) return undefined;

  const lines = subcommands.map((c) => listLine(prefix, `${group.name} ${c.name}`, c.description));
  const fields: EmbedField[] = alone
    ? [
        {
          name: "On its own",
          value: [usage(prefix, group.name, alone), alone.description, ...optionLines(alone)].join("\n"),
        },
      ]
    : [];
  return {
    embeds: [
      {
        title: `${prefix}${group.name}`,
        description: lines.length > 0 ? `${group.description}\n\n${lines.join("\n")}` : group.description,
        color: ACCENT,
        fields,
        ...(subcommands.length > 0 && { footer: `${prefix}help ${group.name} <command> shows how to use one` }),
      },
    ],
  };
}

/** How to use the command: its description and details, usage, and what each option takes. */
export function commandHelp(prefix: string, path: string, command: Command): MessageBody {
  const options = optionLines(command);
  const fields: EmbedField[] = [{ name: "Usage", value: usage(prefix, path, command) }];
  if (options.length > 0) fields.push({ name: "Options", value: options.join("\n") });
  return {
    embeds: [
      {
        title: `${prefix}${path}`,
        description: command.details ? `${command.description}\n\n${command.details}` : command.description,
        color: ACCENT,
        fields,
        ...(options.length > 0 && { footer: "<required> [optional], in this order. Quote values with spaces." }),
      },
    ],
  };
}

/**
 * Help for what `query` names: a group, like `karma`, or a command, like
 * `ping` or `karma set`. Refuses names the member may not run, the same as
 * ones that don't exist.
 */
export function helpFor(
  prefix: string,
  entries: ReadonlyMap<string, CommandEntry>,
  permissions: MemberPermissions,
  query: string,
): Effect.Effect<MessageBody, UserError> {
  const [first = "", second, ...extra] = query.trim().toLowerCase().split(/\s+/);
  const name = first.startsWith(prefix.toLowerCase()) ? first.slice(prefix.length) : first;
  const entry = entries.get(name);
  if (!entry || !mayOpen(entry, permissions)) {
    return refuse(`There's no \`${prefix}${name}\` you may run. \`${prefix}help\` lists the commands.`);
  }

  if (!isGroup(entry)) {
    if (second) return refuse(`\`${prefix}${name}\` has no commands of its own.`);
    return Effect.succeed(commandHelp(prefix, name, entry));
  }
  if (!second) return Effect.succeed(groupHelp(prefix, entry, permissions)!);

  const sub = entry.subcommands.find((c) => c.name === second);
  if (!sub || !mayRun(sub, permissions)) {
    return refuse(
      `There's no \`${prefix}${name} ${second}\` you may run. \`${prefix}help ${name}\` lists its commands.`,
    );
  }
  if (extra.length > 0) return refuse(`\`${prefix}${name} ${second}\` has no commands of its own.`);
  return Effect.succeed(commandHelp(prefix, `${name} ${sub.name}`, sub));
}
