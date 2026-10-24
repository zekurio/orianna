import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";

// Poll names like `devoted-monkey`: short, easy to say, and easy to type in a
// command. About 1200 adjectives × 355 animals, so collisions are rare, but the
// generator doesn't track what it handed out; `pickSlug` makes them unique.

export function randomSlug(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
    style: "lowerCase",
  });
}

/** Slugs are matched case-insensitively and with surrounding `#` or spaces ignored. */
export function normalizeSlug(input: string): string {
  return input.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Picks a slug that `taken` doesn't know yet. Once random picks keep
 * colliding, a number is appended (`devoted-monkey-2`) so this always ends.
 */
export function pickSlug(taken: (slug: string) => boolean, generate = randomSlug): string {
  for (let i = 0; i < 32; i++) {
    const slug = generate();
    if (!taken(slug)) return slug;
  }
  const base = generate();
  for (let n = 2; ; n++) {
    const slug = `${base}-${n}`;
    if (!taken(slug)) return slug;
  }
}
