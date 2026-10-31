import { Events } from "@fluxerjs/core";
import { Context, Effect, Layer } from "effect";
import { Fluxer, listen, reactionUsers, request } from "../fluxer.ts";
import { editOptions, EVERYONE_MENTIONS, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { CommunityPollChat, type CommunityPolls } from "./community.ts";
import { PollTransport } from "./transport.ts";

/** Polls through fluxer.js; provides both PollTransport and CommunityPollChat. */
export const FluxerPollTransport = Layer.effectContext(
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    const message = (channelId: string, messageId: string) =>
      request("fetching a poll message", () => client.channels.fetchMessage(channelId, messageId));

    const transport: PollTransport["Service"] & CommunityPollChat["Service"] = {
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

      reply: (channelId, messageId, content, notify) =>
        request("replying to a poll", () =>
          client.channels.send(channelId, {
            content,
            replyTo: { channelId, messageId, guildId },
            allowedMentions: { parse: [], users: [...notify] },
          }),
        ).pipe(Effect.asVoid),

      react: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("adding a reaction", () => m.react(emoji))),
        ),

      removeReaction: (channelId, messageId, emoji, userId) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("removing a reaction", () => m.removeReaction(emoji, userId))),
        ),

      clearReaction: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("clearing a reaction", () => m.removeReactionEmoji(emoji))),
        ),

      reactionUsers: (channelId, messageId, emoji) =>
        message(channelId, messageId).pipe(Effect.flatMap((m) => reactionUsers(m, emoji))),

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
    return Context.make(PollTransport, transport).pipe(Context.add(CommunityPollChat, transport));
  }),
);

/** Calls off community polls whose message is deleted, until the scope closes. */
export const attachPollMessageDeletes = Effect.fnUntraced(function* (community: CommunityPolls) {
  const failed = "poll message delete handling";
  yield* listen(Events.MessageDelete, failed, (message) => community.messageDeleted(message.id));
  yield* listen(Events.MessageDeleteBulk, failed, (p) =>
    Effect.forEach(p.ids, (id) => community.messageDeleted(id), { discard: true }),
  );
});
