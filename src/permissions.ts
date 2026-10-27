import type { Client } from "@fluxerjs/core";
import type { Guard } from "./commands/command.ts";

/** Role and permission lookups for members of the bot's guild. */
export interface GuildAccess {
  /** Guild owner, Manage Expressions, or one of the configured admin roles. */
  isAdmin(userId: string): Promise<boolean>;
  /** Guild owner or Manage Expressions, which Administrator includes. */
  canManageExpressions(userId: string): Promise<boolean>;
  hasAnyRole(userId: string, roleIds: readonly string[]): Promise<boolean>;
}

export class FluxerGuildAccess implements GuildAccess {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly adminRoleIds: readonly string[],
  ) {}

  async isAdmin(userId: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    if (guild.ownerId === userId) return true;

    const member = await guild.members.fetch(userId);
    return (
      this.adminRoleIds.some((id) => member.roles.has(id)) ||
      member.permissions.has("ManageExpressions")
    );
  }

  async canManageExpressions(userId: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    if (guild.ownerId === userId) return true;

    const member = await guild.members.fetch(userId);
    return member.permissions.has("ManageExpressions");
  }

  async hasAnyRole(userId: string, roleIds: readonly string[]) {
    const guild = await this.client.guilds.resolve(this.guildId);
    const member = await guild.members.fetch(userId);
    return roleIds.some((id) => member.roles.has(id));
  }
}

export const adminOnly: Guard = async (ctx) =>
  (await ctx.bot.access.isAdmin(ctx.userId))
    ? undefined
    : "Only admins can do that.";

export const expressionManagersOnly: Guard = async (ctx) =>
  (await ctx.bot.access.canManageExpressions(ctx.userId))
    ? undefined
    : "Adding without a vote takes the Manage Expressions permission.";
