import { Layer } from "effect";
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
