import { Events, type Message, Routes } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { reactionKey } from "../emoji.ts";
import { Fluxer, listen, orNotFound, reactionUsers, request } from "../fluxer.ts";
import { editOptions, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { type BoardMessage, BoardGuild, type Boards } from "./boards.ts";

/** Boards through fluxer.js. */
export const FluxerBoardGuild = Layer.effect(
  BoardGuild,
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    /**
     * The message fetched last. Boards work one message at a time, so counting
     * its reactions right after doesn't fetch it again.
     */
    let last: Message | undefined;

    const fetchMessage = (channelId: string, messageId: string) =>
      request("fetching a message", () => client.channels.fetchMessage(channelId, messageId)).pipe(
        Effect.tap((message) => Effect.sync(() => (last = message))),
      );

    return {
      message: (channelId, messageId) =>
        fetchMessage(channelId, messageId).pipe(
          Effect.map((m): BoardMessage | null => boardMessage(m)),
          orNotFound(() => null),
        ),

      reactionUsers: (channelId, messageId, emoji) =>
        Effect.suspend(() =>
          last?.id === messageId ? Effect.succeed(last) : fetchMessage(channelId, messageId),
        ).pipe(Effect.flatMap((m) => reactionUsers(m, emoji))),

      nsfw: (channelId) =>
        request("fetching a channel", () => client.channels.resolve(channelId)).pipe(
          Effect.map((channel) => "nsfw" in channel && channel.nsfw === true),
        ),

      post: (channelId, body) =>
        request("posting to a board", () => client.channels.send(channelId, sendOptions(body, NO_MENTIONS))).pipe(
          Effect.map((m) => m.id),
        ),

      edit: (channelId, messageId, body) =>
        request("fetching a board post", () => client.channels.fetchMessage(channelId, messageId)).pipe(
          Effect.flatMap((m) => request("editing a board post", () => m.edit(editOptions(body, NO_MENTIONS)))),
          Effect.as(true),
          orNotFound(() => false),
        ),

      delete: (channelId, messageId) =>
        request("deleting a board post", () => client.rest.delete(Routes.channelMessage(channelId, messageId))).pipe(
          Effect.asVoid,
          orNotFound(() => undefined),
        ),

      /** The same link the Fluxer app copies for a message. */
      messageLink: (channelId, messageId) => {
        const webapp = client.instance.endpoints.webapp.replace(/\/+$/, "");
        return `${webapp}/channels/${guildId}/${channelId}/${messageId}`;
      },
    };
  }),
);

function boardMessage(m: Message): BoardMessage {
  const reactionCounts = new Map<string, number>();
  for (const reaction of m.reactions) {
    const key = reactionKey(reaction.emoji);
    if (key) reactionCounts.set(key, reaction.count);
  }
  return {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId,
    authorId: m.author.id,
    authorName: m.author.globalName ?? m.author.username,
    authorAvatar: m.author.displayAvatarURL({ size: 64 }),
    content: m.content,
    createdAt: m.createdAt,
    attachments: [...m.attachments.values()].flatMap((a) => {
      const url = a.url ?? a.proxyUrl;
      if (!url) return [];
      return [{ name: a.filename, url, image: a.contentType?.startsWith("image/") ?? false, nsfw: a.nsfw }];
    }),
    embedImages: m.embeds.flatMap((e) => e.image?.url ?? e.thumbnail?.url ?? []),
    reactionCounts,
  };
}

/** Feeds reactions, edits and deletes into the boards, until the scope closes. */
export const attachBoardEvents = Effect.fnUntraced(function* (boards: Boards) {
  const failed = "board event handling";
  // Every update counts again, so who reacted doesn't matter, bots included.
  yield* listen(Events.MessageReactionAdd, failed, (p) => boards.reacted(p.channelId, p.messageId, p.emoji));
  yield* listen(Events.MessageReactionAddMany, failed, (p) => {
    const emoji = new Map(p.reactions.map((r) => [reactionKey(r.emoji), r.emoji]));
    return Effect.forEach(emoji.values(), (e) => boards.reacted(p.channelId, p.messageId, e), { discard: true });
  });
  yield* listen(Events.MessageReactionRemove, failed, (p) => boards.reacted(p.channelId, p.messageId, p.emoji));
  yield* listen(Events.MessageReactionRemoveAll, failed, (p) => boards.reacted(p.channelId, p.messageId));
  yield* listen(Events.MessageReactionRemoveEmoji, failed, (p) =>
    boards.reacted(p.channelId, p.messageId, p.emoji),
  );
  yield* listen(Events.MessageUpdate, failed, (_old, message) => boards.messageEdited(message.channelId, message.id));
  yield* listen(Events.MessageDelete, failed, (message) => boards.messageDeleted(message.id));
  yield* listen(Events.MessageDeleteBulk, failed, (p) =>
    Effect.forEach(p.ids, (id) => boards.messageDeleted(id), { discard: true }),
  );
});
