import type { Client } from "@fluxerjs/core";
import type { PollFile, PollTransport } from "./transport.ts";

export class FluxerPollTransport implements PollTransport {
  constructor(private readonly client: Client) {}

  async post(channelId: string, content: string, files?: PollFile[]) {
    const message = await this.client.channels.send(channelId, {
      content,
      files: files?.map((f) => ({ name: f.name, data: f.data })),
    });
    return message.id;
  }

  async edit(channelId: string, messageId: string, content: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.edit({ content });
  }

  async react(channelId: string, messageId: string, emoji: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.react(emoji);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, userId: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.removeReaction(emoji, userId);
  }

  async reactionUsers(channelId: string, messageId: string, emoji: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    const userIds: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await message.fetchReactionUsersPage(emoji, { limit: 100, after });
      userIds.push(...page.users.filter((u) => !u.bot).map((u) => u.id));
      if (!page.hasMore || !page.nextAfter) return userIds;
      after = page.nextAfter;
    }
  }
}
