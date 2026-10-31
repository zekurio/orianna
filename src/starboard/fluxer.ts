import { Events, type GuildChannel, type Message, Routes } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import { reactionKey } from "../emoji.ts";
import { downloadImage, SOURCE_MAX_BYTES } from "../expressions/image.ts";
import { Fluxer, listen, orNotFound, request } from "../fluxer.ts";
import { editOptions, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import {
  type Starboard,
  type StarboardAttachment,
  type StarboardChannel,
  StarboardGuild,
  type StarboardMessage,
} from "./starboard.ts";

/** The starboard through fluxer.js. */
export const FluxerStarboardGuild = Layer.effect(
  StarboardGuild,
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    const http = yield* Effect.context<HttpClient.HttpClient | Dns.Dns>();
    return {
      message: (channelId, messageId) =>
        request("fetching a message", () => client.channels.fetchMessage(channelId, messageId)).pipe(
          Effect.map((m): StarboardMessage | null => starboardMessage(m)),
          orNotFound(() => null),
        ),

      nsfw: (channelId) =>
        request("fetching a channel", () => client.channels.resolve(channelId)).pipe(
          Effect.map((channel) => "nsfw" in channel && channel.nsfw === true),
        ),

      channel: (channelId) =>
        request("fetching a channel", () => client.channels.resolve(channelId)).pipe(
          Effect.map((c): StarboardChannel | null =>
            c.isGuild() && c.guildId === guildId
              ? { id: c.id, name: c.name ?? c.id, nsfw: "nsfw" in c && c.nsfw === true, text: c.isTextBased() }
              : null,
          ),
          // A channel the bot can't see, or an ID that isn't one, is as good as missing.
          Effect.catchIf((err) => err.notFound || err.refused, () => Effect.succeed(null)),
        ),

      // Attachments come from the media host, which may be on a private network.
      downloadImage: (url) =>
        downloadImage(url, SOURCE_MAX_BYTES, [client.instance.endpoints.media]).pipe(Effect.provideContext(http)),

      textChannels: Effect.gen(function* () {
        const g = yield* request("fetching the guild", () => client.guilds.resolve(guildId));
        const channels = yield* request("listing channels", () => g.fetchChannels());
        const position = (c: GuildChannel) => c.position ?? 0;
        const categories = new Map(channels.map((c) => [c.id, position(c)]));
        // Categories first, then channels within them, the way the client lists them.
        const order = (c: GuildChannel) => [c.parentId ? (categories.get(c.parentId) ?? 0) : -1, position(c)] as const;
        return channels
          .filter((c) => c.isTextBased() && !c.isThread())
          .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
          .map((c): StarboardChannel => ({ id: c.id, name: c.name ?? c.id, nsfw: "nsfw" in c && c.nsfw === true, text: true }));
      }),

      emojis: request("listing emojis", () =>
        client.rest.get<{ id: string; name: string; animated?: boolean }[]>(Routes.guildEmojis(guildId)),
      ).pipe(Effect.map((list) => list.map(({ id, name, animated }) => ({ id, name, animated: animated === true })))),

      post: (channelId, body) =>
        request("posting to the starboard", () => client.channels.send(channelId, sendOptions(body, NO_MENTIONS))).pipe(
          Effect.map((m) => ({
            id: m.id,
            files: new Map(
              [...m.attachments.values()].flatMap((a) => {
                const url = a.url ?? a.proxyUrl;
                return url ? [[a.filename, url] as const] : [];
              }),
            ),
          })),
        ),

      edit: (channelId, messageId, body) =>
        request("fetching a starboard post", () => client.channels.fetchMessage(channelId, messageId)).pipe(
          Effect.flatMap((m) => request("editing a starboard post", () => m.edit(editOptions(body, NO_MENTIONS)))),
          Effect.as(true),
          orNotFound(() => false),
        ),

      delete: (channelId, messageId) =>
        request("deleting a starboard post", () => client.rest.delete(Routes.channelMessage(channelId, messageId))).pipe(
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

function starboardMessage(m: Message): StarboardMessage {
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
      return [{ name: a.filename, url, kind: kindOf(a.contentType), nsfw: a.nsfw }];
    }),
    embedImages: m.embeds.flatMap((e) => e.image?.url ?? e.thumbnail?.url ?? []),
    reactionCounts,
  };
}

function kindOf(contentType: string | null | undefined): StarboardAttachment["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  return "file";
}

/** Feeds reactions, edits and deletes into the starboard, until the scope closes. */
export const attachStarboardEvents = Effect.fnUntraced(function* (starboard: Starboard) {
  const failed = "starboard event handling";
  // Every update counts again, so who reacted doesn't matter, bots included.
  yield* listen(Events.MessageReactionAdd, failed, (p) => starboard.reacted(p.channelId, p.messageId, p.emoji));
  yield* listen(Events.MessageReactionAddMany, failed, (p) => {
    const emoji = new Map(p.reactions.map((r) => [reactionKey(r.emoji), r.emoji]));
    return Effect.forEach(emoji.values(), (e) => starboard.reacted(p.channelId, p.messageId, e), { discard: true });
  });
  yield* listen(Events.MessageReactionRemove, failed, (p) => starboard.reacted(p.channelId, p.messageId, p.emoji));
  yield* listen(Events.MessageReactionRemoveAll, failed, (p) => starboard.reacted(p.channelId, p.messageId));
  yield* listen(Events.MessageReactionRemoveEmoji, failed, (p) =>
    starboard.reacted(p.channelId, p.messageId, p.emoji),
  );
  yield* listen(Events.MessageUpdate, failed, (_old, message) =>
    starboard.messageEdited(message.channelId, message.id),
  );
  yield* listen(Events.MessageDelete, failed, (message) => starboard.messageDeleted(message.id));
  yield* listen(Events.MessageDeleteBulk, failed, (p) =>
    Effect.forEach(p.ids, (id) => starboard.messageDeleted(id), { discard: true }),
  );
});
