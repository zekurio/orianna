/** An emoji as reported by a reaction event. */
export interface ReactionEmoji {
  id?: string | null;
  name: string | null;
}

/** An emoji from the config or a poll option. */
export interface ParsedEmoji {
  /** How the API refers to it: the Unicode emoji, or `name:id`. */
  api: string;
  /** How it's written in a message. */
  text: string;
  /** Compared with {@link reactionKey}. */
  key: string;
}

/**
 * Reads a Unicode emoji, `name:id` or `<:name:id>`. Animated custom emoji need
 * `<a:name:id>` to animate in message text. Returns undefined for anything
 * else, plain words like `smile` and `:smile:` shortcodes included.
 */
export function parseEmoji(input: string): ParsedEmoji | undefined {
  const value = input.trim();
  const mention = /^<(a?):(\w+):(\d+)>$/.exec(value);
  if (mention) return { api: `${mention[2]}:${mention[3]}`, text: value, key: mention[3]! };

  const custom = /^(\w+):(\d+)$/.exec(value);
  if (custom) return { api: value, text: `<:${custom[1]}:${custom[2]}>`, key: custom[2]! };

  // Every Unicode emoji has a non-ASCII code point; keycaps like 1️⃣ end in U+20E3.
  if (/^[^\s:<>]+$/u.test(value) && /[^\x00-\x7F]/.test(value)) {
    return { api: value, text: value, key: stripVariation(value) };
  }
  return undefined;
}

/**
 * Identifies the emoji of a reaction: the ID of a custom emoji, so renaming it
 * changes nothing, or the Unicode emoji without variation selectors.
 */
export function reactionKey(emoji: ReactionEmoji): string | undefined {
  if (emoji.id) return emoji.id;
  return emoji.name ? stripVariation(emoji.name) : undefined;
}

/** The same key for an emoji written as text. */
export function emojiKey(input: string): string {
  return parseEmoji(input)?.key ?? stripVariation(input);
}

/** How the API refers to a reacted emoji. */
export function apiName(emoji: ReactionEmoji): string | undefined {
  if (!emoji.name) return undefined;
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

function stripVariation(emoji: string): string {
  return emoji.replaceAll("\uFE0F", "");
}
