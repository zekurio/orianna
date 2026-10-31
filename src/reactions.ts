import { Events } from "@fluxerjs/core";
import { Effect } from "effect";
import type { ReactionEmoji } from "./emoji.ts";
import { Fluxer, listen } from "./fluxer.ts";

/** Something that acts on reactions to its own messages and ignores the rest. */
export interface ReactionListener<E = never> {
  reactionAdded(messageId: string, userId: string, emoji: ReactionEmoji): Effect.Effect<void, E>;
  reactionRemoved(messageId: string, userId: string, emoji: ReactionEmoji): Effect.Effect<void, E>;
  /** All reactions, or all reactions of one emoji, were removed at once. */
  reactionsCleared(messageId: string, emoji?: ReactionEmoji): Effect.Effect<void, E>;
}

/** Feeds reaction events to `listener` until the scope closes, skipping bots, this one included. */
export const attachReactions = Effect.fnUntraced(function* <E>(
  listener: ReactionListener<E>,
  label: string,
) {
  const { client } = yield* Fluxer;
  const isBot = (userId: string, bot: boolean | undefined) =>
    bot === true || userId === client.user?.id;
  const failed = `${label} reaction handling`;

  yield* listen(Events.MessageReactionAdd, failed, (p) =>
    isBot(p.userId, p.user?.bot) ? Effect.void : listener.reactionAdded(p.messageId, p.userId, p.emoji),
  );
  yield* listen(Events.MessageReactionAddMany, failed, (p) =>
    Effect.forEach(
      p.reactions.filter((r) => !isBot(r.userId, r.member?.user.bot)),
      (r) => listener.reactionAdded(p.messageId, r.userId, r.emoji),
      { discard: true },
    ),
  );
  yield* listen(Events.MessageReactionRemove, failed, (p) =>
    isBot(p.userId, p.user?.bot) ? Effect.void : listener.reactionRemoved(p.messageId, p.userId, p.emoji),
  );
  yield* listen(Events.MessageReactionRemoveAll, failed, (p) => listener.reactionsCleared(p.messageId));
  yield* listen(Events.MessageReactionRemoveEmoji, failed, (p) =>
    listener.reactionsCleared(p.messageId, p.emoji),
  );
});
