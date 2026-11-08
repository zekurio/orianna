import { emojiList } from "./emojiList.ts" with { type: "macro" };
import type { EmojiCategory } from "./rpc.ts";

// The Unicode emoji the web interface's picker offers, named the way Fluxer
// names them. Fluxer's API doesn't list them; its client ships its own list
// with the JoyPixels shortcodes, like `:star:` and `:grinning:`, which
// Emojibase has too. The list is made from Emojibase's when the bot is built.

/** As one string, which takes a fraction of the memory the objects would. */
const LIST = emojiList();

/** Read for each picker that asks, which is rare, rather than kept around. */
export function unicodeEmoji(): EmojiCategory[] {
  return JSON.parse(LIST);
}
