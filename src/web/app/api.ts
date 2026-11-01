import { Cause, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { WebRpcs } from "../rpc.ts";

/** The calls in rpc.ts, as atoms, like `Api.query("session", undefined)`. */
export class Api extends AtomRpc.Service<Api>()("orianna/web/Api", {
  group: WebRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: `${window.location.origin}/rpc` }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
  ),
}) {}

/** Everything shown of the starboard, refreshed when it's set differently. */
export const STARBOARD_KEYS = ["starboard"];

/**
 * What a failed call says to the member: the message of a refusal, or that
 * something went wrong.
 */
export function failureMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause) as { _tag?: string; message?: string };
  return failure._tag === "Refused" && failure.message ? failure.message : "That didn't work. Try again in a moment.";
}
