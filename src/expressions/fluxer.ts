import { GuildChannel, type GuildMember, OverwriteType, PermissionFlags, Routes } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { Fluxer, type FluxerError, orNotFound, request } from "../fluxer.ts";
import { ExpressionGuild, ExpressionRejected } from "./proposals.ts";

/** Expressions through fluxer.js. */
export const FluxerExpressionGuild = Layer.effect(
  ExpressionGuild,
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    const guild = request("fetching the guild", () => client.guilds.resolve(guildId));

    return {
      list: (type) =>
        Effect.gen(function* () {
          // fetchEmojis() and fetchStickers() drop `user`, who added each one.
          const route = type === "emoji" ? Routes.guildEmojis(guildId) : Routes.guildStickers(guildId);
          const items = yield* request(`listing ${type}s`, () =>
            client.rest.get<{ id: string; name: string; user?: { id: string } }[]>(route),
          );
          const botId = client.user?.id;
          return items.map((e) => ({ id: e.id, name: e.name, mine: !!botId && e.user?.id === botId }));
        }),

      voters: (channelId) =>
        Effect.gen(function* () {
          const g = yield* guild;
          const channel = yield* request("fetching the polls channel", () => client.channels.resolve(channelId));
          if (!(channel instanceof GuildChannel)) {
            return yield* Effect.die(new Error(`channel ${channelId} is not a guild channel`));
          }

          const members: GuildMember[] = [];
          let after: string | undefined;
          for (;;) {
            const page = yield* request("listing members", () => g.members.fetch({ limit: 1000, after }));
            members.push(...page);
            if (page.length < 1000) break;
            after = page.at(-1)!.id;
          }
          return members.filter((m) => !m.user.bot && canView(m, channel)).map((m) => m.id);
        }),

      create: (type, { name, image, description, tags, reason }) =>
        Effect.gen(function* () {
          const g = yield* guild;
          if (type === "emoji") {
            const emoji = yield* request("adding an emoji", () => g.createEmoji({ name, image, reason }));
            return { id: emoji.id, mention: emoji.toString() };
          }
          const sticker = yield* request("adding a sticker", () =>
            g.createSticker({ name, image, description, tags, reason }),
          );
          return { id: sticker.id };
        }).pipe(Effect.catchIf((err) => err.refused, rejected)),

      remove: (type, id, reason) =>
        Effect.gen(function* () {
          const g = yield* guild;
          const expression = yield* request(`fetching the ${type}`, (): Promise<{
            delete(reason: string): Promise<void>;
          }> => (type === "emoji" ? g.fetchEmoji(id) : g.fetchSticker(id)));
          yield* request(`deleting the ${type}`, () => expression.delete(reason));
        }).pipe(
          orNotFound(() => undefined),
          Effect.catchIf((err) => err.refused, rejected),
        ),

      send: (channelId, content, notify, replyTo) =>
        request("sending a message", () =>
          client.channels.send(channelId, {
            content,
            replyTo: replyTo ? { channelId, messageId: replyTo, guildId } : undefined,
            allowedMentions: { parse: [], users: [...notify] },
          }),
        ).pipe(Effect.asVoid),
    };
  }),
);

/**
 * fluxer.js HTTP errors carry `isRetryable` (429 and 5xx). Anything else from
 * the API is final, so trying again won't help.
 */
const rejected = (err: FluxerError) => Effect.fail(new ExpressionRejected({ message: err.reason }));

/**
 * Whether a member can see a channel. `member.permissionsIn` from fluxer.js
 * skips the @everyone overwrite (it only applies overwrites for roles the member
 * holds, and @everyone is never in that list), so a channel hidden from
 * @everyone looks visible to members without roles. This applies overwrites in
 * the usual order: @everyone, then the member's roles combined, then the member.
 */
function canView(member: GuildMember, channel: GuildChannel): boolean {
  const guild = member.guild;
  if (guild.ownerId === member.id) return true;

  const roleIds = member.roles.roleIds.filter((id) => id !== guild.id);
  let perms = guild.roles.get(guild.id)?.permissions.bitfield ?? 0n;
  for (const id of roleIds) perms |= guild.roles.get(id)?.permissions.bitfield ?? 0n;
  if (perms & PermissionFlags.Administrator) return true;

  const overwrites = channel.permissionOverwrites.toJSON();
  const apply = (allow: bigint, deny: bigint) => {
    perms = (perms & ~deny) | allow;
  };

  const everyone = overwrites.find((o) => o.type === OverwriteType.Role && o.id === guild.id);
  if (everyone) apply(BigInt(everyone.allow || "0"), BigInt(everyone.deny || "0"));

  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type !== OverwriteType.Role || !roleIds.includes(o.id)) continue;
    allow |= BigInt(o.allow || "0");
    deny |= BigInt(o.deny || "0");
  }
  apply(allow, deny);

  const own = overwrites.find((o) => o.type === OverwriteType.Member && o.id === member.id);
  if (own) apply(BigInt(own.allow || "0"), BigInt(own.deny || "0"));

  return (perms & PermissionFlags.ViewChannel) !== 0n;
}
