import type { BunRequest, Server } from "bun";
import { Context, Duration, Effect, FiberSet, Layer, Result } from "effect";
import { HttpEffect } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AppConfig, ConfigError, type WebConfig } from "../config.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { millis, tagLogs } from "../log.ts";
import app from "./app/index.html";
import { appRoutes } from "./assets.ts";
import { FluxerOAuth } from "./fluxer.ts";
import { AuthenticationLive, CallLogLive, HandlersLive } from "./handlers.ts";
import { OAuth } from "./oauth.ts";
import { type SignInError, WebRpcs } from "./rpc.ts";
import { randomToken, SESSION_COOKIE, SESSION_TTL, Sessions } from "./sessions.ts";

// The web interface: a React app that Bun bundles from app/index.html, the
// calls it makes at /rpc, and signing in and out. Members sign in with their
// Fluxer account; the session cookie names a row in web_sessions. The
// requests the bot answers itself are logged; the app's pages and scripts
// are served without telling.
//
// It listens as soon as the config file is read, while the bot still opens
// the database and reaches Fluxer, so a browser gets the app straight away
// after a restart instead of a refused connection. Requests the bot has to
// answer itself wait until WebServer is built and hands them its handlers.

/** Holds the state and PKCE verifier while the browser is away signing in. */
const LOGIN_COOKIE = "orianna_login";
const CALLBACK_PATH = "/auth/callback";
/** As long as a code from Fluxer lasts. */
const LOGIN_TTL = Duration.minutes(10);
const PROBLEM = "The bot ran into a problem. Its log says what happened.";
const STARTING = "The bot is still starting. Try again in a moment.";
/** How long a request waits for the bot to finish starting. */
const STARTUP_WAIT_MS = 30_000;

type Services = OAuth | Sessions;
type Handler = (req: BunRequest) => Effect.Effect<Response, FluxerError, Services>;

/** What WebServer answers once it's built, by route. */
type Routes = Record<"login" | "callback" | "logout" | "rpc", (req: BunRequest) => Promise<Response>>;

/** The web interface's server, listening from the start, waiting for the routes the bot answers. */
export class WebListener extends Context.Service<
  WebListener,
  {
    /** Starts answering the requests that waited, and every one after. */
    readonly open: (routes: Routes) => void;
    /** Stops listening, before the services the routes use go away. */
    readonly close: Effect.Effect<void>;
  }
>()("orianna/WebListener") {
  /** Listens when the config file has a `web` section, and otherwise does nothing. */
  static readonly layer = Layer.effect(
    WebListener,
    Effect.gen(function* () {
      const { web } = yield* AppConfig.current;
      if (!web) return { open: () => {}, close: Effect.void };
      return yield* listen(web);
    }),
  );
}

const listen = Effect.fnUntraced(function* (web: WebConfig) {
  // The compiled bot has the app bundled already, and serves it compressed.
  // Run from source, Bun bundles it on demand and reloads open pages when a
  // file changes.
  const development = !Bun.isStandaloneExecutable;
  const bundled = development ? undefined : yield* Effect.promise(() => appRoutes(app));
  let routes: Routes | undefined;
  const ready = Promise.withResolvers<Routes>();
  const later =
    (route: keyof Routes) =>
    (req: BunRequest): Promise<Response> =>
      routes
        ? routes[route](req)
        : Promise.race([
            ready.promise.then((routes) => routes[route](req)),
            Bun.sleep(STARTUP_WAIT_MS).then(
              () => new Response(STARTING, { status: 503, headers: { "Retry-After": "5" } }),
            ),
          ]);
  // The RPC client posts to /rpc/, with the slash.
  const rpcRoute = { POST: later("rpc") };

  const server: Server<undefined> = yield* Effect.try({
    try: () =>
      Bun.serve({
        hostname: web.host,
        port: web.port,
        development,
        routes: {
          ...bundled?.files,
          "/auth/login": { GET: later("login") },
          [CALLBACK_PATH]: { GET: later("callback") },
          "/auth/logout": { POST: later("logout") },
          "/rpc": rpcRoute,
          "/rpc/": rpcRoute,
          // The app routes in the browser, so every other page is the app.
          "/*": bundled?.page ?? app,
        },
        error: () => new Response(PROBLEM, { status: 500 }),
      }),
    catch: (err) =>
      new ConfigError({
        message: `couldn't start the web interface on ${web.host}:${web.port}: ${(err as Error).message}`,
      }),
  });
  let stopped = false;
  const close = Effect.promise(async () => {
    if (stopped) return;
    stopped = true;
    await server.stop(true);
  });
  yield* Effect.addFinalizer(() => close);
  // Not before listening, which is what the bot starts with.
  void bundled?.compress();
  yield* Effect.logInfo(`web interface listening on ${server.url.origin}, open it at ${web.publicUrl}`).pipe(
    tagLogs("http"),
  );
  return {
    open: (answer: Routes) => {
      routes = answer;
      ready.resolve(answer);
    },
    close,
  };
});

