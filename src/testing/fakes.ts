import type { GuildAccess } from "../permissions.ts";
import type { PollFile, PollTransport } from "../polls/transport.ts";

/** In-memory chat platform for poll tests. */
export class FakeTransport implements PollTransport {
  private nextId = 1000;
  readonly messages = new Map<
    string,
    { channelId: string; content: string; files?: PollFile[]; reactions: Map<string, Set<string>> }
  >();
  readonly removed: { emoji: string; userId: string }[] = [];
  failPost = false;

  async post(channelId: string, content: string, files?: PollFile[]) {
    if (this.failPost) throw new Error("post failed");
    const id = String(this.nextId++);
    this.messages.set(id, { channelId, content, files, reactions: new Map() });
    return id;
  }

  async edit(_channelId: string, messageId: string, content: string) {
    this.message(messageId).content = content;
  }

  async react(_channelId: string, messageId: string, emoji: string) {
    this.addReaction(messageId, emoji, "bot");
  }

  async removeReaction(_channelId: string, messageId: string, emoji: string, userId: string) {
    this.removed.push({ emoji, userId });
    this.message(messageId).reactions.get(emoji)?.delete(userId);
  }

  async reactionUsers(_channelId: string, messageId: string, emoji: string) {
    return [...(this.message(messageId).reactions.get(emoji) ?? [])].filter((u) => u !== "bot");
  }

  /** Simulates a user reacting, without notifying the service. */
  addReaction(messageId: string, emoji: string, userId: string) {
    const reactions = this.message(messageId).reactions;
    reactions.set(emoji, (reactions.get(emoji) ?? new Set()).add(userId));
  }

  message(id: string) {
    const message = this.messages.get(id);
    if (!message) throw new Error(`no message ${id}`);
    return message;
  }
}

export class FakeAccess implements GuildAccess {
  admins = new Set<string>();
  roles = new Map<string, string[]>();

  async isAdmin(userId: string) {
    return this.admins.has(userId);
  }

  async hasAnyRole(userId: string, roleIds: readonly string[]) {
    return (this.roles.get(userId) ?? []).some((r) => roleIds.includes(r));
  }
}

export class FakeClock {
  constructor(public time = Date.UTC(2026, 9, 1)) {}
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}

/** Smallest valid PNG header plus padding, enough for format sniffing. */
export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
