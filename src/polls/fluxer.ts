import { type Client, Events } from "@fluxerjs/core";
import type { MessageBody } from "../messages/body.ts";
import { ALL_MENTIONS, editOptions, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import type { CommunityPollChat, CommunityPolls } from "./community.ts";
import type { PollTransport, PostOptions } from "./transport.ts";

export class FluxerPollTransport implements PollTransport, CommunityPollChat {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  async post(channelId: string, body: MessageBody, options: PostOptions = {}) {
    const message = await this.client.channels.send(channelId, {
      ...sendOptions(body, options.mentions ? ALL_MENTIONS : NO_MENTIONS),
      files: options.files?.map((f) => ({ name: f.name, data: f.data })),
    });
    return message.id;
  }

  async edit(channelId: string, messageId: string, body: MessageBody) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.edit(editOptions(body, NO_MENTIONS));
  }

  async reply(channelId: string, messageId: string, content: string, notify: readonly string[]) {
    await this.client.channels.send(channelId, {
      content,
      replyTo: { channelId, messageId, guildId: this.guildId },
      allowedMentions: { parse: [], users: [...notify] },
    });
  }

  async react(channelId: string, messageId: string, emoji: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.react(emoji);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, userId: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.removeReaction(emoji, userId);
  }

  async clearReaction(channelId: string, messageId: string, emoji: string) {
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    await message.removeReactionEmoji(emoji);
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

  async emojiIds() {
    const guild = await this.client.guilds.resolve(this.guildId);
    return (await guild.fetchEmojis()).map((e) => e.id);
  }

  /** The same link the Fluxer app copies for a message. */
  messageLink(channelId: string, messageId: string) {
    const webapp = this.client.instance.endpoints.webapp.replace(/\/+$/, "");
    return `${webapp}/channels/${this.guildId}/${channelId}/${messageId}`;
  }
}

/** Calls off community polls whose message is deleted. */
export function attachPollMessageDeletes(client: Client, community: CommunityPolls) {
  const deleted = (messageId: string) => {
    community
      .messageDeleted(messageId)
      .catch((err) => console.error("poll message delete handling failed:", err));
  };
  client.on(Events.MessageDelete, (message) => deleted(message.id));
  client.on(Events.MessageDeleteBulk, (p) => {
    for (const id of p.ids) deleted(id);
  });
}
