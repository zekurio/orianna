import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { EmojiCategory, UnicodeEmoji } from "../rpc.ts";
import { Api } from "./api.ts";

// The Unicode emoji for the picker come from the bot, which names them the
// way Fluxer does. They're drawn the way Fluxer draws them too.

/** The categories once they've loaded; empty when they couldn't be. */
export function useUnicodeEmojis(): readonly EmojiCategory[] | undefined {
  // They never change while the bot runs, so they're kept for the visit.
  const result = useAtomValue(Api.query("unicodeEmoji", undefined, { timeToLive: "1 hour" }));
  return AsyncResult.matchWithError(result, {
    onInitial: () => undefined,
    // The server's own emoji are still there to pick from.
    onError: () => [],
    onDefect: () => [],
    onSuccess: ({ value }) => value,
  });
}

/**
 * The picture of a Unicode emoji, as Fluxer draws it: Twemoji, named by its
 * code points in hex. Like Twemoji, it leaves out the variation selector
 * U+FE0F unless the emoji joins several with U+200D.
 */
export function emojiImage(base: string, unicode: string): string {
  const points = [...unicode].map((char) => char.codePointAt(0)!);
  const kept = points.includes(0x200d) ? points : points.filter((point) => point !== 0xfe0f);
  return `${base}/${kept.map((point) => point.toString(16)).join("-")}.svg`;
}

/** The emoji with this text, variation selectors aside. */
export function findUnicodeEmoji(categories: readonly EmojiCategory[], text: string): UnicodeEmoji | undefined {
  const bare = text.replaceAll("️", "");
  for (const { emojis } of categories) {
    const found = emojis.find((emoji) => emoji.unicode.replaceAll("️", "") === bare);
    if (found) return found;
  }
  return undefined;
}
