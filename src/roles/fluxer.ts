import { type Client, Events, type Message, PermissionFlags, Routes } from "@fluxerjs/core";
import type { MessageBody } from "../messages/body.ts";
import { editOptions, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { attachReactions } from "../reactions.ts";
import type { MenuReaction, RoleGuild, RoleMenus } from "./menus.ts";

/**
 * A role with any of these isn't handed out by reaction, so a mistyped role ID
 * can't make someone a moderator.
 */
const ELEVATED =
  PermissionFlags.Administrator |
  PermissionFlags.ManageGuild |
  PermissionFlags.ManageRoles |
  PermissionFlags.ManageChannels |
  PermissionFlags.ManageMessages |
  PermissionFlags.ManageWebhooks |
  PermissionFlags.ManageExpressions |
  PermissionFlags.ManageNicknames |
  PermissionFlags.KickMembers |
  PermissionFlags.BanMembers |
  PermissionFlags.ModerateMembers |
  PermissionFlags.MuteMembers |
  PermissionFlags.DeafenMembers |
  PermissionFlags.MoveMembers |
  PermissionFlags.MentionEveryone |
  PermissionFlags.ViewAuditLog;

export class FluxerRoleGuild implements RoleGuild {
  /** Menu messages, kept so reacting doesn't fetch the message every time. */
  private readonly messages = new Map<string, Message>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  async vetRoles(roleIds: readonly string[]) {
    const guild = await this.client.guilds.resolve(this.guildId);
    const roles = new Map((await guild.fetchRoles()).map((r) => [r.id, r]));
    const me = await guild.members.fetchMe();
    const owner = guild.ownerId === me.id;
    const top = Math.max(0, ...me.roles.roleIds.map((id) => roles.get(id)?.position ?? 0));

    const problems = new Map<string, string>();
    for (const id of roleIds) {
      const role = roles.get(id);
      const problem = !role
        ? "there is no such role"
        : id === guild.id
          ? "that's the @everyone role"
          : !owner && !me.permissions.has("ManageRoles")
            ? "the bot doesn't have Manage Roles"
            : !owner && role.position >= top
              ? "the bot's highest role isn't above it"
              : (role.permissions.bitfield & ELEVATED) !== 0n
                ? "it has moderator permissions"
                : undefined;
      if (problem) problems.set(id, problem);
    }
    return problems;
  }

  async memberRoles(userId: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    try {
      return (await guild.members.fetch(userId)).roles.roleIds;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async addRole(userId: string, roleId: string, reason: string) {
    await this.client.rest.put(Routes.guildMemberRole(this.guildId, userId, roleId), {
      headers: { "X-Audit-Log-Reason": reason },
    });
  }

  async removeRole(userId: string, roleId: string, reason: string) {
    await this.client.rest.delete(Routes.guildMemberRole(this.guildId, userId, roleId), {
      headers: { "X-Audit-Log-Reason": reason },
    });
  }

  async post(channelId: string, body: MessageBody) {
    const message = await this.client.channels.send(channelId, sendOptions(body, NO_MENTIONS));
    this.messages.set(message.id, message);
    return message.id;
  }

  async edit(channelId: string, messageId: string, body: MessageBody) {
    const message = await this.message(channelId, messageId);
    await message.edit(editOptions(body, NO_MENTIONS));
  }

  async delete(channelId: string, messageId: string) {
    this.messages.delete(messageId);
    try {
      await this.client.rest.delete(Routes.channelMessage(channelId, messageId));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async reactions(channelId: string, messageId: string): Promise<MenuReaction[] | null> {
    let message: Message;
    try {
      message = await this.client.channels.fetchMessage(channelId, messageId);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    this.messages.set(messageId, message);
    return [...message.reactions].map((r) => ({ emoji: r.emoji, me: r.me }));
  }

  async react(channelId: string, messageId: string, emoji: string) {
    await (await this.message(channelId, messageId)).react(emoji);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, userId: string) {
    await (await this.message(channelId, messageId)).removeReaction(emoji, userId);
  }

  async clearReaction(channelId: string, messageId: string, emoji: string) {
    await (await this.message(channelId, messageId)).removeReactionEmoji(emoji);
  }

  async reactionUsers(channelId: string, messageId: string, emoji: string) {
    const message = await this.message(channelId, messageId);
    const userIds: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await message.fetchReactionUsersPage(emoji, { limit: 100, after });
      userIds.push(...page.users.filter((u) => !u.bot).map((u) => u.id));
      if (!page.hasMore || !page.nextAfter) return userIds;
      after = page.nextAfter;
    }
  }

  private async message(channelId: string, messageId: string) {
    const cached = this.messages.get(messageId);
    if (cached) return cached;
    const message = await this.client.channels.fetchMessage(channelId, messageId);
    this.messages.set(messageId, message);
    return message;
  }
}

/** Feeds reactions, deleted messages and departing members into the role menus. */
export function attachRoleMenuEvents(client: Client, menus: RoleMenus, guildId: string) {
  attachReactions(client, menus, "role menu");
  client.on(Events.MessageDelete, (message) => void menus.messageDeleted(message.id));
  client.on(Events.MessageDeleteBulk, (p) => {
    for (const id of p.ids) void menus.messageDeleted(id);
  });
  client.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id === guildId) void menus.memberLeft(member.id);
  });
}

/** fluxer.js reports a 404 as `*_NOT_FOUND`; raw REST calls carry the API's `UNKNOWN_*`. */
function isNotFound(err: unknown): boolean {
  const { code, statusCode } = (err ?? {}) as { code?: unknown; statusCode?: unknown };
  if (statusCode === 404) return true;
  return typeof code === "string" && (code.endsWith("_NOT_FOUND") || code.startsWith("UNKNOWN_"));
}
