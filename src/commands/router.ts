import type { Message } from "@fluxerjs/core";
import { Cause, Context, Duration, Effect, Layer, Queue, Ref, Result, type Scope, Stream } from "effect";
import type { AppConfig } from "../config.ts";
import { type Fluxer, type FluxerError, logFailure, request } from "../fluxer.ts";
import { appendFooter, type MessageBody } from "../messages/body.ts";
import { editOptions, REPLY_MENTION, sendOptions } from "../messages/fluxer.ts";
import { Guilds } from "../guilds.ts";
import { GuildAccess } from "../permissions/rules.ts";
import { Settings } from "../settings/settings.ts";
import {
  type Attachment,
  type Command,
  type CommandContext,
  type CommandEntry,
  type CommandGroup,
  type OptionValue,
  formatError,
  formatUsage,
  isGroup,
  mayRun,
} from "./command.ts";
import { nextWord, parseOptions } from "./options.ts";

type BaseContext = Omit<CommandContext, "options">;

const PAGE_STEPS: Record<string, number> = { "⬅": -1, "➡": 1 };
/** Navigation stops after this long without a page turn. */
const PAGE_IDLE = Duration.minutes(2);

export class CommandRouter extends Context.Service<
  CommandRouter,
  {
    /** The guild's commands as they are now; they change with its settings. */
    readonly entries: (guildId: string) => Effect.Effect<ReadonlyMap<string, CommandEntry>>;
    /** Replaces the guild's commands. Commands already running carry on. */
    readonly setCommands: (guildId: string, list: readonly CommandEntry[]) => Effect.Effect<void>;
    /** Drops the guild's commands, once the bot left it. */
    readonly removeGuild: (guildId: string) => Effect.Effect<void>;
    /** Prefix adapter: `!name [subcommand] args...` from a chat message. */
    readonly handleMessage: (message: Message) => Effect.Effect<void, FluxerError>;
  }
>()("orianna/CommandRouter") {}

/** Each guild's commands by name, keyed by guild ID. */
type Commands = ReadonlyMap<string, ReadonlyMap<string, CommandEntry>>;

/**
 * Every guild's commands as they are now, for what starts before the router
 * does, like the web interface. The router keeps it up to date.
 */
export class CommandList extends Context.Service<CommandList, Ref.Ref<Commands>>()("orianna/CommandList") {
  static readonly layer = Layer.effect(CommandList, Ref.make<Commands>(new Map()));
}

/**
 * Builds the router. A guild has no commands until its features set them.
 * Commands run with their guild's services. Paginated replies keep listening
 * for page turns until they go idle or the scope closes.
 */
export const makeCommandRouter = Effect.fnUntraced(function* () {
  const current = yield* CommandList;
  const setCommands = (guildId: string, list: readonly CommandEntry[]) =>
    Effect.suspend(() => {
      const next = new Map<string, CommandEntry>();
      for (const entry of list) {
        if (next.has(entry.name)) return Effect.die(new Error(`duplicate command: ${entry.name}`));
        next.set(entry.name, entry);
      }
      return Ref.update(current, (all) => new Map(all).set(guildId, next));
    });
  const removeGuild = (guildId: string) =>
    Ref.update(current, (all) => {
      const next = new Map(all);
      next.delete(guildId);
      return next;
    });
  const context = yield* Effect.context<AppConfig | Fluxer | Guilds>();
  const scope = yield* Effect.scope;

  /** Runs the message's command in its guild, if it is one. */
  const handleMessage = Effect.fnUntraced(function* (message: Message) {
    if (message.author.bot || !message.guildId) return;
    const commands = (yield* Ref.get(current)).get(message.guildId);
    if (!commands) return;
    const guild = yield* (yield* Guilds).context(message.guildId).pipe(
      // The guild's commands are only set once its services are built.
      Effect.orDie,
    );
    yield* handleIn(message, commands).pipe(Effect.provideContext(guild));
  });

  const handleIn = Effect.fnUntraced(function* (message: Message, commands: ReadonlyMap<string, CommandEntry>) {
    const { prefix } = yield* Settings.current;
    if (!message.content.startsWith(prefix)) return;

    const first = nextWord(message.content.slice(prefix.length));
    if (!first) return;
    const entry = commands.get(first.word.toLowerCase());
    if (!entry) return;

    const base = messageContext(message, scope);
    let command: Command;
    let path = entry.name;
    let input = first.rest;

    if (isGroup(entry)) {
      const second = nextWord(input);
      const sub = second
        ? entry.subcommands.find((c) => c.name === second.word.toLowerCase())
        : undefined;
      if (!second || !sub) {
        yield* listSubcommands(prefix, base, entry).pipe(
          Effect.catchCause(logFailure(`listing ${entry.name} commands`)),
        );
        return;
      }
      command = sub;
      path = `${entry.name} ${sub.name}`;
      input = second.rest;
    } else {
      command = entry;
    }

    const options = yield* Effect.result(
      parseOptions(command.options ?? [], input, messageAttachments(message)),
    );
    if (Result.isFailure(options)) {
      return yield* base.error(`${options.failure.message}\nUsage: ${usageLine(prefix, path, command)}`);
    }

    yield* execute(path, command, { ...base, options: options.success });
  });

  /** Shared by every adapter: runs the command and reports failures. */
  const execute = (
    path: string,
    command: Command,
    ctx: CommandContext<Record<string, OptionValue>>,
  ) =>
    Effect.gen(function* () {
      const { permission } = command;
      const access = yield* GuildAccess;
      if (command.adminOnly && !(yield* access.permissionsOf(ctx.userId)).bypass) {
        return yield* ctx.error("Only the server owner and members with Administrator may do that.");
      }
      if (permission && !(yield* access.can(ctx.userId, permission))) {
        return yield* ctx.error(`You need the \`${permission}\` permission for that.`);
      }
      yield* command.run(ctx);
    }).pipe(
      Effect.provideService(CommandRouter, router),
      Effect.catchTag("UserError", (err) => ctx.error(err.message).pipe(Effect.ignore)),
      Effect.catchCause((cause) =>
        // A shutdown interrupts commands; there's nobody to tell then.
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(`command ${path} failed`, cause).pipe(
              Effect.andThen(ctx.error("Something went wrong running that command.")),
              Effect.ignore,
            ),
      ),
    );

  const router: CommandRouter["Service"] = {
    entries: (guildId) => Ref.get(current).pipe(Effect.map((all) => all.get(guildId) ?? new Map())),
    setCommands,
    removeGuild,
    handleMessage: (message) => handleMessage(message).pipe(Effect.provideContext(context)),
  };
  return router;
});

