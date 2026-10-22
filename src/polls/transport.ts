/** What the poll service needs from the chat platform. */
export interface PollTransport {
  /** Posts a message and returns its id. */
  post(channelId: string, content: string, files?: PollFile[]): Promise<string>;
  edit(channelId: string, messageId: string, content: string): Promise<void>;
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

export interface PollFile {
  name: string;
  data: Uint8Array;
}
