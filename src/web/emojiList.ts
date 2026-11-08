import emojis from "emojibase-data/en/compact.json";
import shortcodes from "emojibase-data/en/shortcodes/joypixels.json";
import type { EmojiCategory, UnicodeEmoji } from "./rpc.ts";

// A macro: src/web/emoji.ts imports it `with { type: "macro" }`, so it runs
// when the bot is bundled, or loaded from source, and only its answer ends
// up in the bot. Emojibase's data, most of a megabyte, stays out.

/** Fluxer's categories, in its order, by the Emojibase groups they hold. */
const CATEGORIES: { label: string; groups: number[] }[] = [
  { label: "People", groups: [0, 1] },
  { label: "Nature", groups: [3] },
  { label: "Food", groups: [4] },
  { label: "Activities", groups: [6] },
  { label: "Travel", groups: [5] },
  { label: "Objects", groups: [7] },
  { label: "Symbols", groups: [8] },
  { label: "Flags", groups: [9] },
];

/**
 * The picker's emoji, as JSON. The emoji themselves are escaped, like
 * `\ud83d\ude00`, which keeps the string to a byte a character in memory.
 */
export function emojiList(): string {
  const byGroup = new Map<number, { emoji: UnicodeEmoji; order: number }[]>();
  for (const emoji of emojis) {
    const codes = shortcodes[emoji.hexcode];
    // Emoji without a JoyPixels name are mostly too new for Fluxer.
    if (emoji.group === undefined || !codes) continue;
    const names = Array.isArray(codes) ? codes : [codes];
    const terms = [...new Set([...names, emoji.label, ...(emoji.tags ?? [])].map((term) => term.toLowerCase()))];
    const list = byGroup.get(emoji.group) ?? [];
    list.push({ emoji: { unicode: emoji.unicode, name: names[0]!, terms }, order: emoji.order ?? 0 });
    byGroup.set(emoji.group, list);
  }
  const categories: EmojiCategory[] = CATEGORIES.map(({ label, groups }) => ({
    label,
    emojis: groups
      .flatMap((group) => byGroup.get(group) ?? [])
      .sort((a, b) => a.order - b.order)
      .map(({ emoji }) => emoji),
  }));
  return JSON.stringify(categories).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
