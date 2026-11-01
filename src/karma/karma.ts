import { and, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer, Semaphore } from "effect";
import type { KarmaConfig, KarmaRule } from "../config.ts";
import { Database, type Transaction } from "../db/index.ts";
import { karma, karmaBonuses, karmaVotes } from "../db/schema.ts";
import { parseEmoji, type ReactionEmoji, reactionKey } from "../emoji.ts";
import type { FluxerError } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import { RoleGuild } from "../roles/menus.ts";
import { Settings } from "../settings/settings.ts";

// Karma, as shinpuru has it: members vote on each other's messages with
// reactions, the starboard adds to it, and rules act on a member whose karma
// crosses a value. The settings are read on every vote, so a change applies
// to the next one. There's no global karma: each guild counts its own.

/** A member as the scoreboard shows them. */
export interface KarmaMember {
  name: string;
  avatarUrl: string;
}

/** What karma needs from the guild. Roles come from {@link RoleGuild}. */
export class KarmaGuild extends Context.Service<
  KarmaGuild,
  {
    /** Who wrote a message; null when it's gone. */
    readonly author: (
      channelId: string,
      messageId: string,
    ) => Effect.Effect<{ readonly id: string; readonly bot: boolean } | null, FluxerError>;
    readonly name: Effect.Effect<string, FluxerError>;
    readonly dm: (userId: string, body: MessageBody) => Effect.Effect<void, FluxerError>;
    readonly kick: (userId: string, reason: string) => Effect.Effect<void, FluxerError>;
    readonly ban: (userId: string, reason: string) => Effect.Effect<void, FluxerError>;
    /** Those of `userIds` still in the guild, by user ID. */
    readonly members: (userIds: readonly string[]) => Effect.Effect<Map<string, KarmaMember>, FluxerError>;
  }
>()("orianna/KarmaGuild") {}

/** A member's karma before and after a change. */
interface Change {
  userId: string;
  before: number;
  after: number;
}

const HOUR = 60 * 60 * 1000;

/** The current guild's karma. */
export class Karma extends Context.Service<
  Karma,
  {
    /** A member reacted to a message; counts it when it's a karma vote. */
    readonly reacted: (
      channelId: string,
      messageId: string,
      voterId: string,
      emoji: ReactionEmoji,
    ) => Effect.Effect<void, FluxerError>;
    /** Gives the author of a message that got into the starboard `amount`, once per message. */
    readonly starboardBonus: (messageId: string, authorId: string, amount: number) => Effect.Effect<void>;
    /** Takes back what {@link starboardBonus} gave for a message whose post someone deleted. */
    readonly revokeBonus: (messageId: string) => Effect.Effect<void>;
    /** A member's karma, 0 for one who has none. */
    readonly of: (userId: string) => Effect.Effect<number>;
    /** The members with the most karma, most first. Those at 0 are left out. */
    readonly top: (limit: number) => Effect.Effect<{ userId: string; value: number }[]>;
  }
