import { Effect, Layer } from "effect";
import { UserError } from "../commands/command.ts";
import { AppConfig } from "../config.ts";
import { Fluxer, request } from "../fluxer.ts";
import { GuildAccess, MemberPermissions, ruleSets } from "./rules.ts";

/** Looks members up in the guild. Rules are read on every check, so reloaded ones apply at once. */
export const FluxerGuildAccess = Layer.effect(
  GuildAccess,
  Effect.gen(function* () {
    const { client, guildId } = yield* Fluxer;
    const config = yield* AppConfig;
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
      const { permissions } = yield* config.get;
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
      can: (userId, permission) =>
        permissionsOf(userId).pipe(Effect.map((permissions) => permissions.has(permission))),
      unknownRoles: Effect.gen(function* () {
        const g = yield* guild;
        const roles = new Set((yield* request("fetching roles", () => g.fetchRoles())).map((r) => r.id));
        const { permissions } = yield* config.get;
        return Object.keys(permissions.roles).filter((id) => !roles.has(id));
      }),
    };
  }),
);
