import { Effect } from "effect";
import { type CommandGroup, defineCommand, memberId, refuse, type UserError } from "../commands/command.ts";
import { KARMA_DEFAULTS, type KarmaConfig, type KarmaRule } from "../config.ts";
import { emojiKey, parseEmoji } from "../emoji.ts";
import { ACCENT, type MessageBody } from "../messages/body.ts";
import { RoleGuild } from "../roles/menus.ts";
import { Settings } from "../settings/settings.ts";
import { Karma, KarmaGuild } from "./karma.ts";
import { changeKarma, currentKarma, disableKarma } from "./manage.ts";

// `!karma`, like shinpuru's `/karma` without its global karma, and what the
// web interface's karma settings do: `settings`, `set`, `disable`, `block`,
// `unblock`, `addrule` and `removerule`.

/** As many as shinpuru's scoreboard shows. */
export const SCOREBOARD_SIZE = 20;

const OFF = "Karma is off in this server.";

/** For those who may turn it on. */
const OFF_FOR_CONFIG = `${OFF} \`karma set\` turns it on.`;

/** A role mention like `<@&123>`, or a bare ID. */
const ROLE = /^(?:<@&(\d+)>|(\d+))$/;

/** How much of a rule's DM the settings show. */
const MAX_SHOWN = 80;

