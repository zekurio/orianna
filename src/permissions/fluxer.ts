import { GuildChannel, type GuildMember, OverwriteType, PermissionFlags } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { UserError } from "../commands/command.ts";
import { Fluxer, orNotFound, request } from "../fluxer.ts";
import { Settings } from "../settings/settings.ts";
import { GuildAccess, MemberPermissions, ruleSets } from "./rules.ts";

/** Looks members up in the guild. Rules are read on every check, so changed ones apply at once. */
export const FluxerGuildAccess = Layer.effect(
  GuildAccess,
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    const settings = yield* Settings;
    const guild = request("fetching the guild", () => client.guilds.resolve(guildId));

    const permissionsOf = Effect.fn("GuildAccess.permissionsOf")(function* (userId: string) {
      const g = yield* guild;
      if (g.ownerId === userId) return new MemberPermissions("owner", []);

      const member = yield* request("fetching a member", () => g.members.fetch(userId)).pipe(
        Effect.catchIf(
          (err) => err.notFound,
          () => Effect.fail(new UserError({ message: `<@${userId}> isn't a member of this server.` })),
        ),
      );
      if (member.permissions.has("Administrator")) return new MemberPermissions("administrator", []);

      const position = (id: string) => g.roles.get(id)?.position ?? 0;
      const roleIds = member.roles.roleIds
        .filter((id) => id !== g.id)
        .sort((a, b) => position(a) - position(b));
      const { permissions } = yield* settings.get;
      return new MemberPermissions(
        null,
        ruleSets(permissions, {
          roleIds,
          manageExpressions: member.permissions.has("ManageExpressions"),
        }),
      );
    });

    return {
      permissionsOf,
      canView: (userId, channelId) =>
        Effect.gen(function* () {
          const g = yield* guild;
          const channel = yield* request("fetching a channel", () => client.channels.resolve(channelId));
          if (!(channel instanceof GuildChannel) || channel.guildId !== g.id) return false;
          const member = yield* request("fetching a member", () => g.members.fetch(userId));
          return canView(member, channel);
        }).pipe(orNotFound(() => false)),
      can: (userId, permission) =>
        permissionsOf(userId).pipe(Effect.map((permissions) => permissions.has(permission))),
      unknownRoles: Effect.gen(function* () {
        const g = yield* guild;
        const roles = new Set((yield* request("fetching roles", () => g.fetchRoles())).map((r) => r.id));
        const { permissions } = yield* settings.get;
        return Object.keys(permissions.roles).filter((id) => !roles.has(id));
      }),
    };
  }),
);

/**
 * Whether a member can see a channel. `member.permissionsIn` from fluxer.js
 * skips the @everyone overwrite (it only applies overwrites for roles the member
 * holds, and @everyone is never in that list), so a channel hidden from
 * @everyone looks visible to members without roles. This applies overwrites in
 * the usual order: @everyone, then the member's roles combined, then the member.
 */
export function canView(member: GuildMember, channel: GuildChannel): boolean {
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
