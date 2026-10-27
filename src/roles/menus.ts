import { and, eq, notInArray } from "drizzle-orm";
import type { RoleMenuConfig, RoleMenusConfig } from "../config.ts";
import type { DB } from "../db/index.ts";
import { roleMenuReactions, roleMenus } from "../db/schema.ts";
import {
  apiName,
  type ParsedEmoji,
  parseEmoji,
  type ReactionEmoji,
  reactionKey,
} from "../emoji.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import type { ReactionListener } from "../reactions.ts";

/** A reaction on a menu message. */
export interface MenuReaction {
  emoji: ReactionEmoji;
  /** Whether the bot is among those who reacted. */
  me: boolean;
}

/** What role menus need from the guild. */
export interface RoleGuild {
  /** Why members can't be given each role. Roles that are fine are left out. */
  vetRoles(roleIds: readonly string[]): Promise<Map<string, string>>;
  /** The member's role IDs, or null when they aren't in the guild. */
  memberRoles(userId: string): Promise<readonly string[] | null>;
  addRole(userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason: string): Promise<void>;
  /** Posts a message and returns its ID. */
  post(channelId: string, body: MessageBody): Promise<string>;
  edit(channelId: string, messageId: string, body: MessageBody): Promise<void>;
  /** Also succeeds when the message is already gone. */
  delete(channelId: string, messageId: string): Promise<void>;
  /** The message's reactions, or null when the message is gone. */
  reactions(channelId: string, messageId: string): Promise<MenuReaction[] | null>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string, userId: string): Promise<void>;
  /** Removes every reaction with `emoji`. */
  clearReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Every non-bot user who reacted with `emoji`. */
  reactionUsers(channelId: string, messageId: string, emoji: string): Promise<string[]>;
}

interface MenuOption {
  roleId: string;
  emoji: ParsedEmoji;
  description?: string;
}

interface Menu {
  name: string;
  title: string;
  description?: string;
  mode: "multi" | "single";
  channelId: string;
  /** The options the bot can hand out, in config order. */
  options: MenuOption[];
}

interface LiveMenu extends Menu {
  messageId: string;
  /**
   * Emoji of options left out because their role can't be given right now.
   * Their reactions and records stay, so nothing is lost once it's fixed.
   */
  paused: Set<string>;
}

const FOOTER = {
  multi: "React to get a role. Remove your reaction to drop it.",
  single: "React to pick one. Picking another replaces it.",
} as const;

/**
 * Messages where members react to give themselves roles. All work runs one
 * task at a time, so quick clicks and the startup catch-up can't race.
 */
