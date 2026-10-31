import { Effect } from "effect";
import { type CommandGroup, defineCommand, refuse } from "../commands/command.ts";
import type { StarboardConfig } from "../config.ts";
import { disableStarboard, type StarboardChanges, setStarboard } from "./manage.ts";
import { type Starboard, StarboardGuild } from "./starboard.ts";

// `!starboard`, like shinpuru's `/starboard`, with `optout` and `optin` from
// its privacy settings.

/** `!starboard set`, `disable`, `optout` and `optin`. */
export const starboardCommands = Effect.fnUntraced(function* (starboard: Starboard) {
  // Commands only get the services every command gets, so this one comes along.
  const guild = yield* StarboardGuild;
  const withGuild = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, StarboardGuild, guild);

  const set = defineCommand({
    name: "set",
    description: "Set starboard settings.",
    options: [
      {
        name: "channel",
        description: "The channel where the starboard messages will appear.",
        type: "string",
        required: false,
        named: true,
      },
      {
        name: "threshold",
        description: "The minimum number of emoji votes until a message gets into the starboard.",
        type: "integer",
        required: false,
        named: true,
      },
      {
        name: "emoji",
        description: "The emoji to be used for starring messages.",
        type: "string",
        required: false,
        named: true,
      },
    ] as const,
    permission: "starboard.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const { channel, threshold, emoji } = ctx.options;
        const changes: StarboardChanges = {
          ...(channel !== undefined && { channelId: yield* channelOf(channel) }),
          ...(threshold !== undefined && { threshold }),
          ...(emoji !== undefined && { emoji }),
        };
        yield* ctx.reply({ embeds: [{ description: describe(yield* setStarboard(changes, ctx.userId)) }] });
      }).pipe(withGuild),
  });

  const disable = defineCommand({
    name: "disable",
    description: "Disable the starboard.",
    permission: "starboard.config",
    run: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.reply({ embeds: [{ description: describe(yield* disableStarboard(ctx.userId)) }] });
      }),
  });

  const optOut = defineCommand({
    name: "optout",
    description: "Opt-out from starboard, and take down your messages already in it.",
    run: (ctx) =>
      Effect.gen(function* () {
        const removed = yield* starboard.optOut(ctx.userId);
        const taken = removed === 0 ? "" : ` Took down ${removed} ${removed === 1 ? "post" : "posts"}.`;
        yield* ctx.reply(`Your messages stay out of the starboard now.${taken} \`optin\` undoes it.`);
      }),
  });

  const optIn = defineCommand({
    name: "optin",
    description: "Let your messages into the starboard again.",
    run: (ctx) =>
      Effect.gen(function* () {
        const changed = yield* starboard.optIn(ctx.userId);
        yield* ctx.reply(changed ? "Your messages can get into the starboard again." : "You hadn't opted out.");
      }),
  });

  const group: CommandGroup = {
    name: "starboard",
    description: "Set guild starboard settings.",
    subcommands: [set, disable, optOut, optIn],
  };
  return group;
});

/** shinpuru's reply to `/starboard set` and `disable`. */
export function describe(config: StarboardConfig): string {
  if (config.channelId === undefined) {
    return "Starboard disabled. Set a channel as starboard channel to enable the starboard.";
  }
  return (
    `Set starboard config:\n\nChannel: <#${config.channelId}>\nThreshold: \`${config.threshold}\`\n` +
    `Emoji: ${config.emoji}`
  );
}

/** A channel mention like `<#123>`, or a bare ID. */
function channelOf(input: string) {
  const id = /^<#(\d+)>$|^(\d+)$/.exec(input.trim());
  if (id) return Effect.succeed(id[1] ?? id[2]!);
  return refuse(`${input} isn't a channel. Mention it, like #general, or give its ID.`);
}
