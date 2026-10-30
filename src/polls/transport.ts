import type { MessageBody } from "../messages/body.ts";

/** What the poll service needs from the chat platform. */
export interface PollTransport {
  /** Posts a message and returns its id. */
  post(channelId: string, body: MessageBody, options?: PostOptions): Promise<string>;
  /** Mentions in the new body don't notify anyone. */
  edit(channelId: string, messageId: string, body: MessageBody): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ): Promise<void>;
  /** Every non-bot user who reacted with `emoji`. */
  reactionUsers(channelId: string, messageId: string, emoji: string): Promise<string[]>;
}

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
