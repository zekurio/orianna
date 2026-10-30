import Type from "typebox";
import Value from "typebox/value";
import { parseEmoji } from "./emoji.ts";
import { ruleProblem } from "./permissions/rules.ts";

const Snowflake = Type.String({ pattern: "^[0-9]+$" });

/** Shared by the `emoji` and `sticker` sections. */
const ProposalConfigSchema = Type.Object(
  {
    votingHours: Type.Number({ exclusiveMinimum: 0, default: 48 }),
    maxOpenPerUser: Type.Integer({ minimum: 1, default: 3 }),
    /**
     * Should match the instance's `emoji_max_size` / `sticker_max_size`
     * (512 KiB for both by default). Larger images are scaled down to fit.
     */
    maxImageBytes: Type.Integer({ minimum: 1, default: 524288 }),
    /**
     * Share of the members who can see the polls channel when a proposal goes
     * up that have to vote ✅, rounded up: 0.5 is half of them, 1 all of them.
     * A proposal also needs more ✅ than ❌.
     */
    threshold: Type.Number({ exclusiveMinimum: 0, maximum: 1, default: 1 }),
  },
  { additionalProperties: false },
);

const PollsConfigSchema = Type.Object(
  {
    /** How long a poll runs when it's given no duration. Polls run 4 weeks at most. */
    defaultHours: Type.Number({ exclusiveMinimum: 0, maximum: 672, default: 24 }),
    maxOpenPerUser: Type.Integer({ minimum: 1, default: 5 }),
  },
  { additionalProperties: false },
);

/** Rules are lists like `["+emoji.*", "-emoji.decide"]`; see `permissions` below. */
const PermissionsSchema = Type.Object(
  {
    /**
     * Rules for every member. Setting it replaces the default, which lets
     * everyone propose emojis and stickers and start polls.
     */
    everyone: Type.Array(Type.String(), {
      default: ["+emoji.propose", "+sticker.propose", "+polls.create"],
    }),
    /** Rules for members with a role, keyed by role ID. */
    roles: Type.Record(Type.String(), Type.Array(Type.String()), { default: {} }),
  },
  { additionalProperties: false, default: {} },
);

