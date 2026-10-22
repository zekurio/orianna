import Type from "typebox";
import Value from "typebox/value";

const Snowflake = Type.String({ pattern: "^[0-9]+$" });
const Snowflakes = Type.Array(Snowflake, { default: [] });

const EmojiConfigSchema = Type.Object(
  {
    /** Channel where proposals are posted and voted on. */
    channelId: Snowflake,
    votingHours: Type.Number({ exclusiveMinimum: 0, default: 48 }),
    /** A proposal passes with at least this many yes votes and more yes than no. */
    minYesVotes: Type.Integer({ minimum: 1, default: 3 }),
    maxOpenPerUser: Type.Integer({ minimum: 1, default: 3 }),
    /** Should match the instance's `emoji_max_size` (512 KiB by default). */
    maxImageBytes: Type.Integer({ minimum: 1, default: 524288 }),
    /** Roles allowed to propose. Empty means everyone. */
    proposerRoleIds: Snowflakes,
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    /** Origin of the Fluxer instance. The client reads `/.well-known/fluxer` from here. */
    instance: Type.String({ minLength: 1 }),
    /** The guild this bot serves. Messages from anywhere else are ignored. */
    guildId: Snowflake,
    prefix: Type.String({ minLength: 1, default: "!" }),
    /** SQLite file. Relative paths resolve against the working directory. */
    database: Type.String({ minLength: 1, default: "./data/orianna.db" }),
    /**
     * Roles allowed to run admin commands, in addition to the guild owner and
     * members with Manage Expressions.
     */
    adminRoleIds: Snowflakes,
    /** Emoji proposals are disabled when this section is missing. */
    emoji: Type.Optional(EmojiConfigSchema),
  },
  { additionalProperties: false },
);

export type Config = Type.Static<typeof ConfigSchema>;
export type EmojiConfig = Type.Static<typeof EmojiConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(raw: unknown): Config {
  const value = Value.Default(ConfigSchema, Value.Clone(raw));
  if (Value.Check(ConfigSchema, value)) return value;

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
