import { type Client, Events } from "@fluxerjs/core";
import type { ReactionEmoji } from "./emoji.ts";

/** Something that acts on reactions to its own messages and ignores the rest. */
export interface ReactionListener {
  reactionAdded(messageId: string, userId: string, emoji: ReactionEmoji): Promise<void>;
  reactionRemoved(messageId: string, userId: string, emoji: ReactionEmoji): void | Promise<void>;
  /** All reactions, or all reactions of one emoji, were removed at once. */
  reactionsCleared(messageId: string, emoji?: ReactionEmoji): void | Promise<void>;
}

/** Feeds reaction events to `listener`, skipping bots, this one included. */
export function attachReactions(client: Client, listener: ReactionListener, label: string) {
  const isBot = (userId: string, bot: boolean | undefined) =>
    bot === true || userId === client.user?.id;
  const run = (task: () => void | Promise<void>) => {
    void (async () => task())().catch((err) =>
      console.error(`${label} reaction handling failed:`, err),
    );
  };

  client.on(Events.MessageReactionAdd, (p) => {
    if (isBot(p.userId, p.user?.bot)) return;
    run(() => listener.reactionAdded(p.messageId, p.userId, p.emoji));
  });

  client.on(Events.MessageReactionAddMany, (p) => {
    run(async () => {
      for (const r of p.reactions) {
        if (isBot(r.userId, r.member?.user.bot)) continue;
        await listener.reactionAdded(p.messageId, r.userId, r.emoji);
      }
    });
  });

  client.on(Events.MessageReactionRemove, (p) => {
    if (isBot(p.userId, p.user?.bot)) return;
    run(() => listener.reactionRemoved(p.messageId, p.userId, p.emoji));
  });

  client.on(Events.MessageReactionRemoveAll, (p) => {
    run(() => listener.reactionsCleared(p.messageId));
  });

  client.on(Events.MessageReactionRemoveEmoji, (p) => {
    run(() => listener.reactionsCleared(p.messageId, p.emoji));
  });
}
