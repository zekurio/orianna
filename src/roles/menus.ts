import { and, eq, notInArray } from "drizzle-orm";
import { Context, Effect, Semaphore } from "effect";
import type { RoleMenuConfig, RoleMenusConfig } from "../config.ts";
import { Database } from "../db/index.ts";
import { roleMenuReactions, roleMenus } from "../db/schema.ts";
import {
  apiName,
  type ParsedEmoji,
  parseEmoji,
  type ReactionEmoji,
  reactionKey,
} from "../emoji.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import type { ReactionListener } from "../reactions.ts";

/** A reaction on a menu message. */
export interface MenuReaction {
  emoji: ReactionEmoji;
  /** Whether the bot is among those who reacted. */
  me: boolean;
}

/** What role menus need from the guild. */
export class RoleGuild extends Context.Service<
  RoleGuild,
  {
    /** Why members can't be given each role. Roles that are fine are left out. */
    readonly vetRoles: (roleIds: readonly string[]) => Effect.Effect<Map<string, string>, FluxerError>;
    /** The member's role IDs, or null when they aren't in the guild. */
    readonly memberRoles: (userId: string) => Effect.Effect<readonly string[] | null, FluxerError>;
    readonly addRole: (userId: string, roleId: string, reason: string) => Effect.Effect<void, FluxerError>;
    readonly removeRole: (userId: string, roleId: string, reason: string) => Effect.Effect<void, FluxerError>;
    /** Posts a message and returns its ID. */
    readonly post: (channelId: string, body: MessageBody) => Effect.Effect<string, FluxerError>;
    readonly edit: (channelId: string, messageId: string, body: MessageBody) => Effect.Effect<void, FluxerError>;
    /** Also succeeds when the message is already gone. */
    readonly delete: (channelId: string, messageId: string) => Effect.Effect<void, FluxerError>;
    /** The message's reactions, or null when the message is gone. */
    readonly reactions: (
      channelId: string,
      messageId: string,
    ) => Effect.Effect<MenuReaction[] | null, FluxerError>;
    readonly react: (channelId: string, messageId: string, emoji: string) => Effect.Effect<void, FluxerError>;
    readonly removeReaction: (
      channelId: string,
      messageId: string,
      emoji: string,
      userId: string,
    ) => Effect.Effect<void, FluxerError>;
    /** Removes every reaction with `emoji`. */
    readonly clearReaction: (channelId: string, messageId: string, emoji: string) => Effect.Effect<void, FluxerError>;
    /** Every non-bot user who reacted with `emoji`. */
    readonly reactionUsers: (
      channelId: string,
      messageId: string,
      emoji: string,
    ) => Effect.Effect<string[], FluxerError>;
  }
>()("orianna/RoleGuild") {}

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

export type RoleMenus = Effect.Success<ReturnType<typeof makeRoleMenus>>;

/**
 * Messages where members react to give themselves roles. All work runs one
 * task at a time, so quick clicks and the startup catch-up can't race.
 */
