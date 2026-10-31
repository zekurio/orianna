import { Context, type Effect } from "effect";
import type { FluxerError } from "../fluxer.ts";

/**
 * Signing in with a Fluxer account, through the bot's application and the
 * OAuth2 authorization code grant with PKCE. web/fluxer.ts talks to Fluxer.
 */
export class OAuth extends Context.Service<
  OAuth,
  {
    /**
     * Where to send the browser to sign in. Fluxer sends it back to
     * `/auth/callback` with `state` and a code.
     */
    readonly authorizeUrl: (state: string, codeChallenge: string) => string;
    /** Redeems the code from the callback and returns the ID of the user who signed in. */
    readonly identify: (code: string, codeVerifier: string) => Effect.Effect<string, FluxerError>;
  }
>()("orianna/OAuth") {}