>()("orianna/Karma") {
  static readonly layer = Layer.effect(
    Karma,
    Effect.gen(function* () {
      const db = yield* Database;
      const settings = yield* Settings;
      const guild = yield* KarmaGuild;
      const roles = yield* RoleGuild;
      const { id: guildId } = yield* CurrentGuild;
      // One change at a time, so the rules see each in turn, and act on them in order.
      const lock = yield* Semaphore.make(1);

      /** Adds `amount` to the member's karma. */
      function add(tx: Transaction, userId: string, amount: number): Change {
        const { value } = tx
          .insert(karma)
          .values({ guildId, userId, value: amount })
          .onConflictDoUpdate({ target: [karma.guildId, karma.userId], set: { value: sql`${karma.value} + ${amount}` } })
          .returning({ value: karma.value })
          .get()!;
        return { userId, before: value - amount, after: value };
      }

      /** Acts on the rules that `change` crossed. A rule that fails is logged and doesn't stop the rest. */
      const applyRules = Effect.fnUntraced(function* (rules: readonly KarmaRule[], { userId, before, after }: Change) {
        for (const rule of rules) {
          const now = holds(rule, after);
          if (holds(rule, before) === now) continue;
          yield* act(rule, userId, now).pipe(
            Effect.catch((err) => Effect.logWarning(`karma: rule ${ruleName(rule)} for ${userId}: ${err.message}`)),
          );
        }
      });

      /** What a rule does once it holds for a member, or no longer does. */
      const act = Effect.fnUntraced(function* (rule: KarmaRule, userId: string, now: boolean) {
        const reason = now ? `Karma ${crossed(rule)}` : `Karma no longer ${rule.when} ${rule.value}`;
        if (rule.action === "role") {
          const roleId = rule.roleId!;
          const problem = (yield* roles.vetRoles([roleId])).get(roleId);
          if (problem) return yield* Effect.logWarning(`karma: rule ${ruleName(rule)}: can't use role ${roleId}: ${problem}`);
          return yield* now ? roles.addRole(userId, roleId, reason) : roles.removeRole(userId, roleId, reason);
        }
        if (!now) return;
        switch (rule.action) {
          case "message":
            return yield* tell(userId, rule, rule.message!);
          case "kick":
            yield* tell(userId, rule, "Because of that, you've been kicked from the server.");
            return yield* guild.kick(userId, reason);
          case "ban":
            yield* tell(userId, rule, "Because of that, you've been banned from the server.");
            return yield* guild.ban(userId, reason);
        }
      });

      /** shinpuru's DM about a rule. Members who don't take DMs miss it, which only gets logged. */
      const tell = (userId: string, rule: KarmaRule, text: string) =>
        Effect.gen(function* () {
          const name = yield* guild.name;
          const description = `Your karma in **${name}** ${crossed(rule)}.\n\n${text}`;
          yield* guild.dm(userId, { embeds: [{ description, color: ACCENT }] });
        }).pipe(Effect.catch((err) => Effect.logWarning(`karma: couldn't DM ${userId}: ${err.message}`)));

      /** Whether the member already voted on the message. */
      const voted = (messageId: string, voterId: string) =>
        db
          .select()
          .from(karmaVotes)
          .where(and(eq(karmaVotes.messageId, messageId), eq(karmaVotes.voterId, voterId)))
          .get() !== undefined;

      /** Records a vote and what it changes, unless the member voted on the message already or used up their hour. */
      function vote(config: KarmaConfig, messageId: string, voterId: string, authorId: string, value: 1 | -1) {
        return db.transaction((tx): Change[] => {
          const now = new Date();
          const given =
            tx
              .select({ n: count() })
              .from(karmaVotes)
              .where(
                and(
                  eq(karmaVotes.guildId, guildId),
                  eq(karmaVotes.voterId, voterId),
                  gt(karmaVotes.votedAt, new Date(now.getTime() - HOUR)),
                ),
              )
              .get()?.n ?? 0;
          if (given >= config.votesPerHour) return [];
          const recorded = tx
            .insert(karmaVotes)
            .values({ messageId, voterId, guildId, authorId, value, votedAt: now })
            .onConflictDoNothing()
            .returning()
            .get();
          if (!recorded) return [];
          const changes = [add(tx, authorId, value)];
          if (value < 0 && config.penalty) changes.push(add(tx, voterId, -1));
          return changes;
        });
      }

      return {
        reacted: (channelId, messageId, voterId, emoji) =>
          Effect.gen(function* () {
            const config = (yield* settings.get).karma;
            if (!config || config.blocklist.includes(voterId)) return;
            const key = reactionKey(emoji);
            const value = !key ? 0 : keysOf(config.upvotes).has(key) ? 1 : keysOf(config.downvotes).has(key) ? -1 : 0;
            if (value === 0 || voted(messageId, voterId)) return;
            const author = yield* guild.author(channelId, messageId);
            if (!author || author.bot || author.id === voterId || config.blocklist.includes(author.id)) return;
            yield* lock.withPermits(1)(
              Effect.forEach(vote(config, messageId, voterId, author.id, value), (change) =>
                applyRules(config.rules, change),
              ),
            );
          }),

        starboardBonus: (messageId, authorId, amount) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const config = (yield* settings.get).karma;
              if (!config || amount === 0 || config.blocklist.includes(authorId)) return;
              const change = db.transaction((tx) => {
                const given = tx
                  .insert(karmaBonuses)
                  .values({ messageId, guildId, userId: authorId, amount, givenAt: new Date() })
                  .onConflictDoNothing()
                  .returning()
                  .get();
                return given && add(tx, authorId, amount);
              });
              if (change) yield* applyRules(config.rules, change);
            }),
          ),

        // Also while karma is off, so turning it back on doesn't bring back what a deleted post gave.
        revokeBonus: (messageId) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const config = (yield* settings.get).karma;
              const change = db.transaction((tx) => {
                const bonus = tx
                  .update(karmaBonuses)
                  .set({ revoked: true })
                  .where(
                    and(
                      eq(karmaBonuses.messageId, messageId),
                      eq(karmaBonuses.guildId, guildId),
                      eq(karmaBonuses.revoked, false),
                    ),
                  )
                  .returning()
                  .get();
                return bonus && add(tx, bonus.userId, -bonus.amount);
              });
              if (change && config) yield* applyRules(config.rules, change);
            }),
          ),

        of: (userId) =>
          Effect.sync(
            () =>
              db
                .select({ value: karma.value })
                .from(karma)
                .where(and(eq(karma.guildId, guildId), eq(karma.userId, userId)))
                .get()?.value ?? 0,
          ),

        top: (limit) =>
          Effect.sync(() =>
            db
              .select({ userId: karma.userId, value: karma.value })
              .from(karma)
              .where(and(eq(karma.guildId, guildId), ne(karma.value, 0)))
              .orderBy(desc(karma.value))
              .limit(limit)
              .all(),
          ),
      };
    }),
  );
}

/** The keys of the emoji in a list from the settings. */
function keysOf(emoji: readonly string[]): Set<string> {
  return new Set(emoji.flatMap((e) => parseEmoji(e)?.key ?? []));
}

/** Whether karma at `value` is past the rule's. */
function holds(rule: KarmaRule, value: number): boolean {
  return rule.when === "above" ? value > rule.value : value < rule.value;
}

/** Like "rose above 10", for DMs and the audit log. */
function crossed(rule: KarmaRule): string {
  return `${rule.when === "above" ? "rose above" : "dropped below"} ${rule.value}`;
}

/** Like "above 10: role", for the log. */
function ruleName(rule: KarmaRule): string {
  return `${rule.when} ${rule.value}: ${rule.action}`;
}
