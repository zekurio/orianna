import { Events } from "@fluxerjs/core";
import { Effect, Exit, FiberMap, Scope, Stream, SubscriptionRef } from "effect";
import type { CommandEntry } from "./commands/command.ts";
import type { CommandRouter } from "./commands/router.ts";
import type { BotSettings } from "./config.ts";
import { proposalCommands } from "./expressions/commands.ts";
import { EMOJI, makeExpressionProposals, STICKER } from "./expressions/proposals.ts";
import { listen, logFailure } from "./fluxer.ts";
import { CurrentGuild } from "./guild.ts";
import { Guilds } from "./guilds.ts";
import { GuildAccess } from "./permissions/rules.ts";
import { pollCommands } from "./polls/commands.ts";
import { makeCommunityPolls } from "./polls/community.ts";
import { attachPollMessageDeletes } from "./polls/fluxer.ts";
import { attachRoleMenuEvents } from "./roles/fluxer.ts";
import { makeRoleMenus } from "./roles/menus.ts";
import { Settings } from "./settings/settings.ts";
import { starboardCommands } from "./starboard/commands.ts";
import { attachStarboardEvents } from "./starboard/fluxer.ts";
import { LiveStarboard, makeStarboard } from "./starboard/starboard.ts";

// The features each guild's settings turn on, built from the settings and
// built again when they change. main.ts runs them for every guild the bot is
// in, next to what all guilds share: the client, the command router and the
// poll service.

const warnUnknownRoles = Effect.gen(function* () {
  const { id } = yield* CurrentGuild;
  const ids = yield* (yield* GuildAccess).unknownRoles;
  for (const role of ids) {
    yield* Effect.logWarning(`guild ${id}: permissions.roles: there is no role ${role}, so its rules do nothing`);
  }
}).pipe(Effect.catch((err) => Effect.logError(`checking permission roles failed: ${err.message}`)));

/** What a change has to touch for the features to be built again. The rest is read on every use. */
const featureSettings = ({ prefix: _prefix, permissions: _permissions, ...rest }: BotSettings) => rest;

/** Counts of what has happened since startup, for features built later. */
export interface Milestones {
  /** Logins, one per Ready. */
  logins: SubscriptionRef.SubscriptionRef<number>;
  /** Poll catch-ups after a login, once votes from while offline are in. */
  pollCatchUps: SubscriptionRef.SubscriptionRef<number>;
}

/** Runs `task` now if `counter` is past zero, and again each time it goes up, until the scope closes. */
const whenever = <E, R>(counter: SubscriptionRef.SubscriptionRef<number>, task: Effect.Effect<void, E, R>) =>
  SubscriptionRef.changes(counter).pipe(
    Stream.filter((n) => n > 0),
    Stream.runForEach(() => task),
    Effect.forkScoped,
  );

/**
 * Builds the features the settings turn on, and their commands, in the
 * current scope. Closing it takes them down again: listeners go, poll kinds
 * are unregistered, and work in flight is interrupted.
 */
const startFeatures = Effect.fnUntraced(function* (
  settings: BotSettings,
  router: CommandRouter["Service"],
  base: readonly CommandEntry[],
  milestones: Milestones,
) {
  const { id: guildId } = yield* CurrentGuild;

  const commands: CommandEntry[] = [...base];
  for (const [kind, section] of [
    [EMOJI, settings.emoji],
    [STICKER, settings.sticker],
  ] as const) {
    // parseSettings refuses a proposal section without pollsChannelId.
    if (!section || settings.pollsChannelId === undefined) continue;
    const proposals = yield* makeExpressionProposals(kind, {
      config: section,
      guildId,
      channelId: settings.pollsChannelId,
    });
    commands.push(yield* proposalCommands(proposals, settings.pollsChannelId));
  }
  const community = settings.polls ? yield* makeCommunityPolls(settings.polls, guildId) : undefined;
  if (community) commands.push(...pollCommands(community));
  // Built while it's off too, so `!starboard set` can turn it on.
  const starboard = yield* makeStarboard(settings.starboard, guildId);
  commands.push(yield* starboardCommands());
  yield* LiveStarboard.provide(starboard);
  // Built even without a `roleMenus` section, so removing it takes the menus down.
  const roleMenus = yield* makeRoleMenus(settings.roleMenus);

  yield* Effect.acquireRelease(router.setCommands(guildId, commands), () => router.setCommands(guildId, base));
  if (community) yield* attachPollMessageDeletes(community);
  yield* attachRoleMenuEvents(roleMenus);
  if (starboard.board) yield* attachStarboardEvents(starboard);

  // Right away when the bot is already logged in, which is the case after a
  // change, and again on every login. 🛑 from while offline waits for the
  // votes, so a poll it ends counts them.
  yield* whenever(milestones.logins, roleMenus.sync);
  if (starboard.board) yield* whenever(milestones.logins, starboard.catchUp);
  // Posts the opt-out missed while the starboard was starting over, or couldn't delete.
  yield* whenever(milestones.logins, Effect.asVoid(starboard.takeDownOptedOut()));
  if (community) {
    const reconcile = community.reconcile().pipe(Effect.catchCause(logFailure("poll reconcile")));
    yield* whenever(milestones.pollCatchUps, reconcile);
  }
});

