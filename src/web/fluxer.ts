import { Effect, Layer, Redacted, Schema } from "effect";
import { readClientSecret, type WebConfig } from "../config.ts";
import { Fluxer, FluxerError, request } from "../fluxer.ts";
import { OAuth } from "./oauth.ts";

const TIMEOUT_MS = 15_000;

const Token = Schema.Struct({ access_token: Schema.String });
const UserInfo = Schema.Struct({ id: Schema.String });

/**
 * Signs members in through the instance's OAuth2 routes. Only the user's ID
 * is kept; the access token is thrown away once it has been used for that.
 */
export const FluxerOAuth = (web: WebConfig) =>
  Layer.effect(
    OAuth,
    Effect.gen(function* () {
      const { client } = yield* Fluxer;
      const secret = yield* readClientSecret;
      const base = `${client.instance.endpoints.api_public}/v1/oauth2`;
      const redirectUri = `${web.publicUrl}/auth/callback`;

      const call = <S extends Schema.Decoder<unknown>>(action: string, schema: S, url: string, init: RequestInit) =>
        request(action, () => fetchJson(url, init)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError((cause) => (cause instanceof FluxerError ? cause : new FluxerError({ action, cause }))),
        );

      return {
        authorizeUrl: (state, codeChallenge) =>
          `${base}/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: web.clientId,
            redirect_uri: redirectUri,
            scope: "identify",
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
          })}`,

        identify: Effect.fn("OAuth.identify")(function* (code: string, codeVerifier: string) {
          const { access_token } = yield* call("redeeming a sign-in code", Token, `${base}/token`, {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
              client_id: web.clientId,
              client_secret: Redacted.value(secret),
            }),
          });
          const user = yield* call("fetching the signed-in user", UserInfo, `${base}/userinfo`, {
            headers: { Authorization: `Bearer ${access_token}` },
          });
          return user.id;
        }),
      };
    }),
  );

/**
 * Fetches JSON, throwing on an error status with what Fluxer said: the OAuth2
 * routes answer with `error_description`, the others with `message`.
 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return body;

  const { error_description, message } = (body ?? {}) as { error_description?: unknown; message?: unknown };
  const reason = [error_description, message].find((s) => typeof s === "string") ?? `HTTP ${response.status}`;
  throw Object.assign(new Error(String(reason)), { statusCode: response.status });
}
