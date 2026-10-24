import type { Message } from "@fluxerjs/core";
import type { Bot } from "../bot.ts";
import {
  type Attachment,
  type Command,
  type CommandContext,
  type CommandEntry,
  type OptionValue,
  formatError,
  formatUsage,
  isGroup,
  UserError,
} from "./command.ts";
import { ArgumentError, nextWord, parseOptions } from "./options.ts";

type BaseContext = Omit<CommandContext, "options">;

const PAGE_STEPS: Record<string, number> = { "⬅": -1, "➡": 1 };
/** Navigation stops after this long without a page turn. */
const PAGE_IDLE_MS = 2 * 60_000;

export class CommandRouter {
  readonly entries = new Map<string, CommandEntry>();

  constructor(entries: CommandEntry[]) {
    for (const entry of entries) {
      if (this.entries.has(entry.name)) {
        throw new Error(`duplicate command: ${entry.name}`);
      }
      this.entries.set(entry.name, entry);
    }
  }

  /** Prefix adapter: `!name [subcommand] args...` from a chat message. */
  async handleMessage(bot: Bot, message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guildId !== bot.config.guildId) return;

    const { prefix } = bot.config;
    if (!message.content.startsWith(prefix)) return;

    const first = nextWord(message.content.slice(prefix.length));
    if (!first) return;
    const entry = this.entries.get(first.word.toLowerCase());
    if (!entry) return;

    const base = messageContext(bot, message);
    let command: Command;
    let path = entry.name;
    let input = first.rest;

    if (isGroup(entry)) {
      const second = nextWord(input);
      const sub = second
        ? entry.subcommands.find((c) => c.name === second.word.toLowerCase())
        : undefined;
      if (!second || !sub) {
        const lines = entry.subcommands.map((c) => usageLine(prefix, `${entry.name} ${c.name}`, c));
        await base.reply(lines.join("\n"));
        return;
      }
      command = sub;
      path = `${entry.name} ${sub.name}`;
      input = second.rest;
    } else {
      command = entry;
    }

    let options;
    try {
      options = parseOptions(command.options ?? [], input, messageAttachments(message));
    } catch (err) {
      if (!(err instanceof ArgumentError)) throw err;
      await base.error(`${err.message}\nUsage: ${usageLine(prefix, path, command)}`);
      return;
    }

    await this.execute(path, command, { ...base, options });
  }

  /** Shared by every adapter: runs the command and reports failures. */
  private async execute(
    path: string,
    command: Command,
    ctx: CommandContext<Record<string, OptionValue>>,
  ) {
    try {
      const refused = await command.guard?.(ctx);
      if (refused) {
        await ctx.error(refused);
        return;
      }
      await command.run(ctx);
    } catch (err) {
      if (err instanceof UserError) {
        await ctx.error(err.message).catch(() => {});
        return;
      }
      console.error(`command ${path} failed:`, err);
      await ctx.error("Something went wrong running that command.").catch(() => {});
    }
  }
}

export function usageLine(prefix: string, path: string, command: Command): string {
  const usage = formatUsage(command.options);
  return `\`${prefix}${path}${usage ? ` ${usage}` : ""}\`: ${command.description}`;
}

function messageContext(bot: Bot, message: Message): BaseContext {
  const reply = async (content: string) => {
    const sent = await message.reply(content);
    return {
      async edit(content: string) {
        await sent.edit({ content });
      },
    };
  };
  return {
    bot,
    userId: message.author.id,
    guildId: message.guildId!,
    channelId: message.channelId,
    reply,
    async replyPages(pages) {
      if (pages.length <= 1) {
        await reply(pages[0] ?? "");
        return;
      }
      await sendPaginated(message, pages);
    },
    async error(text) {
      await reply(formatError(text));
    },
  };
}

/**
 * Replies with the first page and lets the invoking user turn pages with ⬅️ / ➡️
 * reactions until they go idle. Their reactions are removed after each turn so
 * the same arrow can be pressed again.
 */
async function sendPaginated(message: Message, pages: readonly string[]) {
  let page = 0;
  const render = () => `${pages[page]}\n\n*Page ${page + 1}/${pages.length}*`;

  const sent = await message.reply(render());
  const collector = sent.createReactionCollector({
    filter: (_reaction, user) => user.id === message.author.id,
  });

  let idle: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => collector.stop("time"), PAGE_IDLE_MS);
  };
  // Page turns run one at a time so rapid presses can't race their edits.
  let turns = Promise.resolve();
  const report = (err: unknown) => console.warn("pagination failed:", err);

  collector.on("collect", (reaction, user) => {
    const name = reaction.emoji.name;
    const step = name ? PAGE_STEPS[name.replaceAll("\uFE0F", "")] : undefined;
    if (!step) return;
    resetIdle();
    turns = turns
      .then(async () => {
        await sent.removeReaction(name!, user.id).catch(() => {});
        page = (page + step + pages.length) % pages.length;
        await sent.edit({ content: render() });
      })
      .catch(report);
  });

  collector.on("end", () => {
    clearTimeout(idle);
    turns = turns
      .then(async () => {
        for (const emoji of Object.keys(PAGE_STEPS)) {
          await sent.removeReaction(`${emoji}\uFE0F`).catch(() => {});
        }
      })
      .catch(report);
  });

  resetIdle();
  // Best effort: the user can still add the arrows themselves.
  for (const emoji of Object.keys(PAGE_STEPS)) {
    await sent.react(`${emoji}\uFE0F`).catch(report);
  }
}

function messageAttachments(message: Message): Attachment[] {
  return [...message.attachments.values()].flatMap((a) =>
    a.url
      ? [{ url: a.url, filename: a.filename, contentType: a.contentType, size: a.size }]
      : [],
  );
}
