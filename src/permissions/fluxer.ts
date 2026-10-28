import type { Client } from "@fluxerjs/core";
import { UserError } from "../commands/command.ts";
import type { PermissionsConfig } from "../config.ts";
import { isNotFound } from "../roles/fluxer.ts";
import { type GuildAccess, MemberPermissions, type Permission, ruleSets } from "./rules.ts";

export class FluxerGuildAccess implements GuildAccess {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly config: PermissionsConfig,
  ) {}

  async permissionsOf(userId: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    if (guild.ownerId === userId) return new MemberPermissions("owner", []);

    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch (err) {
      if (isNotFound(err)) throw new UserError(`<@${userId}> isn't a member of this server.`);
      throw err;
    }
    if (member.permissions.has("Administrator")) return new MemberPermissions("administrator", []);

    const position = (id: string) => guild.roles.get(id)?.position ?? 0;
    const roleIds = member.roles.roleIds
      .filter((id) => id !== guild.id)
      .sort((a, b) => position(a) - position(b));
    return new MemberPermissions(
      null,
      ruleSets(this.config, {
        roleIds,
        manageExpressions: member.permissions.has("ManageExpressions"),
      }),
    );
  }

  async can(userId: string, permission: Permission) {
    return (await this.permissionsOf(userId)).has(permission);
  }

  /** Role IDs with rules in the config that the guild doesn't have. */
  async unknownRoles(): Promise<string[]> {
    const guild = await this.client.guilds.resolve(this.guildId);
    const roles = new Set((await guild.fetchRoles()).map((r) => r.id));
    return Object.keys(this.config.roles).filter((id) => !roles.has(id));
  }
}
