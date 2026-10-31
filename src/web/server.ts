import type { BunRequest } from "bun";
import { Duration, Effect, FiberSet, Layer, Result } from "effect";
import { HttpEffect } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AppConfig, ConfigError, type WebConfig } from "../config.ts";
import { type FluxerError, logFailure } from "../fluxer.ts";
import { GuildAccess } from "../permissions/rules.ts";
import app from "./app/index.html";
import { FluxerOAuth } from "./fluxer.ts";
import { AuthenticationLive, HandlersLive } from "./handlers.ts";
import { OAuth } from "./oauth.ts";
import { type SignInError, WebRpcs } from "./rpc.ts";
import { randomToken, SESSION_COOKIE, SESSION_TTL, Sessions } from "./sessions.ts";

// The web interface: a React app that Bun bundles from app/index.html, the
// calls it makes at /rpc, and signing in and out. Members sign in with their
// Fluxer account; the session cookie names a row in web_sessions.

/** Holds the state and PKCE verifier while the browser is away signing in. */
const LOGIN_COOKIE = "orianna_login";
const CALLBACK_PATH = "/auth/callback";
/** As long as a code from Fluxer lasts. */
const LOGIN_TTL = Duration.minutes(10);
const PROBLEM = "The bot ran into a problem. Its log says what happened.";

type Services = OAuth | Sessions | GuildAccess;
type Handler = (req: BunRequest) => Effect.Effect<Response, FluxerError, Services>;

/** Serves the web interface when the config file has a `web` section. */
export const WebServer = Layer.unwrap(
  Effect.gen(function* () {
    const { web } = yield* AppConfig.current;
    if (!web) return Layer.empty;
    return serve(web).pipe(
      Layer.provide(Layer.mergeAll(HandlersLive, AuthenticationLive, RpcSerialization.layerNdjson)),
      Layer.provide(Layer.mergeAll(FluxerOAuth(web), Sessions.layer)),
    );
  }),
);

const serve = (web: WebConfig) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      // The compiled bot has the app bundled already. Run from source, Bun bundles
      // it on demand and reloads open pages when a file changes.
      const development = !Bun.isStandaloneExecutable;
      // Requests still running when the bot stops are interrupted.
      const run = yield* FiberSet.makeRuntimePromise<Services>();
      // A call that dies fails on its own instead of taking the connection's other calls with it.
      const rpc = HttpEffect.toWebHandler(yield* RpcServer.toHttpEffect(WebRpcs, { disableFatalDefects: true }));
      const secure = web.publicUrl.startsWith("https:");

      const route = (label: string, handler: Handler) => (req: BunRequest) =>
        run(
          handler(req).pipe(
            Effect.catchCause((cause) =>
              logFailure(label)(cause).pipe(Effect.as(new Response(PROBLEM, { status: 500 }))),
            ),
          ),
        );

      /**
       * Browsers say where a POST comes from. One from another origin is a page
       * elsewhere trying to act for the member, with their cookie.
       */
      const sameOrigin =
        (handler: (req: BunRequest) => Response | Promise<Response>) => (req: BunRequest) =>
          req.headers.get("origin") === web.publicUrl
            ? handler(req)
            : new Response("That request came from another site.", { status: 403 });

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
          const userId = identified.success;
          const joined = yield* Effect.result((yield* GuildAccess).permissionsOf(userId));
          if (Result.isFailure(joined)) {
            if (joined.failure._tag === "UserError") return backToApp("not-member");
            return yield* joined.failure;
          }

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

      // The RPC client posts to /rpc/, with the slash.
      const rpcRoute = { POST: sameOrigin((req) => rpc(req)) };

      const server = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.serve({
              hostname: web.host,
              port: web.port,
              development,
              routes: {
                "/auth/login": { GET: route("starting a sign-in", login) },
                [CALLBACK_PATH]: { GET: route("signing in", callback) },
                "/auth/logout": { POST: sameOrigin(route("signing out", logout)) },
                "/rpc": rpcRoute,
                "/rpc/": rpcRoute,
                // The app routes in the browser, so every other page is the app.
                "/*": app,
              },
              error: () => new Response(PROBLEM, { status: 500 }),
            }),
          catch: (err) =>
            new ConfigError({
              message: `couldn't start the web interface on ${web.host}:${web.port}: ${(err as Error).message}`,
            }),
        }),
        (server) => Effect.promise(() => server.stop(true)),
      );
      yield* Effect.logInfo(`web interface listening on ${server.url.origin}, open it at ${web.publicUrl}`);
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
