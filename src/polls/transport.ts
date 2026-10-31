import { Context, type Effect } from "effect";
import type { FluxerError } from "../fluxer.ts";
import type { MessageBody } from "../messages/body.ts";

/** What the poll service needs from the chat platform. */
export class PollTransport extends Context.Service<
  PollTransport,
  {
    /** Posts a message and returns its id. */
    readonly post: (
      channelId: string,
      body: MessageBody,
      options?: PostOptions,
    ) => Effect.Effect<string, FluxerError>;
    /** Mentions in the new body don't notify anyone. */
    readonly edit: (channelId: string, messageId: string, body: MessageBody) => Effect.Effect<void, FluxerError>;
    readonly react: (channelId: string, messageId: string, emoji: string) => Effect.Effect<void, FluxerError>;
    readonly removeReaction: (
      channelId: string,
      messageId: string,
      emoji: string,
      userId: string,
    ) => Effect.Effect<void, FluxerError>;
    /** Every non-bot user who reacted with `emoji`. */
    readonly reactionUsers: (
      channelId: string,
      messageId: string,
      emoji: string,
    ) => Effect.Effect<string[], FluxerError>;
  }
>()("orianna/PollTransport") {}

export interface PostOptions {
  files?: PollFile[];
  /**
   * Let `@everyone` and `@here` in the message notify people. Mentions of
   * users and roles never do. Off unless asked for.
   */
  everyone?: boolean;
}

export interface PollFile {
  name: string;
  data: Uint8Array;
}
