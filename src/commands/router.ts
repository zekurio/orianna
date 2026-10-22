import type { Message } from "@fluxerjs/core";
import type { Bot } from "../bot.ts";
import {
  type Attachment,
  type Command,
  type CommandContext,
  type CommandEntry,
  type OptionValue,
  formatUsage,
  isGroup,
  UserError,
} from "./command.ts";
import { ArgumentError, nextWord, parseOptions } from "./options.ts";

type BaseContext = Omit<CommandContext, "options">;

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
      await base.reply(`${err.message}\nUsage: ${usageLine(prefix, path, command)}`);
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
        await ctx.reply(refused);
        return;
      }
      await command.run(ctx);
    } catch (err) {
      if (err instanceof UserError) {
        await ctx.reply(err.message).catch(() => {});
        return;
      }
      console.error(`command ${path} failed:`, err);
      await ctx.reply("Something went wrong running that command.").catch(() => {});
    }
  }
}

export function usageLine(prefix: string, path: string, command: Command): string {
  const usage = formatUsage(command.options);
  return `\`${prefix}${path}${usage ? ` ${usage}` : ""}\`: ${command.description}`;
}

function messageContext(bot: Bot, message: Message): BaseContext {
  return {
    bot,
    userId: message.author.id,
    guildId: message.guildId!,
    channelId: message.channelId,
    async reply(content) {
      const sent = await message.reply(content);
      return {
        async edit(content) {
          await sent.edit({ content });
        },
      };
    },
  };
}

function messageAttachments(message: Message): Attachment[] {
  return [...message.attachments.values()].flatMap((a) =>
    a.url
      ? [{ url: a.url, filename: a.filename, contentType: a.contentType, size: a.size }]
      : [],
  );
}
