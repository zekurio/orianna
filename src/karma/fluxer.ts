import { Events } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { Fluxer, listen, orNotFound, request } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { type Karma, KarmaGuild, type KarmaMember } from "./karma.ts";

/** Karma through fluxer.js. */
export const FluxerKarmaGuild = Layer.effect(
  KarmaGuild,
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const { id: guildId } = yield* CurrentGuild;
    const guild = request("fetching the guild", () => client.guilds.resolve(guildId));
    return {
      author: (channelId, messageId) =>
        request("fetching a message", () => client.channels.fetchMessage(channelId, messageId)).pipe(
          Effect.map((m) => ({ id: m.author.id, bot: m.author.bot })),
          orNotFound(() => null),
        ),

      name: guild.pipe(Effect.map((g) => g.name)),

      dm: (userId, body) =>
        request("fetching a user", () => client.users.fetch(userId)).pipe(
          Effect.flatMap((user) => request("sending a DM", () => user.send(sendOptions(body, NO_MENTIONS)))),
          Effect.asVoid,
        ),

      kick: (userId, reason) =>
        guild.pipe(Effect.flatMap((g) => request("kicking a member", () => g.kick(userId, reason)))),

      ban: (userId, reason) =>
        guild.pipe(Effect.flatMap((g) => request("banning a member", () => g.ban(userId, { reason })))),

      members: (userIds) =>
        Effect.gen(function* () {
          const g = yield* guild;
          const found = new Map<string, KarmaMember>();
          yield* Effect.forEach(
            userIds,
            (id) =>
              request("fetching a member", () => g.members.fetch(id)).pipe(
                Effect.map((member) => {
                  found.set(id, { name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64 }) });
                }),
                orNotFound(() => undefined),
              ),
            { concurrency: 4, discard: true },
          );
          return found;
        }),
    };
  }),
);

/** Feeds members' reactions in the guild to karma, until the scope closes. Bots don't vote. */
export const attachKarmaEvents = Effect.fnUntraced(function* (karma: Karma["Service"]) {
  const { client } = yield* Fluxer;
  const { id: guildId } = yield* CurrentGuild;
  const isBot = (userId: string, bot: boolean | undefined) => bot === true || userId === client.user?.id;
  const failed = "karma vote handling";
  yield* listen(Events.MessageReactionAdd, failed, (p) =>
    p.reaction.guildId !== guildId || isBot(p.userId, p.user?.bot)
      ? Effect.void
      : karma.reacted(p.channelId, p.messageId, p.userId, p.emoji),
  );
  yield* listen(Events.MessageReactionAddMany, failed, (p) =>
    p.guildId !== guildId
      ? Effect.void
      : Effect.forEach(
          p.reactions.filter((r) => !isBot(r.userId, r.member?.user.bot)),
          (r) => karma.reacted(p.channelId, p.messageId, r.userId, r.emoji),
          { discard: true },
        ),
  );
});
