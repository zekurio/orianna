import { Deferred, Effect, Exit, Scope, Stream, SubscriptionRef } from "effect";
import { LiveBoards, makeBoards } from "./boards/boards.ts";
import { boardCommands } from "./boards/commands.ts";
import { attachBoardEvents } from "./boards/fluxer.ts";
import type { CommandEntry } from "./commands/command.ts";
import type { CommandRouter } from "./commands/router.ts";
import { AppConfig, type BotSettings } from "./config.ts";
import { proposalCommands } from "./expressions/commands.ts";
import { ImageMagick } from "./expressions/process.ts";
import { EMOJI, makeExpressionProposals, STICKER } from "./expressions/proposals.ts";
import { logFailure } from "./fluxer.ts";
import { GuildAccess } from "./permissions/rules.ts";
import { pollCommands } from "./polls/commands.ts";
import { makeCommunityPolls } from "./polls/community.ts";
import { attachPollMessageDeletes } from "./polls/fluxer.ts";
import { attachRoleMenuEvents } from "./roles/fluxer.ts";
import { makeRoleMenus } from "./roles/menus.ts";
import { Settings } from "./settings/settings.ts";

// The features the bot settings turn on, built from the settings and built
// again when they change. main.ts runs them next to what outlives a change:
// the client, the command router and the poll service.

export const warnUnknownRoles = Effect.gen(function* () {
  const ids = yield* (yield* GuildAccess).unknownRoles;
  for (const id of ids) {
    yield* Effect.logWarning(`permissions.roles: there is no role ${id}, so its rules do nothing`);
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
  const { guildId } = yield* AppConfig.current;

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
  const imageUsers = [
    ...(settings.emoji || settings.sticker ? ["emoji and sticker images"] : []),
    ...(settings.boards?.length ? ["blurring NSFW images on boards"] : []),
  ];
  if (imageUsers.length > 0) {
    // Polls and role menus work without ImageMagick, so this only warns.
    const what = imageUsers.join(" and ");
    yield* (yield* ImageMagick).check.pipe(
      Effect.flatMap((problems) =>
        Effect.forEach(problems, (problem) => Effect.logError(`${what} won't work: ${problem}`)),
      ),
      Effect.forkScoped,
    );
  }
  const community = settings.polls ? yield* makeCommunityPolls(settings.polls, guildId) : undefined;
  if (community) commands.push(...pollCommands(community));
  // Built without boards too, so `!board create` can add the first one.
  const boards = yield* makeBoards(settings.boards ?? [], guildId);
  commands.push(yield* boardCommands(boards));
  yield* LiveBoards.provide(boards);
  // Built even without a `roleMenus` section, so removing it takes the menus down.
  const roleMenus = yield* makeRoleMenus(settings.roleMenus);

  yield* Effect.acquireRelease(router.setCommands(commands), () => router.setCommands(base));
  if (community) yield* attachPollMessageDeletes(community);
  yield* attachRoleMenuEvents(roleMenus);
  if (boards.boards.length > 0) yield* attachBoardEvents(boards);

  // Right away when the bot is already logged in, which is the case after a
  // change, and again on every login. 🛑 from while offline waits for the
  // votes, so a poll it ends counts them.
  yield* whenever(milestones.logins, roleMenus.sync);
  if (boards.boards.length > 0) yield* whenever(milestones.logins, boards.catchUp);
  if (community) {
    const reconcile = community.reconcile().pipe(Effect.catchCause(logFailure("poll reconcile")));
    yield* whenever(milestones.pollCatchUps, reconcile);
  }
});

/**
 * Starts the features, and starts them over whenever the settings change in
 * a way that needs it: the old ones are taken down before the new ones are
 * built, so their poll kinds don't clash. `started` is completed once the
 * first ones are up.
 */
export const applySettings = Effect.fnUntraced(function* (
  router: CommandRouter["Service"],
  base: readonly CommandEntry[],
  milestones: Milestones,
  started: Deferred.Deferred<void>,
) {
  const settings = yield* Settings;
  // Forked once, up front: the features of each change are children of it, so
  // they close where it sits among the caller's finalizers.
  const parent = yield* Scope.fork(yield* Effect.scope);
  let scope: Scope.Closeable | undefined;
  let applied: ReturnType<typeof featureSettings> | undefined;
  let permissions: BotSettings["permissions"] | undefined;

  yield* settings.changes.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (permissions && !Bun.deepEquals(permissions, next.permissions)) {
          if ((yield* SubscriptionRef.get(milestones.logins)) > 0) yield* Effect.forkScoped(warnUnknownRoles);
        }
        permissions = next.permissions;

        const wanted = featureSettings(next);
        if (applied && Bun.deepEquals(applied, wanted)) return;
        if (scope) {
          yield* Effect.logInfo("settings changed, starting the features over");
          yield* Scope.close(scope, Exit.void);
        }
        scope = yield* Scope.fork(parent);
        applied = wanted;
        yield* startFeatures(next, router, base, milestones).pipe(
          Scope.provide(scope),
          Effect.catchCause(logFailure("starting the features")),
        );
        yield* Deferred.succeed(started, undefined);
      }),
    ),
  );
});

