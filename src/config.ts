import Type from "typebox";
import Value from "typebox/value";
import { parseEmoji } from "./emoji.ts";

const Snowflake = Type.String({ pattern: "^[0-9]+$" });
const Snowflakes = Type.Array(Snowflake, { default: [] });

/** Shared by the `emoji` and `sticker` sections. */
const ProposalConfigSchema = Type.Object(
  {
    votingHours: Type.Number({ exclusiveMinimum: 0, default: 48 }),
    maxOpenPerUser: Type.Integer({ minimum: 1, default: 3 }),
    /**
     * Should match the instance's `emoji_max_size` / `sticker_max_size`
     * (512 KiB for both by default).
     */
    maxImageBytes: Type.Integer({ minimum: 1, default: 524288 }),
    /** Roles allowed to propose. Empty means everyone. */
    proposerRoleIds: Snowflakes,
  },
  { additionalProperties: false },
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

export const ConfigSchema = Type.Object(
  {
    /** Origin of the Fluxer instance. The client reads `/.well-known/fluxer` from here. */
    instance: Type.String({ minLength: 1 }),
    /** The guild this bot serves. Messages from anywhere else are ignored. */
    guildId: Snowflake,
    /** Channel where polls are posted and voted on. */
    pollsChannelId: Snowflake,
    prefix: Type.String({ minLength: 1, default: "!" }),
    /** SQLite file. Relative paths resolve against the working directory. */
    database: Type.String({ minLength: 1, default: "./data/orianna.db" }),
    /**
     * Roles allowed to run admin commands, in addition to the guild owner and
     * members with Manage Expressions.
     */
    adminRoleIds: Snowflakes,
    /** Emoji proposals are disabled when this section is missing. */
    emoji: Type.Optional(ProposalConfigSchema),
    /** Sticker proposals are disabled when this section is missing. */
    sticker: Type.Optional(ProposalConfigSchema),
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
export type RoleMenusConfig = Type.Static<typeof RoleMenusSchema>;
export type RoleMenuConfig = Type.Static<typeof RoleMenuSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(raw: unknown): Config {
  const value = Value.Default(ConfigSchema, Value.Clone(raw));
  if (Value.Check(ConfigSchema, value)) {
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
 * Reads the bot token from the systemd credential `token` when running as a
 * service, falling back to ORIANNA_TOKEN for local development.
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

  const token = env.ORIANNA_TOKEN?.trim();
  if (token) return token;

  throw new ConfigError(
    "no bot token: set ORIANNA_TOKEN or provide a `token` systemd credential",
  );
}
