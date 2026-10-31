import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunDns from "@effect/platform-bun/BunDns";
import { Events } from "@fluxerjs/core";
import { Cause, Console, Deferred, Effect, Exit, Layer, Queue, SubscriptionRef } from "effect";
import { FetchHttpClient } from "effect/http";
import { FluxerBoardGuild } from "./boards/fluxer.ts";
import type { CommandEntry } from "./commands/command.ts";
import { help, ping } from "./commands/general.ts";
import { makeCommandRouter } from "./commands/router.ts";
import { AppConfig, ConfigError } from "./config.ts";
import { Database } from "./db/index.ts";
import { FluxerExpressionGuild } from "./expressions/fluxer.ts";
import { ImageMagick } from "./expressions/process.ts";
import { applySettings, type Milestones, warnUnknownRoles } from "./features.ts";
import { Fluxer, listen, logFailure, login } from "./fluxer.ts";
import { perms } from "./permissions/commands.ts";
import { FluxerGuildAccess } from "./permissions/fluxer.ts";
import { FluxerPollTransport } from "./polls/fluxer.ts";
import { PollService } from "./polls/service.ts";
import { attachReactions } from "./reactions.ts";
import { FluxerRoleGuild } from "./roles/fluxer.ts";
import { settingsCommands } from "./settings/commands.ts";
import { Settings } from "./settings/settings.ts";
import { WebServer } from "./web/server.ts";

const Platform = Layer.mergeAll(BunServices.layer, BunDns.layer, FetchHttpClient.layer);

// The settings load, and a bad import stops the bot, before it reaches out to Fluxer.
const Core = Fluxer.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(Platform),
);

const Adapters = Layer.mergeAll(
  FluxerGuildAccess,
  FluxerPollTransport,
  FluxerRoleGuild,
  FluxerExpressionGuild,
  FluxerBoardGuild,
  ImageMagick.layer,
).pipe(Layer.provideMerge(Core));

const App = Layer.mergeAll(PollService.layer, WebServer).pipe(Layer.provideMerge(Adapters));

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

const run = Effect.fnUntraced(function* (hangups: Queue.Queue<void>) {
  const { instance } = yield* AppConfig.current;
  const polls = yield* PollService;
  const milestones: Milestones = {
    logins: yield* SubscriptionRef.make(0),
    pollCatchUps: yield* SubscriptionRef.make(0),
  };

  // The router, the poll service and its reactions outlive changes to the
  // settings; the features come and go with them.
  const base: CommandEntry[] = [ping, help, perms, yield* settingsCommands()];
  const router = yield* makeCommandRouter(base);

  // Catch up on votes from while offline before deadlines are processed.
  const catchUpPolls = polls.reconcile().pipe(
    Effect.catchCause(logFailure("poll reconcile")),
    Effect.andThen(SubscriptionRef.update(milestones.pollCatchUps, (n) => n + 1)),
    Effect.andThen(polls.start),
  );

  yield* listen(Events.Ready, "startup", () =>
    Effect.gen(function* () {
      const { client } = yield* Fluxer;
      yield* Effect.logInfo(`logged in as ${client.user?.username} on ${instance}`);
      yield* SubscriptionRef.update(milestones.logins, (n) => n + 1);
      yield* Effect.all([catchUpPolls, warnUnknownRoles], { concurrency: "unbounded", discard: true });
    }),
  );
  yield* listen(Events.MessageCreate, "handling a message", router.handleMessage);
  yield* attachReactions(polls, "poll");

  // The first features attach their listeners before the bot logs in.
  const started = yield* Deferred.make<void>();
  yield* applySettings(router, base, milestones, started).pipe(Effect.forkScoped);
  yield* Deferred.await(started);

  // Bot settings apply as soon as they change, and the config file only has
  // what takes a restart, so there's nothing left to reload.
  yield* Effect.gen(function* () {
    for (;;) {
      yield* Queue.take(hangups);
      yield* Effect.logInfo(
        "got SIGHUP, but nothing reloads: bot settings apply when they change, and the config file needs a restart",
      );
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