const RoleMenuOptionSchema = Type.Object(
  {
    /** A Unicode emoji, `name:id` or `<:name:id>` (`<a:name:id>` for an animated one). */
    emoji: Type.String({ minLength: 1 }),
    roleId: Snowflake,
    /** Shown after the role, e.g. "server news and downtime". */
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

const RoleMenuSchema = Type.Object(
  {
    /**
     * Identifies the menu across restarts and in the audit log. Renaming it
     * deletes the old message and posts a new one.
     */
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    /** `multi` lets members take any number of roles; in `single`, picking one replaces the last. */
    mode: Type.Enum(["multi", "single"], { default: "multi" }),
    /** Overrides `roleMenus.channelId` for this menu. */
    channelId: Type.Optional(Snowflake),
    /** A message can carry 30 different reactions. */
    options: Type.Array(RoleMenuOptionSchema, { minItems: 1, maxItems: 30 }),
  },
  { additionalProperties: false },
);

const RoleMenusSchema = Type.Object(
  {
    /** Where menus are posted unless they set their own `channelId`. */
    channelId: Snowflake,
    menus: Type.Array(RoleMenuSchema, { default: [] }),
  },
  { additionalProperties: false },
);

/**
 * On SIGHUP (`systemctl reload orianna`) the bot reads the file again and
 * applies `prefix` and `permissions`. Every other key is read once at startup,
 * and changing it takes a restart. A file that doesn't load is ignored, and the
 * bot keeps the config it has.
 */
export const ConfigSchema = Type.Object(
  {
    /** Origin of the Fluxer instance. The client reads `/.well-known/fluxer` from here. */
    instance: Type.String({ minLength: 1 }),
    /** The guild this bot serves. Messages from anywhere else are ignored. */
    guildId: Snowflake,
    /** Channel where emoji and sticker proposals are put to a vote. */
    pollsChannelId: Snowflake,
    /** What commands start with, e.g. `!` for `!help`. */
    prefix: Type.String({ minLength: 1, default: "!" }),
    /** SQLite file. Relative paths resolve against the working directory. */
    database: Type.String({ minLength: 1, default: "./data/orianna.db" }),
    /**
     * Who may do what, as rules like `+emoji.add` to allow and `-polls.*` to
     * deny. A rule names one permission, a group like `emoji.*`, or `*` for
     * all of them:
     *
     * - `emoji.propose`: put an emoji up for a vote
     * - `emoji.add`: add an emoji without a vote
     * - `emoji.decide`: approve or reject a proposal before the vote ends
     * - `emoji.cancel-any`: withdraw anyone's proposal, not just one's own
     * - `sticker.propose`, `sticker.add`, `sticker.decide`, `sticker.cancel-any`
     * - `polls.create`: start a poll with `!poll`
     * - `polls.end-any`: end anyone's poll early with 🛑, not just one's own
     *
     * The most specific rule that names a permission decides it, so
     * `-emoji.decide` beats `+emoji.*`, which beats `+*`. Between rules that
     * are just as specific, a role's rule beats Manage Expressions, which beats
     * `everyone`, and a higher role beats a lower one. A permission no rule
     * names is denied.
     *
     * Members with Manage Expressions get `+emoji.*` and `+sticker.*`. The
     * guild owner and members with Administrator may do everything. `!perms`
     * shows what a member may do and which rule decided it.
     */
    permissions: PermissionsSchema,
    /** Emoji proposals are disabled when this section is missing. */
    emoji: Type.Optional(ProposalConfigSchema),
    /** Sticker proposals are disabled when this section is missing. */
    sticker: Type.Optional(ProposalConfigSchema),
    /**
     * Polls members start with `!poll`, posted in the channel the command is
     * used in. Disabled when this section is missing. The bot needs Send
     * Messages, Embed Links and Add Reactions there, and Manage Messages to
     * delete the `!poll` message, move votes in single-choice polls, and take
     * back 🛑 from members who may not end a poll.
     */
    polls: Type.Optional(PollsConfigSchema),
    /**
     * Messages where members react to give themselves roles. The bot posts and
     * updates them on startup. It needs Manage Roles, with its own role above
     * every menu role, and Send Messages, Embed Links, Add Reactions and Manage
     * Messages in the menu channels. Removing a menu or an option takes down
     * its message or reactions; members keep the roles they have.
     */
    roleMenus: Type.Optional(RoleMenusSchema),
  },
  { additionalProperties: false },
);

export type Config = Type.Static<typeof ConfigSchema>;
export type ProposalConfig = Type.Static<typeof ProposalConfigSchema>;
export type PollsConfig = Type.Static<typeof PollsConfigSchema>;
export type PermissionsConfig = Type.Static<typeof PermissionsSchema>;
export type RoleMenusConfig = Type.Static<typeof RoleMenusSchema>;
export type RoleMenuConfig = Type.Static<typeof RoleMenuSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(raw: unknown): Config {
  const value = Value.Default(ConfigSchema, Value.Clone(raw));
  if (Value.Check(ConfigSchema, value)) {
    checkPermissions(value);
    checkRoleMenus(value);
    return value;
  }

  const problems = Value.Errors(ConfigSchema, value).flatMap((e) => {
    // `additionalProperties: false` reports each extra key twice; keep the readable one.
    if (e.keyword === "boolean" && e.schemaPath.endsWith("/additionalProperties")) {
      return [];
    }
    if (e.keyword === "additionalProperties") {
      const keys = (e.params as { additionalProperties: string[] }).additionalProperties;
      return [`  ${e.instancePath || "/"}: unknown key(s): ${keys.join(", ")}`];
    }
    return [`  ${e.instancePath || "/"}: ${e.message}`];
  });
  throw new ConfigError(`invalid config:\n${problems.join("\n")}`);
}

/** What the schema can't express: rule syntax, one rule per permission, and role IDs. */
function checkPermissions(config: Config) {
  const { everyone, roles } = config.permissions;
  const problems = checkRules(everyone, "/permissions/everyone");

  for (const [roleId, rules] of Object.entries(roles)) {
    const at = `/permissions/roles/${roleId}`;
    if (!/^[0-9]+$/.test(roleId)) {
      problems.push(`  ${at}: ${roleId} is not a role ID`);
    } else if (roleId === config.guildId) {
      problems.push(`  ${at}: that's the @everyone role; put its rules in /permissions/everyone`);
    } else {
      problems.push(...checkRules(rules, at));
    }
  }

  if (problems.length > 0) throw new ConfigError(`invalid config:\n${problems.join("\n")}`);
}

/**
 * Checks each rule, and that a list names each target once: with both
 * `+emoji.add` and `-emoji.add`, their order would decide.
 */
function checkRules(rules: readonly string[], at: string): string[] {
  const problems: string[] = [];
  const targets = new Set<string>();
  rules.forEach((rule, i) => {
    const problem = ruleProblem(rule);
    const target = rule.slice(1);
    if (problem) {
      problems.push(`  ${at}/${i}: ${problem}`);
    } else if (targets.has(target)) {
      problems.push(`  ${at}/${i}: another rule in this list already names ${target}`);
    }
    targets.add(target);
  });
  return problems;
}

/** What the schema can't express: unique names, emoji per menu, and roles. */
function checkRoleMenus(config: Config) {
  const problems: string[] = [];
  const names = new Set<string>();
  const menuOfRole = new Map<string, string>();

  config.roleMenus?.menus.forEach((menu, i) => {
    const at = `/roleMenus/menus/${i}`;
    if (names.has(menu.name)) problems.push(`  ${at}/name: another menu is also called ${menu.name}`);
    names.add(menu.name);

    const emoji = new Set<string>();
    menu.options.forEach((option, j) => {
      const here = `${at}/options/${j}`;
      const parsed = parseEmoji(option.emoji);
      if (!parsed) {
        problems.push(
          `  ${here}/emoji: ${option.emoji} is not an emoji; use a Unicode emoji, name:id or <:name:id>`,
        );
      } else if (emoji.has(parsed.key)) {
        problems.push(`  ${here}/emoji: ${option.emoji} is already used in this menu`);
      } else {
        emoji.add(parsed.key);
      }

      const other = menuOfRole.get(option.roleId);
      if (other !== undefined) {
        problems.push(`  ${here}/roleId: the role is already in menu ${other}`);
      } else {
        menuOfRole.set(option.roleId, menu.name);
      }
    });
  });

  if (problems.length > 0) throw new ConfigError(`invalid config:\n${problems.join("\n")}`);
}

export async function loadConfig(
  path = process.env.ORIANNA_CONFIG ?? "config.json",
): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`config file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

/**
 * What a reload applies: `prefix` and `permissions` from `next`, the rest kept
 * from `current`. Also returns the keys that still differ from `next`, which
 * only a restart applies. nix/module.nix restarts the bot when one of them
 * changes, so keep its list of reloaded keys in step with this one.
 */
export function reloadedConfig(current: Config, next: Config) {
  const config: Config = { ...current, prefix: next.prefix, permissions: next.permissions };
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]) as Set<keyof Config>;
  const needRestart = [...keys].filter((key) => !Bun.deepEquals(config[key], next[key]));
  return { config, needRestart };
}

/**
 * Reads the bot token from the systemd credential `token` when running as a
 * service, falling back to FLUXER_BOT_TOKEN for local development.
 */
export async function readToken(env = process.env): Promise<string> {
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (credentials) {
    const file = Bun.file(`${credentials}/token`);
    if (await file.exists()) {
      const token = (await file.text()).trim();
      if (token) return token;
    }
  }

  const token = env.FLUXER_BOT_TOKEN?.trim();
  if (token) return token;

  throw new ConfigError(
    "no bot token: set FLUXER_BOT_TOKEN or provide a `token` systemd credential",
  );
}
