import { type Client, Events } from "@fluxerjs/core";
import type { PollService } from "./service.ts";
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

/** Feeds reaction events into the poll service, skipping bots. */
export function attachPollEvents(client: Client, polls: PollService) {
  const isBot = (userId: string, bot: boolean | undefined) =>
    bot === true || userId === client.user?.id;
  const report = (err: unknown) => console.error("poll reaction handling failed:", err);

  client.on(Events.MessageReactionAdd, (p) => {
    if (isBot(p.userId, p.user?.bot)) return;
    polls.reactionAdded(p.messageId, p.userId, p.emoji).catch(report);
  });

  client.on(Events.MessageReactionAddMany, (p) => {
    void (async () => {
      for (const r of p.reactions) {
        if (isBot(r.userId, r.member?.user.bot)) continue;
        await polls.reactionAdded(p.messageId, r.userId, r.emoji);
      }
    })().catch(report);
  });

  client.on(Events.MessageReactionRemove, (p) => {
    if (isBot(p.userId, p.user?.bot)) return;
    try {
      polls.reactionRemoved(p.messageId, p.userId, p.emoji);
    } catch (err) {
      report(err);
    }
  });

  client.on(Events.MessageReactionRemoveAll, (p) => {
    try {
      polls.reactionsCleared(p.messageId);
    } catch (err) {
      report(err);
    }
  });

  client.on(Events.MessageReactionRemoveEmoji, (p) => {
    try {
      polls.reactionsCleared(p.messageId, p.emoji);
    } catch (err) {
      report(err);
    }
  });
}