/** `!karma` and its subcommands, with the karma they were made for. Built while karma is off too, so `set` can turn it on. */
export const karmaCommands = Effect.fnUntraced(function* () {
  // Commands only get the services every command gets, so these come along.
  const karma = yield* Karma;
  const guild = yield* KarmaGuild;
  const roles = yield* RoleGuild;

  /**
   * Stores what `change` makes of karma as it's set now. While karma is off,
   * `change` gets nothing, and only `set` turns it on.
   */
  const save = (userId: string, change: (current: KarmaConfig | undefined) => Effect.Effect<KarmaConfig, UserError>) =>
    changeKarma(change, userId).pipe(
      // The commands check what members can get wrong, so this is down to the settings as a whole.
      Effect.catchTag("InvalidSettings", (err) =>
        refuse(`The settings would be invalid, so nothing changed:\n${err.problems.join("\n")}`),
      ),
    );
  const whileOn = (current: KarmaConfig | undefined): Effect.Effect<KarmaConfig, UserError> =>
    current ? Effect.succeed(current) : refuse(OFF_FOR_CONFIG);

  const show = defineCommand({
    name: "karma",
    description: "Show your karma and the server's scoreboard, or another member's karma.",
    options: [
      {
        name: "member",
        description: "A mention or user ID, to show their karma instead",
        type: "string",
        required: false,
      },
    ] as const,
    run: (ctx) =>
      Effect.gen(function* () {
        if (!(yield* Settings.current).karma) return yield* refuse(OFF);
        if (ctx.options.member !== undefined) {
          const userId = yield* memberId(ctx.options.member);
          const value = yield* karma.of(userId);
          yield* ctx.reply({
            embeds: [{ title: "Karma", description: `<@${userId}> has **${value}** karma here.`, color: ACCENT }],
          });
          return;
        }

        const own = yield* karma.of(ctx.userId);
        const top = yield* karma.top(SCOREBOARD_SIZE);
        // Like shinpuru, members who left drop off the scoreboard.
        const members = yield* guild.members(top.map((t) => t.userId));
        const lines = top
          .filter((t) => members.has(t.userId))
          .map((t, i) => `\`${i + 1}\` <@${t.userId}> **${t.value}**`);
        yield* ctx.reply({
          embeds: [
            {
              title: "Karma scoreboard",
              description: `Your karma on this server: **${own}**`,
              fields: [
                {
                  name: `Scoreboard (top ${lines.length})`,
                  value: lines.length > 0 ? lines.join("\n") : "*Nobody has karma here yet.*",
                },
              ],
              color: ACCENT,
            },
          ],
        });
      }),
  });

  const settings = defineCommand({
    name: "settings",
    description: "Show how karma is set, the blocklist and rules included.",
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        if (!(yield* Settings.current).karma) return yield* refuse(OFF_FOR_CONFIG);
        yield* ctx.reply(describe(yield* currentKarma));
      }),
  });

  const set = defineCommand({
    name: "set",
    description: "Turn karma on, or change how members vote. What you leave out stays as it is.",
    options: [
      {
        name: "upvotes",
        description: "Emoji that give the author of a message a point, separated by spaces.",
        type: "string",
        required: false,
        named: true,
      },
      {
        name: "downvotes",
        description: "Emoji that take a point, separated by spaces, or `none` for no downvotes.",
        type: "string",
        required: false,
        named: true,
      },
      {
        name: "votes",
        description: "How many votes a member may give in an hour.",
        type: "integer",
        required: false,
        named: true,
      },
      {
        name: "penalty",
        description: "`on` to make a downvote cost the member who gives it a point too, `off` not to.",
        type: "string",
        required: false,
        named: true,
      },
    ] as const,
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const { upvotes, downvotes, votes, penalty } = ctx.options;
        const changes: Partial<KarmaConfig> = {
          ...(upvotes !== undefined && { upvotes: yield* emojiList(upvotes) }),
          ...(downvotes !== undefined && { downvotes: yield* emojiList(downvotes) }),
          ...(votes !== undefined && { votesPerHour: yield* votesPerHour(votes) }),
          ...(penalty !== undefined && { penalty: yield* onOff(penalty) }),
        };
        const config = yield* save(ctx.userId, (current) => Effect.succeed({ ...(current ?? KARMA_DEFAULTS), ...changes }));
        yield* ctx.reply(describe(config));
      }),
  });

  const disable = defineCommand({
    name: "disable",
    description: "Turn karma off. Members keep their karma for when it's back on.",
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        if (!(yield* Settings.current).karma) return yield* refuse("Karma is already off.");
        yield* disableKarma(ctx.userId);
        yield* ctx.reply("Karma is off. Members keep their karma for when `karma set` turns it on again.");
      }),
  });

  const block = defineCommand({
    name: "block",
    description: "Keep a member from giving or getting karma. They keep the karma they have.",
    options: [{ name: "member", description: "A mention or user ID", type: "string" }] as const,
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const userId = yield* memberId(ctx.options.member);
        let already = false;
        yield* save(ctx.userId, (current) =>
          whileOn(current).pipe(
            Effect.map((config) => {
              already = config.blocklist.includes(userId);
              return already ? config : { ...config, blocklist: [...config.blocklist, userId] };
            }),
          ),
        );
        yield* ctx.reply(
          already ? `<@${userId}> was already blocked.` : `<@${userId}> can't give or get karma anymore.`,
        );
      }),
  });

  const unblock = defineCommand({
    name: "unblock",
    description: "Let a blocked member give and get karma again.",
    options: [{ name: "member", description: "A mention or user ID", type: "string" }] as const,
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const userId = yield* memberId(ctx.options.member);
        let blocked = false;
        yield* save(ctx.userId, (current) =>
          whileOn(current).pipe(
            Effect.map((config) => {
              blocked = config.blocklist.includes(userId);
              return { ...config, blocklist: config.blocklist.filter((id) => id !== userId) };
            }),
          ),
        );
        yield* ctx.reply(blocked ? `<@${userId}> can give and get karma again.` : `<@${userId}> wasn't blocked.`);
      }),
  });

  const addRule = defineCommand({
    name: "addrule",
    description: "Add a rule for what happens when a member's karma crosses a value.",
    options: [
      {
        name: "when",
        description: "`above` to act once karma rises past the value, `below` once it drops under it",
        type: "string",
      },
      { name: "value", description: "The karma value", type: "integer" },
      {
        name: "action",
        description:
          "`role` to give a role while karma stays there, `message` to send a DM, `kick` or `ban` to kick or ban the member",
        type: "string",
      },
      {
        name: "argument",
        description: "The role for `role`, as a mention or ID, or the text of the DM for `message`",
        type: "string",
        required: false,
        rest: true,
      },
    ] as const,
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const rule = yield* ruleOf(ctx.options);
        if (rule.roleId !== undefined) {
          const problem = (yield* roles.vetRoles([rule.roleId])).get(rule.roleId);
          if (problem) return yield* refuse(`The bot can't give <@&${rule.roleId}>: ${problem}.`);
        }
        const config = yield* save(ctx.userId, (current) =>
          whileOn(current).pipe(Effect.map((config) => ({ ...config, rules: [...config.rules, rule] }))),
        );
        yield* ctx.reply(`Added rule ${config.rules.length}: ${describeRule(rule)}.`);
      }),
  });

  const removeRule = defineCommand({
    name: "removerule",
    description: "Remove a rule. A role it gave stays with the members who have it.",
    options: [{ name: "number", description: "The rule's number, as `karma settings` lists them", type: "integer" }] as const,
    permission: "karma.config",
    run: (ctx) =>
      Effect.gen(function* () {
        const { number } = ctx.options;
        let removed: KarmaRule | undefined;
        yield* save(ctx.userId, (current) =>
          whileOn(current).pipe(
            Effect.flatMap((config) => {
              removed = config.rules[number - 1];
              if (number < 1 || !removed) {
                return refuse(`There's no rule ${number}. \`karma settings\` lists them.`);
              }
              return Effect.succeed({ ...config, rules: config.rules.filter((_, i) => i !== number - 1) });
            }),
          ),
        );
        yield* ctx.reply(`Removed rule ${number}: ${describeRule(removed!)}.`);
      }),
  });

  const group: CommandGroup = {
    name: "karma",
    description: "Show karma, or change how it works.",
    default: show,
    subcommands: [settings, set, disable, block, unblock, addRule, removeRule],
  };
  return group;
});

