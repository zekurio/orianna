import type { Client } from "@fluxerjs/core";
import { EmojiRejected, type EmojiGuild } from "./proposals.ts";

export class FluxerEmojiGuild implements EmojiGuild {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  async emojis() {
    const guild = await this.client.guilds.resolve(this.guildId);
    return (await guild.fetchEmojis()).map((e) => ({ id: e.id, name: e.name }));
  }

  async createEmoji(name: string, image: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    try {
      return (await guild.createEmoji({ name, image })).id;
    } catch (err) {
      // fluxer.js HTTP errors carry `isRetryable` (429 and 5xx). Anything
      // else from the API is final; network errors have no flag and retry.
      if ((err as { isRetryable?: boolean }).isRetryable === false) {
        throw new EmojiRejected((err as Error).message);
      }
      throw err;
    }
  }

  async send(channelId: string, content: string, replyTo?: string) {
    await this.client.channels.send(channelId, {
      content,
      replyTo: replyTo ? { channelId, messageId: replyTo, guildId: this.guildId } : undefined,
    });
  }
}