export class RoleMenus implements ReactionListener {
  /** By message ID. */
  private readonly live = new Map<string, LiveMenu>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DB,
    private readonly guild: RoleGuild,
    private readonly config: RoleMenusConfig | undefined,
  ) {}

  /**
   * Makes the menu messages match the config, then catches up on reactions
   * added or removed while the bot was offline.
   */
  sync(): Promise<void> {
    return this.enqueue("sync", () => this.syncAll());
  }

  reactionAdded(messageId: string, userId: string, emoji: ReactionEmoji) {
    return this.enqueue("reaction", async () => {
      const menu = this.live.get(messageId);
      if (!menu) return;
      const option = findOption(menu, emoji);
      if (option) {
        await this.grant(menu, option, userId);
        return;
      }

      const key = reactionKey(emoji);
      const name = apiName(emoji);
      if (!key || !name || menu.paused.has(key)) return;
      // Keeps the row of reactions down to the menu's own emoji.
      await this.guild
        .removeReaction(menu.channelId, messageId, name, userId)
        .catch(warn(menu, `could not remove ${name}`));
    });
  }

  reactionRemoved(messageId: string, userId: string, emoji: ReactionEmoji) {
    return this.enqueue("reaction", async () => {
      const menu = this.live.get(messageId);
      const option = menu && findOption(menu, emoji);
      if (menu && option) await this.revoke(menu, userId, option.roleId);
    });
  }

  /**
   * A moderator removed all reactions, or all of one emoji. Members keep their
   * roles, and the bot puts its own reactions back.
   */
  reactionsCleared(messageId: string, emoji?: ReactionEmoji) {
    return this.enqueue("reaction clear", async () => {
      const menu = this.live.get(messageId);
      if (!menu) return;
      const option = emoji && findOption(menu, emoji);
      const cleared = emoji ? (option ? [option] : []) : menu.options;
      for (const option of cleared) {
        this.db
          .delete(roleMenuReactions)
          .where(
            and(eq(roleMenuReactions.menu, menu.name), eq(roleMenuReactions.roleId, option.roleId)),
          )
          .run();
        await this.guild
          .react(menu.channelId, messageId, option.emoji.api)
          .catch(warn(menu, `could not react with ${option.emoji.api}`));
      }
    });
  }

  /** Someone deleted a menu message. Members keep their roles. */
  messageDeleted(messageId: string) {
    return this.enqueue("message delete", async () => {
      const row = this.db.select().from(roleMenus).where(eq(roleMenus.messageId, messageId)).get();
      if (!row) return;
      this.live.delete(messageId);
      this.forget(row.name);
      console.info(`role menu ${row.name}: message was deleted; it's posted again on the next start`);
    });
  }

  /** Removes the member's reactions, so they find the menus clean if they come back. */
  memberLeft(userId: string) {
    return this.enqueue("member leave", async () => {
      const rows = this.db
        .delete(roleMenuReactions)
        .where(eq(roleMenuReactions.userId, userId))
        .returning()
        .all();
      for (const row of rows) {
        const menu = [...this.live.values()].find((m) => m.name === row.menu);
        const option = menu?.options.find((o) => o.roleId === row.roleId);
        if (!menu || !option) continue;
        await this.guild
          .removeReaction(menu.channelId, menu.messageId, option.emoji.api, userId)
          .catch(warn(menu, `could not remove a reaction of ${userId}`));
      }
    });
  }

  private async syncAll() {
    const menus = this.config?.menus ?? [];
    const names = new Set(menus.map((m) => m.name));
    this.live.clear();

    for (const row of this.db.select().from(roleMenus).all()) {
      if (names.has(row.name)) continue;
      try {
        await this.guild.delete(row.channelId, row.messageId);
      } catch (err) {
        console.warn(`role menu ${row.name}: could not delete its message, will retry:`, err);
        continue;
      }
      this.forget(row.name);
      console.info(`role menu ${row.name}: no longer in the config, deleted its message`);
    }
    if (menus.length === 0) return;

    const problems = await this.guild.vetRoles(menus.flatMap((m) => m.options.map((o) => o.roleId)));
    for (const menu of menus) {
      try {
        await this.syncMenu(menu, problems);
      } catch (err) {
        console.error(`role menu ${menu.name}: sync failed:`, err);
      }
    }
  }

  private async syncMenu(config: RoleMenuConfig, problems: Map<string, string>) {
    const options: MenuOption[] = [];
    const paused = new Set<string>();
    for (const option of config.options) {
      // The config check already rejected anything that doesn't parse.
      const emoji = parseEmoji(option.emoji)!;
      const problem = problems.get(option.roleId);
      if (problem) {
        console.warn(`role menu ${config.name}: leaving out role ${option.roleId}: ${problem}`);
        paused.add(emoji.key);
        continue;
      }
      options.push({ roleId: option.roleId, emoji, description: option.description });
    }
    if (options.length === 0) {
      console.warn(`role menu ${config.name}: none of its roles can be given out; leaving it as is`);
      return;
    }

    const menu: Menu = {
      name: config.name,
      title: config.title,
      description: config.description,
      mode: config.mode,
      channelId: config.channelId ?? this.config!.channelId,
      options,
    };
    const body = renderMenu(menu);
    const rendered = JSON.stringify(body);

    let row = this.db.select().from(roleMenus).where(eq(roleMenus.name, menu.name)).get();
    let reactions: MenuReaction[] | null = [];
    if (row && row.channelId !== menu.channelId) {
      await this.guild.delete(row.channelId, row.messageId);
      this.forget(row.name);
      row = undefined;
    }
    if (row) {
      reactions = await this.guild.reactions(row.channelId, row.messageId);
      if (!reactions) {
        console.info(`role menu ${menu.name}: message is gone, posting it again`);
        this.forget(row.name);
        row = undefined;
      }
    }
    if (!row) {
      const messageId = await this.guild.post(menu.channelId, body);
      row = this.db
        .insert(roleMenus)
        .values({ name: menu.name, channelId: menu.channelId, messageId, rendered })
        .returning()
        .get();
      reactions = [];
    } else if (row.rendered !== rendered) {
      await this.guild.edit(row.channelId, row.messageId, body);
      this.db.update(roleMenus).set({ rendered }).where(eq(roleMenus.name, menu.name)).run();
    }

    const live: LiveMenu = { ...menu, messageId: row.messageId, paused };
    this.live.set(live.messageId, live);

    // Roles taken out of the menu stay with whoever has them; only the records go.
    this.db
      .delete(roleMenuReactions)
      .where(
        and(
          eq(roleMenuReactions.menu, menu.name),
          notInArray(
            roleMenuReactions.roleId,
            config.options.map((o) => o.roleId),
          ),
        ),
      )
      .run();

    await this.syncReactions(live, reactions ?? []);
    await this.catchUp(live);
  }

  /** Adds the bot's reaction for each option and clears emoji that aren't options. */
  private async syncReactions(menu: LiveMenu, reactions: MenuReaction[]) {
    const { channelId, messageId } = menu;
    const mine = new Set<string>();
    for (const reaction of reactions) {
      const key = reactionKey(reaction.emoji);
      if (!key) continue;
      if (menu.paused.has(key) || menu.options.some((o) => o.emoji.key === key)) {
        if (reaction.me) mine.add(key);
        continue;
      }
      const name = apiName(reaction.emoji);
      if (name) {
        await this.guild
          .clearReaction(channelId, messageId, name)
          .catch(warn(menu, `could not clear ${name}`));
      }
    }
    for (const option of menu.options) {
      if (mine.has(option.emoji.key)) continue;
      await this.guild
        .react(channelId, messageId, option.emoji.api)
        .catch(warn(menu, `could not react with ${option.emoji.api}`));
    }
  }

  /** Applies reactions added or removed while the bot was offline. */
  private async catchUp(menu: LiveMenu) {
    const { channelId, messageId } = menu;
    const reacted = new Map<string, MenuOption[]>();
    for (const option of menu.options) {
      for (const userId of await this.guild.reactionUsers(channelId, messageId, option.emoji.api)) {
        reacted.set(userId, [...(reacted.get(userId) ?? []), option]);
      }
    }

    const records = this.records(menu.name);
    const recorded = (userId: string, roleId: string) =>
      records.some((r) => r.userId === userId && r.roleId === roleId);

    for (const record of records) {
      // Paused options weren't read, so their reactions look removed.
      if (!menu.options.some((o) => o.roleId === record.roleId)) continue;
      if (reacted.get(record.userId)?.some((o) => o.roleId === record.roleId)) continue;
      await this.revoke(menu, record.userId, record.roleId);
    }

    for (const [userId, picked] of reacted) {
      let missing = picked.filter((o) => !recorded(userId, o.roleId));
      if (menu.mode === "single" && picked.length > 1) {
        // Several picks in a single-choice menu: keep the one already given.
        const keep = picked.find((o) => recorded(userId, o.roleId)) ?? picked[0]!;
        for (const option of picked) {
          if (option === keep) continue;
          await this.revoke(menu, userId, option.roleId);
          await this.guild
            .removeReaction(channelId, messageId, option.emoji.api, userId)
            .catch(warn(menu, `could not remove a reaction of ${userId}`));
        }
        missing = missing.includes(keep) ? [keep] : [];
      }
      for (const option of missing) await this.grant(menu, option, userId);
    }
  }

  /**
   * Gives the role for a reaction, or takes the reaction back when that fails
   * so the menu never shows a role the member doesn't have. In single-choice
   * menus this also takes away the member's other roles from the menu.
   */
  private async grant(menu: LiveMenu, option: MenuOption, userId: string) {
    const { channelId, messageId } = menu;
    const dropReaction = () =>
      this.guild
        .removeReaction(channelId, messageId, option.emoji.api, userId)
        .catch(warn(menu, `could not remove a reaction of ${userId}`));

    const roles = await this.guild.memberRoles(userId);
    if (!roles) {
      await dropReaction();
      return;
    }
    try {
      // Always sent: the cached roles can lag behind a removal a moment ago.
      await this.guild.addRole(userId, option.roleId, reason(menu));
    } catch (err) {
      console.warn(`role menu ${menu.name}: could not give role ${option.roleId} to ${userId}:`, err);
      await dropReaction();
      return;
    }
    this.db
      .insert(roleMenuReactions)
      .values({ menu: menu.name, roleId: option.roleId, userId })
      .onConflictDoNothing()
      .run();
    if (menu.mode !== "single") return;

    const records = new Set(this.records(menu.name, userId).map((r) => r.roleId));
    for (const other of menu.options) {
      if (other === option) continue;
      if (records.has(other.roleId)) {
        await this.revoke(menu, userId, other.roleId);
        await this.guild
          .removeReaction(channelId, messageId, other.emoji.api, userId)
          .catch(warn(menu, `could not remove a reaction of ${userId}`));
      } else if (roles.includes(other.roleId)) {
        await this.guild
          .removeRole(userId, other.roleId, reason(menu))
          .catch(warn(menu, `could not take role ${other.roleId} from ${userId}`));
      }
    }
  }

  /**
   * Takes back a role the bot gave for a reaction. Without a record there's
   * nothing to take back, which is also why the bot removing a reaction itself
   * doesn't loop back here.
   */
  private async revoke(menu: Menu, userId: string, roleId: string) {
    const removed = this.db
      .delete(roleMenuReactions)
      .where(
        and(
          eq(roleMenuReactions.menu, menu.name),
          eq(roleMenuReactions.roleId, roleId),
          eq(roleMenuReactions.userId, userId),
        ),
      )
      .returning()
      .all();
    if (removed.length === 0) return;
    await this.guild
      .removeRole(userId, roleId, reason(menu))
      .catch(warn(menu, `could not take role ${roleId} from ${userId}`));
  }

  private records(menu: string, userId?: string) {
    const conditions = [eq(roleMenuReactions.menu, menu)];
    if (userId) conditions.push(eq(roleMenuReactions.userId, userId));
    return this.db
      .select()
      .from(roleMenuReactions)
      .where(and(...conditions))
      .all();
  }

  /** Drops a menu's row and, with it, its records. */
  private forget(name: string) {
    this.db.delete(roleMenus).where(eq(roleMenus.name, name)).run();
  }

  private enqueue(label: string, task: () => Promise<void>): Promise<void> {
    const next = this.queue
      .then(task)
      .catch((err) => console.error(`role menus: ${label} failed:`, err));
    this.queue = next;
    return next;
  }
}

export function renderMenu(menu: Menu): MessageBody {
  const lines = menu.options.map(
    (o) => `${o.emoji.text} <@&${o.roleId}>${o.description ? `: ${o.description}` : ""}`,
  );
  return {
    embeds: [
      {
        title: menu.title,
        description: [menu.description, lines.join("\n")].filter(Boolean).join("\n\n"),
        color: ACCENT,
        footer: FOOTER[menu.mode],
      },
    ],
  };
}

function findOption(menu: Menu, emoji: ReactionEmoji): MenuOption | undefined {
  const key = reactionKey(emoji);
  return key === undefined ? undefined : menu.options.find((o) => o.emoji.key === key);
}

/** Shown in the audit log next to every role change. */
function reason(menu: Menu): string {
  return `Role menu ${menu.name}`;
}

function warn(menu: { name: string }, what: string) {
  return (err: unknown) => console.warn(`role menu ${menu.name}: ${what}:`, err);
}