/** Emoji separated by spaces, or `none`; each one checked against the starboard's. */
const emojiList = Effect.fnUntraced(function* (input: string) {
  const words = input.trim().split(/\s+/);
  if (words.length === 1 && words[0]!.toLowerCase() === "none") return [];
  const starboard = (yield* Settings.current).starboard;
  for (const word of words) {
    if (!parseEmoji(word)) {
      return yield* refuse(`${word} isn't an emoji. Use a Unicode emoji or a custom one like <:name:id>.`);
    }
    if (starboard && emojiKey(word) === emojiKey(starboard.emoji)) {
      return yield* refuse(
        `${word} is the starboard's emoji, so it can't vote for karma too. Pick another, or change the starboard's emoji first.`,
      );
    }
  }
  return words;
});

function votesPerHour(votes: number) {
  return votes >= 1 ? Effect.succeed(votes) : refuse("Votes per hour has to be a whole number, 1 or more.");
}

function onOff(input: string) {
  const value = input.trim().toLowerCase();
  if (["on", "yes", "true"].includes(value)) return Effect.succeed(true);
  if (["off", "no", "false"].includes(value)) return Effect.succeed(false);
  return refuse("The penalty takes `on` or `off`.");
}

/** A rule from `addrule`'s options, with what its action needs. */
const ruleOf = Effect.fnUntraced(function* (options: {
  when: string;
  value: number;
  action: string;
  argument: string | undefined;
}) {
  const when = options.when.toLowerCase();
  if (when !== "above" && when !== "below") return yield* refuse("`when` takes `above` or `below`.");
  const action = options.action.toLowerCase();
  const { value, argument } = options;
  switch (action) {
    case "role": {
      const role = ROLE.exec(argument?.trim() ?? "");
      if (!role) return yield* refuse("A role rule needs a role after it, as a mention or ID.");
      return { when, value, action, roleId: (role[1] ?? role[2])! } satisfies KarmaRule;
    }
    case "message":
      if (!argument) return yield* refuse("A message rule needs the text of the DM after it.");
      if (argument.length > 1000) return yield* refuse("The DM can be 1000 characters at most.");
      return { when, value, action, message: argument } satisfies KarmaRule;
    case "kick":
    case "ban":
      if (argument) return yield* refuse(`A ${action} rule takes nothing after it.`);
      return { when, value, action } satisfies KarmaRule;
    default:
      return yield* refuse("`action` takes `role`, `message`, `kick` or `ban`.");
  }
});

/** The settings, like the web interface's form shows them. */
function describe(config: KarmaConfig): MessageBody {
  const emoji = (list: readonly string[]) => (list.length > 0 ? list.join(" ") : "*none*");
  const blocked = config.blocklist.map((id) => `<@${id}>`).join(", ") || "*nobody*";
  const rules = config.rules.map((rule, i) => `\`${i + 1}\` ${describeRule(rule)}`).join("\n") || "*none*";
  const description = [
    `Upvotes: ${emoji(config.upvotes)}`,
    `Downvotes: ${emoji(config.downvotes)}`,
    `Votes per hour: \`${config.votesPerHour}\``,
    `Downvotes cost a point: \`${config.penalty ? "on" : "off"}\``,
    `Blocked: ${blocked}`,
    `Rules:\n${rules}`,
  ].join("\n");
  return { embeds: [{ title: "Karma settings", description, color: ACCENT }] };
}

/** Like "when karma rises above `10`, give @Regular". */
function describeRule(rule: KarmaRule): string {
  const when = `when karma ${rule.when === "above" ? "rises above" : "drops below"} \`${rule.value}\``;
  const message = rule.message ?? "";
  const shown = message.length > MAX_SHOWN ? `${message.slice(0, MAX_SHOWN)}…` : message;
  const action =
    rule.action === "role" ? `give <@&${rule.roleId}>` : rule.action === "message" ? `DM "${shown}"` : rule.action;
  return `${when}, ${action}`;
}
