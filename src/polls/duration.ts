export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Weeks are the largest unit, so `m` can only mean minutes. */
const UNITS: Record<string, number> = { m: MINUTE, h: HOUR, d: DAY, w: WEEK };

const PART = /(\d+(?:\.\d+)?)([a-z]+)/gi;

/**
 * Whether a word is meant as a duration, known units or not: `3h` and `1d12h`,
 * but also `1y`, so it can be refused instead of read as something else.
 */
export function looksLikeDuration(word: string): boolean {
  return /^(?:\d+(?:\.\d+)?[a-z]+)+$/i.test(word);
}

/**
 * Reads `30m`, `3h`, `3d`, `1w` or a mix like `1d12h` into milliseconds.
 * Returns undefined for anything else, `1y` and `2mo` included.
 */
export function parseDuration(word: string): number | undefined {
  if (!looksLikeDuration(word)) return undefined;
  let ms = 0;
  for (const [, amount, unit] of word.matchAll(PART)) {
    const size = UNITS[unit!.toLowerCase()];
    if (!size) return undefined;
    ms += Number(amount) * size;
  }
  return ms;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