/**
 * Starts the guild's features, and starts them over whenever its settings
 * change in a way that needs it: the old ones are taken down before the new
 * ones are built, so their poll kinds don't clash.
 */
const applySettings = Effect.fnUntraced(function* (
  router: CommandRouter["Service"],
  base: readonly CommandEntry[],
  milestones: Milestones,
) {
  const settings = yield* Settings;
  const { id: guildId } = yield* CurrentGuild;
  // Forked once, up front: the features of each change are children of it, so
  // they close where it sits among the caller's finalizers.
  const parent = yield* Scope.fork(yield* Effect.scope);
  let scope: Scope.Closeable | undefined;
  let applied: ReturnType<typeof featureSettings> | undefined;
  let permissions: BotSettings["permissions"] | undefined;

  yield* settings.changes.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (!Bun.deepEquals(permissions, next.permissions)) yield* Effect.forkScoped(warnUnknownRoles);
        permissions = next.permissions;

        const wanted = featureSettings(next);
        if (applied && Bun.deepEquals(applied, wanted)) return;
        if (scope) {
          yield* Effect.logInfo(`guild ${guildId}: settings changed, starting the features over`);
          yield* Scope.close(scope, Exit.void);
        }
        scope = yield* Scope.fork(parent);
        applied = wanted;
        yield* startFeatures(next, router, base, milestones).pipe(
          Scope.provide(scope),
          Effect.catchCause(logFailure(`guild ${guildId}: starting the features`)),
        );
      }),
    ),
  );
});

/**
 * Runs the features of every guild the bot is in, until the scope closes:
 * the ones it's in when it logs in, and the ones it joins later. A guild it
 * leaves has its features taken down and its commands dropped. `base` are
 * the commands every guild has.
 */
export const serveGuilds = Effect.fnUntraced(function* (
  router: CommandRouter["Service"],
  base: readonly CommandEntry[],
  milestones: Milestones,
) {
  const guilds = yield* Guilds;
  const running = yield* FiberMap.make<string>();

  const run = (guildId: string) =>
    Effect.gen(function* () {
      const context = yield* guilds.context(guildId);
      yield* applySettings(router, base, milestones).pipe(Effect.scoped, Effect.provideContext(context));
    }).pipe(
      Effect.ensuring(router.removeGuild(guildId)),
      Effect.catchCause(logFailure(`guild ${guildId}: serving it`)),
    );
  const start = (guildId: string) => FiberMap.run(running, guildId, run(guildId), { onlyIfMissing: true });
  const stop = (guildId: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(running, guildId);
      yield* guilds.forget(guildId);
      yield* Effect.logInfo(`left guild ${guildId}`);
    });

  // Guilds come in as unavailable stubs with Ready, and become available one by one.
  yield* listen(Events.Ready, "starting guilds", () =>
    Effect.flatMap(guilds.ids, (ids) => Effect.forEach(ids, start, { discard: true })),
  );
  yield* listen(Events.GuildAvailable, "starting a guild", (guild) => Effect.asVoid(start(guild.id)));
  yield* listen(Events.GuildCreate, "starting a guild", (guild) =>
    Effect.logInfo(`joined guild ${guild.id}`).pipe(Effect.andThen(start(guild.id)), Effect.asVoid),
  );
  yield* listen(Events.GuildDelete, "stopping a guild", (guild) => stop(guild.id));
});
