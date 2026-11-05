import { Effect } from "effect";
import { type CommandGroup, defineCommand, refuse, type UserError } from "../commands/command.ts";
import type { StarboardConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import type { Guilds } from "../guilds.ts";
import { disableStarboard, type StarboardChanges, setStarboard } from "./manage.ts";
import { optIn, optOut } from "./optout.ts";
import { StarboardGuild } from "./starboard.ts";

// `!starboard`, like shinpuru's `/starboard`, with `optout` and `optin` from
// its privacy settings.

/** `!starboard set`, `disable`, `optout` and `optin`. */
export const starboardCommands = Effect.fnUntraced(function* () {
  // Commands only get the services every command gets, so this one comes along.
  const guild = yield* StarboardGuild;
  const withGuild = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, StarboardGuild, guild);
  // The opt-out holds in every guild, so it needs them all.
  const everywhere = yield* Effect.context<Guilds | Database>();

  const set = defineCommand({
    name: "set",
    description: "Change a starboard setting. Setting its channel turns the starboard on.",
    options: [
      {
        name: "setting",
        description:
          "`channel` where starred messages appear, `threshold` of votes a message needs, " +
          "`emoji` members vote with, or `karma` the author gets",
        type: "string",
      },
      {
        name: "value",
        description: "A channel mention or ID, a whole number, or an emoji, depending on the setting",
        type: "string",
      },
    ] as const,
    permission: "starboard.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const changes = yield* starboardChange(ctx.options.setting, ctx.options.value);
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

  const optOutCommand = defineCommand({
    name: "optout",
    description: "Opt-out from starboard, and take down your messages already in it.",
    run: (ctx) =>
      Effect.gen(function* () {
        const removed = yield* optOut(ctx.userId).pipe(Effect.provideContext(everywhere));
        const taken = removed === 0 ? "" : ` Took down ${removed} ${removed === 1 ? "post" : "posts"}.`;
        yield* ctx.reply(`Your messages stay out of the starboard now.${taken} \`optin\` undoes it.`);
      }),
  });

  const optInCommand = defineCommand({
    name: "optin",
    description: "Let your messages into the starboard again.",
    run: (ctx) =>
      Effect.gen(function* () {
        const changed = yield* optIn(ctx.userId).pipe(Effect.provideContext(everywhere));
        yield* ctx.reply(changed ? "Your messages can get into the starboard again." : "You hadn't opted out.");
      }),
  });

  const group: CommandGroup = {
    name: "starboard",
    description: "Set guild starboard settings.",
    subcommands: [optOutCommand, optInCommand, set, disable],
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
    `Emoji: ${config.emoji}\nKarma Gain: \`${config.karma}\``
  );
}

/** What `!starboard set <setting> <value>` changes. */
function starboardChange(setting: string, value: string): Effect.Effect<StarboardChanges, UserError> {
  switch (setting.toLowerCase()) {
    case "channel":
      return channelOf(value).pipe(Effect.map((channelId) => ({ channelId })));
    case "threshold":
      return wholeNumber(setting, value).pipe(Effect.map((threshold) => ({ threshold })));
    case "emoji":
      return Effect.succeed({ emoji: value });
    case "karma":
      return wholeNumber(setting, value).pipe(Effect.map((karma) => ({ karma })));
    default:
      return refuse("The settings are `channel`, `threshold`, `emoji` and `karma`.");
  }
}

function wholeNumber(setting: string, value: string): Effect.Effect<number, UserError> {
  return /^-?\d+$/.test(value) ? Effect.succeed(Number(value)) : refuse(`The ${setting} has to be a whole number.`);
}

/** A channel mention like `<#123>`, or a bare ID. */
function channelOf(input: string): Effect.Effect<string, UserError> {
  const id = /^<#(\d+)>$|^(\d+)$/.exec(input.trim());
  if (id) return Effect.succeed(id[1] ?? id[2]!);
  return refuse(`${input} isn't a channel. Mention it, like #general, or give its ID.`);
}