/** Answers the web interface's requests when the config file has a `web` section. */
export const WebServer = Layer.unwrap(
  Effect.gen(function* () {
    const { web } = yield* AppConfig.current;
    if (!web) return Layer.empty;
    return serve(web).pipe(
      Layer.provide(Layer.mergeAll(HandlersLive, AuthenticationLive, CallLogLive, RpcSerialization.layerNdjson)),
      Layer.provide(Layer.mergeAll(FluxerOAuth(web), Sessions.layer)),
    );
  }),
);

const serve = (web: WebConfig) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      // Requests still running when the bot stops are interrupted.
      const run = yield* FiberSet.makeRuntimePromise<Services>();
      // A call that dies fails on its own instead of taking the connection's other calls with it.
      const rpc = HttpEffect.toWebHandler(yield* RpcServer.toHttpEffect(WebRpcs, { disableFatalDefects: true }));
      const secure = web.publicUrl.startsWith("https:");

      /**
       * Answers with `handler`, or a 500 when it fails, and logs the answer and
       * how long it took at `level`.
       */
      const route =
        (label: string, handler: Handler, level: "Info" | "Debug" = "Info") =>
        (req: BunRequest) =>
          run(
            handler(req).pipe(
              Effect.catchCause((cause) =>
                logFailure(label)(cause).pipe(Effect.as(new Response(PROBLEM, { status: 500 }))),
              ),
              Effect.timed,
              Effect.flatMap(([duration, res]) =>
                Effect.logWithLevel(level)(
                  `${req.method} ${new URL(req.url).pathname} ${res.status} ${millis(duration)}`,
                ).pipe(Effect.as(res)),
              ),
              tagLogs("http"),
            ),
          );

      /**
       * Browsers say where a POST comes from. One from another origin is a page
       * elsewhere trying to act for the member, with their cookie.
       */
      const sameOrigin =
        (handler: Handler): Handler =>
        (req) =>
          req.headers.get("origin") === web.publicUrl
            ? handler(req)
            : Effect.succeed(new Response("That request came from another site.", { status: 403 }));

      const login: Handler = (req) =>
        Effect.gen(function* () {
          const state = randomToken();
          const verifier = randomToken();
          req.cookies.set(LOGIN_COOKIE, `${state}.${verifier}`, {
            path: CALLBACK_PATH,
            maxAge: Duration.toSeconds(LOGIN_TTL),
            httpOnly: true,
            secure,
            sameSite: "lax",
          });
          return redirect((yield* OAuth).authorizeUrl(state, challengeOf(verifier)));
        });

      const callback: Handler = (req) =>
        Effect.gen(function* () {
          const params = new URL(req.url).searchParams;
          const [state, verifier] = req.cookies.get(LOGIN_COOKIE)?.split(".") ?? [];
          req.cookies.delete(LOGIN_COOKIE, { path: CALLBACK_PATH });

          const error = params.get("error");
          if (error === "access_denied") return backToApp("denied");
          if (error) {
            yield* Effect.logWarning(`signing in to the web interface failed: Fluxer said ${error}`);
            return backToApp("failed");
          }
          const code = params.get("code");
          // A missing cookie means the sign-in took too long, or started in another browser.
          if (!code || !state || !verifier || params.get("state") !== state) return backToApp("expired");

          const identified = yield* Effect.result((yield* OAuth).identify(code, verifier));
          if (Result.isFailure(identified)) {
            yield* Effect.logWarning(`signing in to the web interface failed: ${identified.failure.message}`);
            return backToApp("failed");
          }
          // Anyone may sign in; the app shows the guilds they share with the bot.
          const userId = identified.success;

          const token = yield* (yield* Sessions).create(userId);
          req.cookies.set(SESSION_COOKIE, token, {
            path: "/",
            maxAge: Duration.toSeconds(SESSION_TTL),
            httpOnly: true,
            secure,
            sameSite: "lax",
          });
          return redirect("/");
        });

      const logout: Handler = (req) =>
        Effect.gen(function* () {
          const token = req.cookies.get(SESSION_COOKIE);
          if (token) yield* (yield* Sessions).remove(token);
          req.cookies.delete(SESSION_COOKIE);
          return new Response(null, { status: 204 });
        });

      // Each call in a request is logged on its own, so the request is only
      // logged at `debug`.
      const listener = yield* WebListener;
      // Requests still coming in once the bot stops get no answer, rather
      // than one from services that are gone.
      yield* Effect.addFinalizer(() => listener.close);
      listener.open({
        login: route("starting a sign-in", login),
        callback: route("signing in", callback),
        logout: route("signing out", sameOrigin(logout)),
        rpc: route("answering the app", sameOrigin((req) => Effect.promise(() => rpc(req))), "Debug"),
      });
    }),
  );

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function backToApp(error: SignInError): Response {
  return redirect(`/?error=${error}`);
}

/** The PKCE S256 challenge for `verifier`. */
function challengeOf(verifier: string): string {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
}
