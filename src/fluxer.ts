import { Client, type ClientEventName, type ClientEvents, type Message } from "@fluxerjs/core";
import { Cause, Context, Data, Effect, FiberSet, Layer, Redacted, type Scope } from "effect";
import { AppConfig, readToken } from "./config.ts";

// Every call into fluxer.js goes through `request`, so failures arrive as a
// FluxerError instead of a rejected promise. fluxer.js already waits out rate
// limits and retries idempotent requests, so nothing here retries on top.

/** A request to Fluxer failed. */
export class FluxerError extends Data.TaggedError("FluxerError")<{
  /** What the bot was doing, e.g. "posting a poll". */
  readonly action: string;
  readonly cause: unknown;
}> {
  /** The HTTP status, when Fluxer answered. */
  get status(): number | undefined {
    const { statusCode } = (this.cause ?? {}) as { statusCode?: unknown };
    return typeof statusCode === "number" ? statusCode : undefined;
  }

  /** fluxer.js reports a 404 as `*_NOT_FOUND`; raw REST calls carry the API's `UNKNOWN_*`. */
  get notFound(): boolean {
    if (this.status === 404) return true;
    const { code } = (this.cause ?? {}) as { code?: unknown };
    return typeof code === "string" && (code.endsWith("_NOT_FOUND") || code.startsWith("UNKNOWN_"));
  }

  /**
   * fluxer.js HTTP errors carry `isRetryable` (429 and 5xx). Anything else from
   * the API is final; network errors have no flag and may work next time.
   */
  get refused(): boolean {
    return (this.cause as { isRetryable?: unknown } | undefined)?.isRetryable === false;
  }

  /** What went wrong, without the action. */
  get reason(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }

  override get message(): string {
    return `${this.action}: ${this.reason}`;
  }
}

/** Runs a fluxer.js call, turning a rejection into a FluxerError. */
export function request<A>(action: string, call: () => Promise<A>): Effect.Effect<A, FluxerError> {
  return Effect.tryPromise({ try: call, catch: (cause) => new FluxerError({ action, cause }) });
}

const isNotFound = (err: unknown): err is FluxerError => err instanceof FluxerError && err.notFound;

/** Turns a 404 into `fallback()`, for things that may already be gone. */
export const orNotFound =
  <B>(fallback: () => B) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, E, R> =>
    Effect.catchIf(self, isNotFound, () => Effect.sync(fallback));

/** The client. */
export class Fluxer extends Context.Service<
  Fluxer,
  {
    readonly client: Client;
    readonly token: Redacted.Redacted<string>;
  }
>()("orianna/Fluxer") {
  /**
   * Reads the token and discovers the instance; the client disconnects when
   * the layer is released. It logs in with {@link login}.
   */
  static readonly layer = Layer.effect(
    Fluxer,
    Effect.gen(function* () {
      const { instance } = yield* AppConfig.current;
      const token = yield* readToken;
      const client = yield* Effect.acquireRelease(
        request(`reaching ${instance}`, () => Client.fromDiscovery(instance)),
        (client) =>
          request("disconnecting", () => client.destroy()).pipe(
            Effect.catch((err) => Effect.logWarning(err.message)),
          ),
      );
      return { client, token };
    }),
  );
}

/** Every non-bot user who reacted to `message` with `emoji`. */
export const reactionUsers = Effect.fnUntraced(function* (message: Message, emoji: string) {
  const userIds: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = yield* request("listing reactions", () =>
      message.fetchReactionUsersPage(emoji, { limit: 100, after }),
    );
    userIds.push(...page.users.filter((u) => !u.bot).map((u) => u.id));
    if (!page.hasMore || !page.nextAfter) return userIds;
    after = page.nextAfter;
  }
});

/** Connects to the gateway. Event handlers should be attached first. */
export const login = Effect.gen(function* () {
  const { client, token } = yield* Fluxer;
  yield* request("logging in", () => client.login(Redacted.value(token)));
});

/**
 * Runs `handle` for each `event` until the scope closes. Each event gets a
 * fiber of its own, and what fails is logged; closing the scope stops
 * listening and interrupts handlers still running.
 */
export const listen = <K extends ClientEventName, E, R>(
  event: K,
  label: string,
  handle: (...args: ClientEvents[K]) => Effect.Effect<void, E, R>,
): Effect.Effect<void, never, Fluxer | Scope.Scope | R> =>
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const run = yield* FiberSet.makeRuntime<R>();
    const listener = (...args: ClientEvents[K]) => {
      run(handle(...args).pipe(Effect.catchCause(logFailure(label))));
    };
    client.on(event, listener);
    yield* Effect.addFinalizer(() => Effect.sync(() => client.off(event, listener)));
  });

/** Logs why `what` failed, unless it was only interrupted by a shutdown. */
export const logFailure =
  (what: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(`${what} failed`, cause);

/**
 * `name#0001`, or the bare username. An instance can make usernames unique
 * instead, and then every discriminator is zeros.
 */
export function tagOf({ username, discriminator }: { username: string; discriminator: string }): string {
  return /^0*$/.test(discriminator) ? username : `${username}#${discriminator}`;
}
