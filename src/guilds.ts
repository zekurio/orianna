import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import type { ConfigError } from "./config.ts";
import { Database } from "./db/index.ts";
import { FluxerExpressionGuild } from "./expressions/fluxer.ts";
import type { ExpressionGuild } from "./expressions/proposals.ts";
import { Fluxer } from "./fluxer.ts";
import { CurrentGuild } from "./guild.ts";
import { FluxerGuildAccess } from "./permissions/fluxer.ts";
import type { GuildAccess } from "./permissions/rules.ts";
import type { CommunityPollChat } from "./polls/community.ts";
import { FluxerCommunityPollChat } from "./polls/fluxer.ts";
import { PollTransport } from "./polls/transport.ts";
import { FluxerRoleGuild } from "./roles/fluxer.ts";
import type { RoleGuild } from "./roles/menus.ts";
import { Settings, SettingsStore } from "./settings/settings.ts";
import { FluxerStarboardGuild } from "./starboard/fluxer.ts";
import { LiveStarboard, type StarboardGuild } from "./starboard/starboard.ts";

// The bot serves every guild it's in. Each guild gets its own services, for
// its settings and for talking to Fluxer about it; features, commands and web
// calls for a guild run with them.

/** What runs for one guild. */
export type GuildServices =
  | CurrentGuild
  | Settings
  | GuildAccess
  | RoleGuild
  | ExpressionGuild
  | StarboardGuild
  | CommunityPollChat
  | LiveStarboard;

/** What every guild's services are built from. */
type Shared = Fluxer | Database | SettingsStore | PollTransport | HttpClient.HttpClient | Dns.Dns;

const guildLayer = (guildId: string) =>
  Layer.mergeAll(
    FluxerGuildAccess,
    FluxerRoleGuild,
    FluxerExpressionGuild,
    FluxerStarboardGuild,
    FluxerCommunityPollChat,
    LiveStarboard.layer,
  ).pipe(Layer.provideMerge(Settings.layer), Layer.provideMerge(Layer.succeed(CurrentGuild, { id: guildId })));

export class Guilds extends Context.Service<
  Guilds,
  {
    /**
     * The guild's services, built the first time they're needed. Fails when
     * the guild's stored settings don't validate.
     */
    readonly context: (guildId: string) => Effect.Effect<Context.Context<GuildServices>, ConfigError>;
    /** Lets go of a guild the bot left. */
    readonly forget: (guildId: string) => Effect.Effect<void>;
    /** The guilds the bot is in. */
    readonly ids: Effect.Effect<readonly string[]>;
    /** The guilds whose services are built, for work that spans them. */
    readonly built: Effect.Effect<ReadonlyMap<string, Context.Context<GuildServices>>>;
  }
>()("orianna/Guilds") {
  static readonly layer = Layer.effect(
    Guilds,
    Effect.gen(function* () {
      const shared = yield* Effect.context<Shared>();
      const { client } = yield* Fluxer;
      const parent = yield* Effect.scope;
      const built = new Map<string, { context: Context.Context<GuildServices>; scope: Scope.Closeable }>();
      // One build at a time, so a guild's services are only built once.
      const lock = yield* Semaphore.make(1);

      const context = (guildId: string) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const known = built.get(guildId);
            if (known) return known.context;
            const scope = yield* Scope.fork(parent);
            const result = yield* Effect.exit(
              Layer.buildWithScope(guildLayer(guildId).pipe(Layer.provide(Layer.succeedContext(shared))), scope),
            );
            if (Exit.isFailure(result)) {
              yield* Scope.close(scope, Exit.void);
              return yield* Effect.failCause(result.cause);
            }
            built.set(guildId, { context: result.value, scope });
            return result.value;
          }),
        );

      return {
        context,
        forget: (guildId) =>
          lock.withPermits(1)(
            Effect.suspend(() => {
              const known = built.get(guildId);
              if (!known) return Effect.void;
              built.delete(guildId);
              return Scope.close(known.scope, Exit.void);
            }),
          ),
        ids: Effect.sync(() => [...client.guilds.keys()]),
        built: Effect.sync(() => new Map([...built].map(([id, { context }]) => [id, context]))),
      };
    }),
  );
}
