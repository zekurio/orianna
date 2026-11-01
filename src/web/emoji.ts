import emojis from "emojibase-data/en/compact.json";
import shortcodes from "emojibase-data/en/shortcodes/joypixels.json";
import type { EmojiCategory, UnicodeEmoji } from "./rpc.ts";

// The Unicode emoji the web interface's picker offers, named the way Fluxer
// names them. Fluxer's API doesn't list them; its client ships its own list
// with the JoyPixels shortcodes, like `:star:` and `:grinning:`, which
// Emojibase has too.

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

let built: EmojiCategory[] | undefined;

/** Built the first time a picker asks. */
export function unicodeEmoji(): EmojiCategory[] {
  built ??= build();
  return built;
}

function build(): EmojiCategory[] {
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
  return CATEGORIES.map(({ label, groups }) => ({
    label,
    emojis: groups
      .flatMap((group) => byGroup.get(group) ?? [])
      .sort((a, b) => a.order - b.order)
      .map(({ emoji }) => emoji),
  }));
}
