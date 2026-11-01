import { Events, type Message, PermissionFlags, Routes } from "@fluxerjs/core";
import { Effect, Layer } from "effect";
import { Fluxer, listen, orNotFound, reactionUsers, request } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { editOptions, NO_MENTIONS, sendOptions } from "../messages/fluxer.ts";
import { attachReactions } from "../reactions.ts";
import { type MenuReaction, RoleGuild, type RoleMenus } from "./menus.ts";

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

/** Role menus through fluxer.js. */
export const FluxerRoleGuild = Layer.effect(
  RoleGuild,
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const { id: guildId } = yield* CurrentGuild;
    /** Menu messages, kept so reacting doesn't fetch the message every time. */
    const messages = new Map<string, Message>();
    const guild = request("fetching the guild", () => client.guilds.resolve(guildId));

    const fetchMessage = (channelId: string, messageId: string) =>
      request("fetching a menu message", () => client.channels.fetchMessage(channelId, messageId)).pipe(
        Effect.tap((message) => Effect.sync(() => messages.set(messageId, message))),
      );
    const message = (channelId: string, messageId: string) =>
      Effect.suspend(() => {
        const cached = messages.get(messageId);
        return cached ? Effect.succeed(cached) : fetchMessage(channelId, messageId);
      });
    const auditLog = (reason: string) => ({ headers: { "X-Audit-Log-Reason": reason } });

    return {
      vetRoles: (roleIds) =>
        Effect.gen(function* () {
          const g = yield* guild;
          const roles = new Map((yield* request("fetching roles", () => g.fetchRoles())).map((r) => [r.id, r]));
          const me = yield* request("fetching the bot member", () => g.members.fetchMe());
          const owner = g.ownerId === me.id;
          const top = Math.max(0, ...me.roles.roleIds.map((id) => roles.get(id)?.position ?? 0));

          const problems = new Map<string, string>();
          for (const id of roleIds) {
            const role = roles.get(id);
            const problem = !role
              ? "there is no such role"
              : id === g.id
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
        }),

      memberRoles: (userId) =>
        guild.pipe(
          Effect.flatMap((g) => request("fetching a member", () => g.members.fetch(userId))),
          Effect.map((member): readonly string[] | null => member.roles.roleIds),
          orNotFound(() => null),
        ),

      addRole: (userId, roleId, reason) =>
        request("giving a role", () =>
          client.rest.put(Routes.guildMemberRole(guildId, userId, roleId), auditLog(reason)),
        ).pipe(Effect.asVoid),

      removeRole: (userId, roleId, reason) =>
        request("taking a role", () =>
          client.rest.delete(Routes.guildMemberRole(guildId, userId, roleId), auditLog(reason)),
        ).pipe(Effect.asVoid),

      post: (channelId, body) =>
        request("posting a menu", () => client.channels.send(channelId, sendOptions(body, NO_MENTIONS))).pipe(
          Effect.map((message) => {
            messages.set(message.id, message);
            return message.id;
          }),
        ),

      edit: (channelId, messageId, body) =>
        message(channelId, messageId).pipe(
          Effect.flatMap((m) => request("editing a menu", () => m.edit(editOptions(body, NO_MENTIONS)))),
          Effect.asVoid,
        ),

      delete: (channelId, messageId) =>
        Effect.sync(() => messages.delete(messageId)).pipe(
          Effect.andThen(
            request("deleting a menu", () => client.rest.delete(Routes.channelMessage(channelId, messageId))),
          ),
          Effect.asVoid,
          orNotFound(() => undefined),
        ),

      reactions: (channelId, messageId) =>
        fetchMessage(channelId, messageId).pipe(
          Effect.map((m): MenuReaction[] | null => [...m.reactions].map((r) => ({ emoji: r.emoji, me: r.me }))),
          orNotFound(() => null),
        ),

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
    };
  }),
);

/** Feeds reactions, deleted messages and departing members into the role menus, until the scope closes. */
export const attachRoleMenuEvents = Effect.fnUntraced(function* (menus: RoleMenus) {
  const { id: guildId } = yield* CurrentGuild;
  yield* attachReactions(menus, "role menu", guildId);
  yield* listen(Events.MessageDelete, "role menu message delete", (message) =>
    message.guildId === guildId ? menus.messageDeleted(message.id) : Effect.void,
  );
  yield* listen(Events.MessageDeleteBulk, "role menu message delete", (p) =>
    p.guildId === guildId ? Effect.forEach(p.ids, (id) => menus.messageDeleted(id), { discard: true }) : Effect.void,
  );
  yield* listen(Events.GuildMemberRemove, "role menu member leave", (member) =>
    member.guild.id === guildId ? menus.memberLeft(member.id) : Effect.void,
  );
});