/** Answers a group name on its own with the subcommands the member may run. */
function listSubcommands(prefix: string, ctx: BaseContext, group: CommandGroup) {
  return Effect.gen(function* () {
    const permissions = yield* (yield* GuildAccess).permissionsOf(ctx.userId);
    const lines = group.subcommands
      .filter((c) => mayRun(c, permissions))
      .map((c) => usageLine(prefix, `${group.name} ${c.name}`, c));
    yield* ctx.reply(lines.length > 0 ? lines.join("\n") : "There's nothing here you may run.");
  });
}

export function usageLine(prefix: string, path: string, command: Command): string {
  const usage = formatUsage(command.options);
  return `\`${prefix}${path}${usage ? ` ${usage}` : ""}\`: ${command.description}`;
}

function messageContext(message: Message, scope: Scope.Scope): BaseContext {
  const reply = (body: MessageBody) =>
    request("replying", () => message.reply(sendOptions(body, REPLY_MENTION))).pipe(
      Effect.map((sent) => ({
        edit: (body: MessageBody) =>
          request("editing a reply", () => sent.edit(editOptions(body, REPLY_MENTION))).pipe(
            Effect.asVoid,
          ),
      })),
    );
  return {
    userId: message.author.id,
    guildId: message.guildId!,
    channelId: message.channelId,
    reply,
    replyPages: (pages) =>
      pages.length <= 1 ? Effect.asVoid(reply(pages[0] ?? "")) : sendPaginated(message, pages, scope),
    error: (text) => Effect.asVoid(reply(formatError(text))),
    deleteInvocation: () => request("deleting a command", () => message.delete()).pipe(Effect.ignore),
  };
}

/**
 * Replies with the first page and lets the invoking user turn pages with ⬅️ / ➡️
 * reactions until they go idle. Their reactions are removed after each turn so
 * the same arrow can be pressed again. Turning pages goes on in `scope`.
 */
const sendPaginated = Effect.fnUntraced(function* (
  message: Message,
  pages: readonly MessageBody[],
  scope: Scope.Scope,
) {
  let page = 0;
  const render = () => appendFooter(pages[page]!, `Page ${page + 1}/${pages.length}`);
  const sent = yield* request("replying", () => message.reply(sendOptions(render(), REPLY_MENTION)));
  const warn = (err: FluxerError) => Effect.logWarning(`pagination: ${err.message}`);

  const presses = Stream.callback<{ name: string; userId: string; step: number }>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const collector = sent.createReactionCollector({
          filter: (_reaction, user) => user.id === message.author.id,
        });
        collector.on("collect", (reaction, user) => {
          // The collector reports each user and emoji only once; forget them so the
          // same arrow turns the page again the next time it's pressed.
          collector.collected.clear();
          const name = reaction.emoji.name;
          const step = name ? PAGE_STEPS[name.replaceAll("️", "")] : undefined;
          if (name && step) Queue.offerUnsafe(queue, { name, userId: user.id, step });
        });
        return collector;
      }),
      (collector) => Effect.sync(() => collector.stop()),
    ),
  );

  // One press at a time, so rapid presses can't race their edits.
  yield* presses.pipe(
    Stream.timeout(PAGE_IDLE),
    Stream.runForEach(({ name, userId, step }) =>
      Effect.gen(function* () {
        yield* request("removing a page turn", () => sent.removeReaction(name, userId)).pipe(
          Effect.ignore,
        );
        page = (page + step + pages.length) % pages.length;
        yield* request("turning a page", () => sent.edit(editOptions(render(), REPLY_MENTION)));
      }).pipe(Effect.catch(warn)),
    ),
    Effect.andThen(
      Effect.forEach(
        Object.keys(PAGE_STEPS),
        (emoji) =>
          request("removing page arrows", () => sent.removeReaction(`${emoji}️`)).pipe(Effect.ignore),
        { discard: true },
      ),
    ),
    Effect.forkIn(scope),
  );

  // Best effort: the user can still add the arrows themselves.
  for (const emoji of Object.keys(PAGE_STEPS)) {
    yield* request("adding page arrows", () => sent.react(`${emoji}️`)).pipe(Effect.catch(warn));
  }
});

function messageAttachments(message: Message): Attachment[] {
  return [...message.attachments.values()].flatMap((a) =>
    a.url
      ? [{ url: a.url, filename: a.filename, contentType: a.contentType, size: a.size, linked: false }]
      : [],
  );
}
