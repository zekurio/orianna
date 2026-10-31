import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunDns from "@effect/platform-bun/BunDns";
import { Events } from "@fluxerjs/core";
import { Cause, Console, Deferred, Effect, Exit, Layer, Queue } from "effect";
import { FetchHttpClient } from "effect/http";
import type { CommandEntry } from "./commands/command.ts";
import { help, ping } from "./commands/general.ts";
import { makeCommandRouter } from "./commands/router.ts";
import { AppConfig, ConfigError } from "./config.ts";
import { Database } from "./db/index.ts";
import { proposalCommands } from "./expressions/commands.ts";
import { FluxerExpressionGuild } from "./expressions/fluxer.ts";
import { ImageMagick } from "./expressions/process.ts";
import { EMOJI, makeExpressionProposals, STICKER } from "./expressions/proposals.ts";
import { Fluxer, listen, logFailure, login } from "./fluxer.ts";
import { perms } from "./permissions/commands.ts";
import { FluxerGuildAccess } from "./permissions/fluxer.ts";
import { GuildAccess } from "./permissions/rules.ts";
import { pollCommands } from "./polls/commands.ts";
import { makeCommunityPolls } from "./polls/community.ts";
import { attachPollMessageDeletes, FluxerPollTransport } from "./polls/fluxer.ts";
import { PollService } from "./polls/service.ts";
import { attachReactions } from "./reactions.ts";
import { attachRoleMenuEvents, FluxerRoleGuild } from "./roles/fluxer.ts";
import { makeRoleMenus } from "./roles/menus.ts";

const Platform = Layer.mergeAll(BunServices.layer, BunDns.layer, FetchHttpClient.layer);

const Core = Layer.mergeAll(Database.layer, Fluxer.layer).pipe(
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(Platform),
);

const Adapters = Layer.mergeAll(
  FluxerGuildAccess,
  FluxerPollTransport,
  FluxerRoleGuild,
  FluxerExpressionGuild,
  ImageMagick.layer,
).pipe(Layer.provideMerge(Core));

const App = PollService.layer.pipe(Layer.provideMerge(Adapters));

/**
 * Without a handler SIGHUP would end the process, and systemd doesn't restart
 * a service that SIGHUP ended, so this goes in before anything else.
 */
const hangups = Effect.gen(function* () {
  const queue = yield* Queue.sliding<void>(1);
  const onHangup = () => Queue.offerUnsafe(queue, undefined);
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("SIGHUP", onHangup)),
    () => Effect.sync(() => process.off("SIGHUP", onHangup)),
  );
  return queue;
});

const warnUnknownRoles = Effect.gen(function* () {
  const ids = yield* (yield* GuildAccess).unknownRoles;
  for (const id of ids) {
    yield* Effect.logWarning(`permissions.roles: there is no role ${id}, so its rules do nothing`);
  }
}).pipe(Effect.catch((err) => Effect.logError(`checking permission roles failed: ${err.message}`)));

const reload = Effect.gen(function* () {
  const needRestart = yield* (yield* AppConfig).reload;
  yield* Effect.logInfo("config reloaded");
  if (needRestart.length > 0) {
    yield* Effect.logWarning(`restart to apply the changes to ${needRestart.join(", ")}`);
  }
  // In a fiber of its own, so a slow Fluxer can't hold up the next reload.
  yield* Effect.forkScoped(warnUnknownRoles);
}).pipe(
  Effect.catchTag("ConfigError", (err) =>
    Effect.logError(`config not reloaded, keeping the old one: ${err.message}`),
  ),
);

const run = Effect.fnUntraced(function* (hangups: Queue.Queue<void>) {
  const config = yield* AppConfig.current;
  const polls = yield* PollService;

  const commands: CommandEntry[] = [ping, help, perms];
  for (const [kind, section] of [
    [EMOJI, config.emoji],
    [STICKER, config.sticker],
  ] as const) {
    // parseConfig refuses a proposal section without pollsChannelId.
    if (!section || config.pollsChannelId === undefined) continue;
    const proposals = yield* makeExpressionProposals(kind, {
      config: section,
      guildId: config.guildId,
      channelId: config.pollsChannelId,
    });
    commands.push(yield* proposalCommands(proposals, config.pollsChannelId));
  }
  if (config.emoji || config.sticker) {
    // Polls and role menus work without ImageMagick, so this only warns.
    yield* (yield* ImageMagick).check.pipe(
      Effect.flatMap((problems) =>
        Effect.forEach(problems, (problem) => Effect.logError(`emoji and sticker images won't work: ${problem}`)),
      ),
      Effect.forkScoped,
    );
  }
  const community = config.polls ? yield* makeCommunityPolls(config.polls, config.guildId) : undefined;
  if (community) commands.push(...pollCommands(community));

  const router = yield* makeCommandRouter(commands);
  // Built even without a `roleMenus` section, so removing it takes the menus down.
  const roleMenus = yield* makeRoleMenus(config.roleMenus);

  // Catch up on votes and 🛑 reactions from while offline before deadlines are processed.
  const catchUpPolls = polls.reconcile().pipe(
    Effect.andThen(community ? community.reconcile() : Effect.void),
    Effect.catchCause(logFailure("poll reconcile")),
    Effect.andThen(polls.start),
  );

  const ready = yield* Deferred.make<void>();
  yield* listen(Events.Ready, "startup", () =>
    Effect.gen(function* () {
      const { client } = yield* Fluxer;
      yield* Effect.logInfo(`logged in as ${client.user?.username} on ${config.instance}`);
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.all([catchUpPolls, roleMenus.sync, warnUnknownRoles], {
        concurrency: "unbounded",
        discard: true,
      });
    }),
  );
  yield* listen(Events.MessageCreate, "handling a message", router.handleMessage);
  yield* attachReactions(polls, "poll");
  if (community) yield* attachPollMessageDeletes(community);
  yield* attachRoleMenuEvents(roleMenus);

  // Reloads wait for the first login, then run in turn.
  yield* Effect.gen(function* () {
    yield* Deferred.await(ready);
    for (;;) {
      yield* Queue.take(hangups);
      yield* reload;
    }
  }).pipe(Effect.forkScoped);

  // Finalizers run last to first, so this is logged before anything stops.
  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.logInfo("shutting down") : Effect.void,
  );
  yield* login;
  return yield* Effect.never;
});

const main = Effect.gen(function* () {
  const queue = yield* hangups;
  // The handlers' scope closes before the layers are released, so nothing
  // still running can reach a closed database or client.
  yield* run(queue).pipe(Effect.scoped, Effect.provide(App));
}).pipe(
  Effect.scoped,
  Effect.tapCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const error = Cause.squash(cause);
    return error instanceof ConfigError ? Console.error(error.message) : Effect.logError(cause);
  }),
);

BunRuntime.runMain(main, {
  disableErrorReporting: true,
  // SIGINT and SIGTERM interrupt the bot; stopping that way is a clean exit.
  teardown: (exit, onExit) =>
    onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
