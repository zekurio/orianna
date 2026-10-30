import {
  type Client,
  GuildChannel,
  type GuildMember,
  OverwriteType,
  PermissionFlags,
  Routes,
} from "@fluxerjs/core";
import {
  type ExpressionGuild,
  ExpressionRejected,
  type ExpressionType,
  type NewExpression,
} from "./proposals.ts";

export class FluxerExpressionGuild implements ExpressionGuild {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  async list(type: ExpressionType) {
    // fetchEmojis() and fetchStickers() drop `user`, who added each one.
    const route =
      type === "emoji" ? Routes.guildEmojis(this.guildId) : Routes.guildStickers(this.guildId);
    const items = await this.client.rest.get<{ id: string; name: string; user?: { id: string } }[]>(
      route,
    );
    const botId = this.client.user?.id;
    return items.map((e) => ({ id: e.id, name: e.name, mine: !!botId && e.user?.id === botId }));
  }

  async voters(channelId: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    const channel = await this.client.channels.resolve(channelId);
    if (!(channel instanceof GuildChannel)) {
      throw new Error(`channel ${channelId} is not a guild channel`);
    }

    const members: GuildMember[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await guild.members.fetch({ limit: 1000, after });
      members.push(...page);
      if (page.length < 1000) break;
      after = page.at(-1)!.id;
    }
    return members
      .filter((m) => !m.user.bot && canView(m, channel))
      .map((m) => m.id);
  }

  async create(type: ExpressionType, { name, image, description, tags, reason }: NewExpression) {
    const guild = await this.client.guilds.resolve(this.guildId);
    try {
      if (type === "emoji") {
        const emoji = await guild.createEmoji({ name, image, reason });
        return { id: emoji.id, mention: emoji.toString() };
      }
      const sticker = await guild.createSticker({ name, image, description, tags, reason });
      return { id: sticker.id };
    } catch (err) {
      throw refusedForGood(err) ? new ExpressionRejected((err as Error).message) : err;
    }
  }

  async remove(type: ExpressionType, id: string, reason: string) {
    const guild = await this.client.guilds.resolve(this.guildId);
    try {
      const expression = type === "emoji" ? await guild.fetchEmoji(id) : await guild.fetchSticker(id);
      await expression.delete(reason);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw refusedForGood(err) ? new ExpressionRejected((err as Error).message) : err;
    }
  }

  async send(channelId: string, content: string, notify: readonly string[], replyTo?: string) {
    await this.client.channels.send(channelId, {
      content,
      replyTo: replyTo ? { channelId, messageId: replyTo, guildId: this.guildId } : undefined,
      allowedMentions: { parse: [], users: [...notify] },
    });
  }
}

/**
 * fluxer.js HTTP errors carry `isRetryable` (429 and 5xx). Anything else from
 * the API is final; network errors have no flag and are retried.
 */
function refusedForGood(err: unknown): boolean {
  return (err as { isRetryable?: boolean }).isRetryable === false;
}

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
