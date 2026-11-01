import { type Client, Events } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { Fluxer, listen, reactionUsers, request } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { editOptions, EVERYONE_MENTIONS, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { CommunityPollChat, type CommunityPolls } from "./community.ts";
import { PollTransport } from "./transport.ts";

const pollMessage = (client: Client, channelId: string, messageId: string) =>
  request("fetching a poll message", () => client.channels.fetchMessage(channelId, messageId));

/** Polls through fluxer.js, for every guild. */
export const FluxerPollTransport = Layer.effect(
  PollTransport,
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const message = (channelId: string, messageId: string) => pollMessage(client, channelId, messageId);
    return {
      post: (channelId, body, options = {}) =>
        request("posting a poll", () =>
          client.channels.send(channelId, {
            ...sendOptions(body, options.everyone ? EVERYONE_MENTIONS : NO_MENTIONS),
            files: options.files?.map((f) => ({ name: f.name, data: f.data })),
          }),
        ).pipe(Effect.map((m) => m.id)),

      edit: (channelId, messageId, body) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("editing a poll", () => m.edit(editOptions(body, NO_MENTIONS)))),
          Effect.asVoid,
        ),

      react: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("adding a reaction", () => m.react(emoji))),
        ),

      removeReaction: (channelId, messageId, emoji, userId) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("removing a reaction", () => m.removeReaction(emoji, userId))),
        ),

      reactionUsers: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(Effect.flatMap((m) => reactionUsers(m, emoji))),
    };
  }),
);

/** Community polls of the current guild through fluxer.js, on top of the poll transport. */
export const FluxerCommunityPollChat = Layer.effect(
  CommunityPollChat,
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const { id: guildId } = yield* CurrentGuild;
    const transport = yield* PollTransport;
    const message = (channelId: string, messageId: string) => pollMessage(client, channelId, messageId);
    return {
      react: transport.react,
      removeReaction: transport.removeReaction,
      reactionUsers: transport.reactionUsers,

      reply: (channelId, messageId, content, notify) =>
        request("replying to a poll", () =>
          client.channels.send(channelId, {
            content,
            replyTo: { channelId, messageId, guildId },
            allowedMentions: { parse: [], users: [...notify] },
          }),
        ).pipe(Effect.asVoid),

      clearReaction: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("clearing a reaction", () => m.removeReactionEmoji(emoji))),
        ),

      emojiIds: Effect.gen(function* () {
        const guild = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
        const emojis = yield* request("listing emojis", () => guild.fetchEmojis());
        return emojis.map((e) => e.id);
      }),

      /** The same link the Fluxer app copies for a message. */
      messageLink: (channelId, messageId) => {
        const webapp = client.instance.endpoints.webapp.replace(/\/+$/, "");
        return `${webapp}/channels/${guildId}/${channelId}/${messageId}`;
      },
    };
  }),
);

/** Calls off community polls whose message is deleted, until the scope closes. */
export const attachPollMessageDeletes = Effect.fnUntraced(function* (community: CommunityPolls) {
  const { id: guildId } = yield* CurrentGuild;
  const failed = "poll message delete handling";
  yield* listen(Events.MessageDelete, failed, (message) =>
    message.guildId === guildId ? community.messageDeleted(message.id) : Effect.void,
  );
  yield* listen(Events.MessageDeleteBulk, failed, (p) =>
    p.guildId === guildId ? Effect.forEach(p.ids, (id) => community.messageDeleted(id), { discard: true }) : Effect.void,
  );
});
