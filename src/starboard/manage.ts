import { Effect } from "effect";
import { refuse } from "../commands/command.ts";
import type { StarboardConfig } from "../config.ts";
import { emojiKey, parseEmoji } from "../emoji.ts";
import { Settings } from "../settings/settings.ts";
import { StarboardGuild } from "./starboard.ts";

// Changing the starboard, for `!starboard` and the web interface. It's the
// `starboard` section of the bot settings, so each change is a settings
// change: it's recorded with who made it, and starts the starboard over.

/** What `!starboard set` takes. What's left out stays as it is. */
export interface StarboardChanges {
  readonly channelId?: string;
  readonly threshold?: number;
  readonly emoji?: string;
  readonly karma?: number;
}

/** shinpuru's defaults, for a starboard that was never set. */
const DEFAULTS: StarboardConfig = { threshold: 5, emoji: "⭐", karma: 3 };

/** The starboard as it's set now, the defaults when it never was. */
export const currentStarboard = Settings.current.pipe(Effect.map((s) => s.starboard ?? DEFAULTS));

/** Checks the changes against the guild, and returns them cleaned up. */
const check = Effect.fnUntraced(function* (changes: StarboardChanges) {
  const guild = yield* StarboardGuild;
  const checked: { -readonly [K in keyof StarboardChanges]: StarboardChanges[K] } = {};
  if (changes.channelId !== undefined) {
    const channel = yield* guild.channel(changes.channelId);
    if (!channel) return yield* refuse(`There's no channel \`${changes.channelId}\` in this server.`);
    if (!channel.text) return yield* refuse(`<#${channel.id}> doesn't take messages, so the starboard can't go there.`);
    checked.channelId = channel.id;
  }
  if (changes.threshold !== undefined) {
    if (!Number.isInteger(changes.threshold) || changes.threshold < 1) {
      return yield* refuse("The threshold has to be a whole number, 1 or more.");
    }
    checked.threshold = changes.threshold;
  }
  if (changes.emoji !== undefined) {
    const emoji = changes.emoji.trim();
    if (!parseEmoji(emoji)) {
      return yield* refuse(`${emoji} isn't an emoji. Use a Unicode emoji or a custom one like <:name:id>.`);
    }
    checked.emoji = emoji;
  }
  if (changes.karma !== undefined) {
    if (!Number.isInteger(changes.karma) || changes.karma < 0) {
      return yield* refuse("The karma gain has to be a whole number, 0 or more.");
    }
    checked.karma = changes.karma;
  }
  // The settings refuse it too, but this says what to do about it.
  const emoji = checked.emoji ?? (yield* currentStarboard).emoji;
  const karma = (yield* Settings.current).karma;
  if (karma && [...karma.upvotes, ...karma.downvotes].some((e) => emojiKey(e) === emojiKey(emoji))) {
    return yield* refuse(
      `${emoji} is a karma emoji, so it can't star messages too. Pick another emoji, or take it out of karma first.`,
    );
  }
  return checked;
});

/** Stores the starboard `change` makes of the current one, and returns it. */
const save = Effect.fnUntraced(function* (userId: string, change: (current: StarboardConfig) => StarboardConfig) {
  const settings = yield* Settings;
  yield* settings
    .update(
      (current) => Effect.succeed({ ...current, starboard: change(current.starboard ?? DEFAULTS) }),
      userId,
    )
    .pipe(
      // check() covers what members can get wrong, so this is down to the settings as a whole.
      Effect.catchTag("InvalidSettings", (err) =>
        refuse(`The settings would be invalid, so nothing changed:\n${err.problems.join("\n")}`),
      ),
    );
  return yield* currentStarboard;
});

/** Sets what `changes` has, like shinpuru's `/starboard set`. */
export const setStarboard = Effect.fnUntraced(function* (changes: StarboardChanges, userId: string) {
  const checked = yield* check(changes);
  return yield* save(userId, (current) => ({ ...current, ...checked }));
});

/** Turns the starboard off by forgetting its channel; the rest stays for next time. */
export const disableStarboard = (userId: string) =>
  save(userId, ({ channelId: _channelId, ...rest }) => rest);