export const makeRoleMenus = Effect.fnUntraced(function* (config: RoleMenusConfig | undefined) {
  const db = yield* Database;
  const guild = yield* RoleGuild;
  /** By message ID. */
  const live = new Map<string, LiveMenu>();
  const lock = yield* Semaphore.make(1);

  function enqueue<E>(label: string, task: Effect.Effect<void, E>): Effect.Effect<void> {
    return lock.withPermits(1)(task).pipe(Effect.catchCause(logFailure(`role menus: ${label}`)));
  }

  const syncAll = Effect.gen(function* () {
    const menus = config?.menus ?? [];
    const names = new Set(menus.map((m) => m.name));
    live.clear();

    for (const row of db.select().from(roleMenus).all()) {
      if (names.has(row.name)) continue;
      const deleted = yield* guild.delete(row.channelId, row.messageId).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          Effect.logWarning(`role menu ${row.name}: could not delete its message, will retry: ${err.message}`).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!deleted) continue;
      forget(row.name);
      yield* Effect.logInfo(`role menu ${row.name}: no longer in the config, deleted its message`);
    }
    if (menus.length === 0) return;

    const problems = yield* guild.vetRoles(menus.flatMap((m) => m.options.map((o) => o.roleId)));
    for (const menu of menus) {
      yield* syncMenu(menu, problems).pipe(Effect.catchCause(logFailure(`role menu ${menu.name}: sync`)));
    }
  });

  const syncMenu = Effect.fnUntraced(function* (menuConfig: RoleMenuConfig, problems: Map<string, string>) {
    const options: MenuOption[] = [];
    const paused = new Set<string>();
    for (const option of menuConfig.options) {
      // The config check already rejected anything that doesn't parse.
      const emoji = parseEmoji(option.emoji)!;
      const problem = problems.get(option.roleId);
      if (problem) {
        yield* Effect.logWarning(`role menu ${menuConfig.name}: leaving out role ${option.roleId}: ${problem}`);
        paused.add(emoji.key);
        continue;
      }
      options.push({ roleId: option.roleId, emoji, description: option.description });
    }
    if (options.length === 0) {
      yield* Effect.logWarning(
        `role menu ${menuConfig.name}: none of its roles can be given out; leaving it as is`,
      );
      return;
    }

    const menu: Menu = {
      name: menuConfig.name,
      title: menuConfig.title,
      description: menuConfig.description,
      mode: menuConfig.mode,
      channelId: menuConfig.channelId ?? config!.channelId,
      options,
    };
    const body = renderMenu(menu);
    const rendered = JSON.stringify(body);

    let row = db.select().from(roleMenus).where(eq(roleMenus.name, menu.name)).get();
    let reactions: MenuReaction[] | null = [];
    if (row && row.channelId !== menu.channelId) {
      yield* guild.delete(row.channelId, row.messageId);
      forget(row.name);
      row = undefined;
    }
    if (row) {
      reactions = yield* guild.reactions(row.channelId, row.messageId);
      if (!reactions) {
        yield* Effect.logInfo(`role menu ${menu.name}: message is gone, posting it again`);
        forget(row.name);
        row = undefined;
      }
    }
    if (!row) {
      const messageId = yield* guild.post(menu.channelId, body);
      row = db
        .insert(roleMenus)
        .values({ name: menu.name, channelId: menu.channelId, messageId, rendered })
        .returning()
        .get();
      reactions = [];
    } else if (row.rendered !== rendered) {
      yield* guild.edit(row.channelId, row.messageId, body);
      db.update(roleMenus).set({ rendered }).where(eq(roleMenus.name, menu.name)).run();
    }

    const liveMenu: LiveMenu = { ...menu, messageId: row.messageId, paused };
    live.set(liveMenu.messageId, liveMenu);

    // Roles taken out of the menu stay with whoever has them; only the records go.
    db.delete(roleMenuReactions)
      .where(
        and(
          eq(roleMenuReactions.menu, menu.name),
          notInArray(
            roleMenuReactions.roleId,
            menuConfig.options.map((o) => o.roleId),
          ),
        ),
      )
      .run();

    yield* syncReactions(liveMenu, reactions ?? []);
    yield* catchUp(liveMenu);
  });

  /** Adds the bot's reaction for each option and clears emoji that aren't options. */
  const syncReactions = Effect.fnUntraced(function* (menu: LiveMenu, reactions: MenuReaction[]) {
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
        yield* guild
          .clearReaction(channelId, messageId, name)
          .pipe(Effect.catch(warn(menu, `could not clear ${name}`)));
      }
    }
    for (const option of menu.options) {
      if (mine.has(option.emoji.key)) continue;
      yield* guild
        .react(channelId, messageId, option.emoji.api)
        .pipe(Effect.catch(warn(menu, `could not react with ${option.emoji.api}`)));
    }
  });

  /** Applies reactions added or removed while the bot was offline. */
  const catchUp = Effect.fnUntraced(function* (menu: LiveMenu) {
    const { channelId, messageId } = menu;
    const reacted = new Map<string, MenuOption[]>();
    for (const option of menu.options) {
      for (const userId of yield* guild.reactionUsers(channelId, messageId, option.emoji.api)) {
        reacted.set(userId, [...(reacted.get(userId) ?? []), option]);
      }
    }

    const all = records(menu.name);
    const recorded = (userId: string, roleId: string) =>
      all.some((r) => r.userId === userId && r.roleId === roleId);

    for (const record of all) {
      // Paused options weren't read, so their reactions look removed.
      if (!menu.options.some((o) => o.roleId === record.roleId)) continue;
      if (reacted.get(record.userId)?.some((o) => o.roleId === record.roleId)) continue;
      yield* revoke(menu, record.userId, record.roleId);
    }

    for (const [userId, picked] of reacted) {
      let missing = picked.filter((o) => !recorded(userId, o.roleId));
      if (menu.mode === "single" && picked.length > 1) {
        // Several picks in a single-choice menu: keep the one already given.
        const keep = picked.find((o) => recorded(userId, o.roleId)) ?? picked[0]!;
        for (const option of picked) {
          if (option === keep) continue;
          yield* revoke(menu, userId, option.roleId);
          yield* guild
            .removeReaction(channelId, messageId, option.emoji.api, userId)
            .pipe(Effect.catch(warn(menu, `could not remove a reaction of ${userId}`)));
        }
        missing = missing.includes(keep) ? [keep] : [];
      }
      for (const option of missing) yield* grant(menu, option, userId);
    }
  });

  /**
   * Gives the role for a reaction, or takes the reaction back when that fails
   * so the menu never shows a role the member doesn't have. In single-choice
   * menus this also takes away the member's other roles from the menu.
   */
  const grant = Effect.fnUntraced(function* (menu: LiveMenu, option: MenuOption, userId: string) {
    const { channelId, messageId } = menu;
    const dropReaction = guild
      .removeReaction(channelId, messageId, option.emoji.api, userId)
      .pipe(Effect.catch(warn(menu, `could not remove a reaction of ${userId}`)));

    const roles = yield* guild.memberRoles(userId);
    if (!roles) return yield* dropReaction;
    // Always sent: the cached roles can lag behind a removal a moment ago.
    const given = yield* guild.addRole(userId, option.roleId, reason(menu)).pipe(
      Effect.as(true),
      Effect.catch((err) =>
        warn(menu, `could not give role ${option.roleId} to ${userId}`)(err).pipe(Effect.as(false)),
      ),
    );
    if (!given) return yield* dropReaction;

    db.insert(roleMenuReactions)
      .values({ menu: menu.name, roleId: option.roleId, userId })
      .onConflictDoNothing()
      .run();
    if (menu.mode !== "single") return;

    const held = new Set(records(menu.name, userId).map((r) => r.roleId));
    for (const other of menu.options) {
      if (other === option) continue;
      if (held.has(other.roleId)) {
        yield* revoke(menu, userId, other.roleId);
        yield* guild
          .removeReaction(channelId, messageId, other.emoji.api, userId)
          .pipe(Effect.catch(warn(menu, `could not remove a reaction of ${userId}`)));
      } else if (roles.includes(other.roleId)) {
        yield* guild
          .removeRole(userId, other.roleId, reason(menu))
          .pipe(Effect.catch(warn(menu, `could not take role ${other.roleId} from ${userId}`)));
      }
    }
  });

  /**
   * Takes back a role the bot gave for a reaction. Without a record there's
   * nothing to take back, which is also why the bot removing a reaction itself
   * doesn't loop back here.
   */
  function revoke(menu: Menu, userId: string, roleId: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const removed = db
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
      if (removed.length === 0) return Effect.void;
      return guild
        .removeRole(userId, roleId, reason(menu))
        .pipe(Effect.catch(warn(menu, `could not take role ${roleId} from ${userId}`)));
    });
  }

  function records(menu: string, userId?: string) {
    const conditions = [eq(roleMenuReactions.menu, menu)];
    if (userId) conditions.push(eq(roleMenuReactions.userId, userId));
    return db
      .select()
      .from(roleMenuReactions)
      .where(and(...conditions))
      .all();
  }

  /** Drops a menu's row and, with it, its records. */
  function forget(name: string) {
    db.delete(roleMenus).where(eq(roleMenus.name, name)).run();
  }

  const menus = {
    /**
     * Makes the menu messages match the config, then catches up on reactions
     * added or removed while the bot was offline.
     */
    sync: enqueue("sync", syncAll),

    reactionAdded: (messageId: string, userId: string, emoji: ReactionEmoji) =>
      enqueue(
        "reaction",
        Effect.gen(function* () {
          const menu = live.get(messageId);
          if (!menu) return;
          const option = findOption(menu, emoji);
          if (option) return yield* grant(menu, option, userId);

          const key = reactionKey(emoji);
          const name = apiName(emoji);
          if (!key || !name || menu.paused.has(key)) return;
          // Keeps the row of reactions down to the menu's own emoji.
          yield* guild
            .removeReaction(menu.channelId, messageId, name, userId)
            .pipe(Effect.catch(warn(menu, `could not remove ${name}`)));
        }),
      ),

    reactionRemoved: (messageId: string, userId: string, emoji: ReactionEmoji) =>
      enqueue(
        "reaction",
        Effect.suspend(() => {
          const menu = live.get(messageId);
          const option = menu && findOption(menu, emoji);
          return menu && option ? revoke(menu, userId, option.roleId) : Effect.void;
        }),
      ),

    /**
     * A moderator removed all reactions, or all of one emoji. Members keep their
     * roles, and the bot puts its own reactions back.
     */
    reactionsCleared: (messageId: string, emoji?: ReactionEmoji) =>
      enqueue(
        "reaction clear",
        Effect.gen(function* () {
          const menu = live.get(messageId);
          if (!menu) return;
          const option = emoji && findOption(menu, emoji);
          const cleared = emoji ? (option ? [option] : []) : menu.options;
          for (const option of cleared) {
            db.delete(roleMenuReactions)
              .where(and(eq(roleMenuReactions.menu, menu.name), eq(roleMenuReactions.roleId, option.roleId)))
              .run();
            yield* guild
              .react(menu.channelId, messageId, option.emoji.api)
              .pipe(Effect.catch(warn(menu, `could not react with ${option.emoji.api}`)));
          }
        }),
      ),

    /** Someone deleted a menu message. Members keep their roles. */
    messageDeleted: (messageId: string) =>
      enqueue(
        "message delete",
        Effect.gen(function* () {
          const row = db.select().from(roleMenus).where(eq(roleMenus.messageId, messageId)).get();
          if (!row) return;
          live.delete(messageId);
          forget(row.name);
          yield* Effect.logInfo(`role menu ${row.name}: message was deleted; it's posted again on the next start`);
        }),
      ),

    /** Removes the member's reactions, so they find the menus clean if they come back. */
    memberLeft: (userId: string) =>
      enqueue(
        "member leave",
        Effect.gen(function* () {
          const rows = db.delete(roleMenuReactions).where(eq(roleMenuReactions.userId, userId)).returning().all();
          for (const row of rows) {
            const menu = [...live.values()].find((m) => m.name === row.menu);
            const option = menu?.options.find((o) => o.roleId === row.roleId);
            if (!menu || !option) continue;
            yield* guild
              .removeReaction(menu.channelId, menu.messageId, option.emoji.api, userId)
              .pipe(Effect.catch(warn(menu, `could not remove a reaction of ${userId}`)));
          }
        }),
      ),
  };
  return menus satisfies ReactionListener;
});

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
  return (err: FluxerError) => Effect.logWarning(`role menu ${menu.name}: ${what}: ${err.reason}`);
}
