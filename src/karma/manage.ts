import { Effect } from "effect";
import { refuse } from "../commands/command.ts";
import { KARMA_DEFAULTS, type KarmaConfig } from "../config.ts";
import { Settings } from "../settings/settings.ts";

// Changing karma, for `!karma` and the web interface. It's the `karma`
// section of the bot settings, so each change is a settings change: it's
// recorded with who made it.

/** Karma as it's set now, the defaults while it's off. */
export const currentKarma = Settings.current.pipe(Effect.map((s) => s.karma ?? KARMA_DEFAULTS));

/**
 * Stores what `change` makes of karma as it's set now, nothing while it's
 * off, and returns it. The settings check it, and fail with what's wrong.
 */
export const changeKarma = Effect.fnUntraced(function* <E>(
  change: (current: KarmaConfig | undefined) => Effect.Effect<unknown, E>,
  userId: string,
) {
  yield* (yield* Settings).update(
    (current) => change(current.karma).pipe(Effect.map((karma) => ({ ...current, karma }))),
    userId,
  );
  return yield* currentKarma;
});

/** Turns karma on with `config`, or replaces it, like the web interface's form. */
export const setKarma = (config: unknown, userId: string) => changeKarma(() => Effect.succeed(config), userId);

/** Turns karma off. The karma members have stays for when it's back on. */
export const disableKarma = Effect.fnUntraced(function* (userId: string) {
  yield* (yield* Settings).update(({ karma: _karma, ...rest }) => Effect.succeed(rest), userId).pipe(
    // Nothing else refers to karma, so this is down to the settings as a whole.
    Effect.catchTag("InvalidSettings", (err) =>
      refuse(`The settings would be invalid, so nothing changed:\n${err.problems.join("\n")}`),
    ),
  );
});
