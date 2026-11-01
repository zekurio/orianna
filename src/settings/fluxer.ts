import { Effect, Layer } from "effect";
import { Fluxer, request } from "../fluxer.ts";
import { CurrentGuild } from "../guild.ts";
import { SettingsGuild } from "./settings.ts";

/** The guild's channels through fluxer.js, for checking the settings. */
export const FluxerSettingsGuild = Layer.effect(
  SettingsGuild,
  Effect.gen(function* () {
    const { client } = yield* Fluxer;
    const { id: guildId } = yield* CurrentGuild;
    return {
      channel: (channelId) =>
        request("fetching a channel", () => client.channels.resolve(channelId)).pipe(
          Effect.map((c) => (c.isGuild() && c.guildId === guildId ? { text: c.isTextBased() } : null)),
          // A channel the bot can't see, or an ID that isn't one, is as good as missing.
          Effect.catchIf((err) => err.notFound || err.refused, () => Effect.succeed(null)),
        ),
    };
  }),
);
