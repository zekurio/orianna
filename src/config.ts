import {
  Config as Env,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  SchemaIssue,
} from "effect";
import { parseEmoji } from "./emoji.ts";
import { ruleProblem } from "./permissions/rules.ts";

const Snowflake = Schema.String.check(Schema.isPattern(/^[0-9]+$/));

/** Fills in `value` when the key is missing. */
const orDefault = <S extends Schema.Top>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

/** Shared by the `emoji` and `sticker` sections. */
const ProposalConfigSchema = Schema.Struct({
  votingHours: Schema.Number.check(Schema.isGreaterThan(0)).pipe(orDefault(48)),
  maxOpenPerUser: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(orDefault(3)),
  /**
   * Should match the instance's `emoji_max_size` / `sticker_max_size`
   * (512 KiB for both by default). Larger images are scaled down to fit.
   */
  maxImageBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(orDefault(524288)),
  /**
   * Share of the members who can see the polls channel when a proposal goes
   * up that have to vote ✅, rounded up: 0.5 is half of them, 1 all of them.
   * A proposal also needs more ✅ than ❌.
   */
  threshold: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)).pipe(
    orDefault(1),
  ),
});

const PollsConfigSchema = Schema.Struct({
  /** How long a poll runs when it's given no duration. Polls run 4 weeks at most. */
  defaultHours: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(672)).pipe(
    orDefault(24),
  ),
  maxOpenPerUser: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(orDefault(5)),
});

/** Rules are lists like `["+emoji.*", "-emoji.decide"]`; see `permissions` below. */
const PermissionsSchema = Schema.Struct({
  /**
   * Rules for every member. Setting it replaces the default, which lets
   * everyone propose emojis and stickers and start polls.
   */
  everyone: Schema.Array(Schema.String).pipe(
    orDefault(["+emoji.propose", "+sticker.propose", "+polls.create"]),
  ),
  /** Rules for members with a role, keyed by role ID. */
  roles: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(orDefault({})),
});

const RoleMenuOptionSchema = Schema.Struct({
  /** A Unicode emoji, `name:id` or `<:name:id>` (`<a:name:id>` for an animated one). */
  emoji: Schema.String.check(Schema.isMinLength(1)),
  roleId: Snowflake,
  /** Shown after the role, e.g. "server news and downtime". */
  description: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
});

const RoleMenuSchema = Schema.Struct({
  /**
   * Identifies the menu across restarts and in the audit log. Renaming it
   * deletes the old message and posts a new one.
   */
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000))),
  /** `multi` lets members take any number of roles; in `single`, picking one replaces the last. */
  mode: Schema.Literals(["multi", "single"]).pipe(orDefault("multi")),
  /** Overrides `roleMenus.channelId` for this menu. */
  channelId: Schema.optionalKey(Snowflake),
  /** A message can carry 30 different reactions. */
  options: Schema.Array(RoleMenuOptionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
});

const RoleMenusSchema = Schema.Struct({
  /** Where menus are posted unless they set their own `channelId`. */
  channelId: Snowflake,
  menus: Schema.Array(RoleMenuSchema).pipe(orDefault([])),
});

const BoardSchema = Schema.Struct({
  /** What `!board top` takes, e.g. `gems`. */
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/)),
  /** A Unicode emoji, `name:id` or `<:name:id>` (`<a:name:id>` for an animated one). */
  emoji: Schema.String.check(Schema.isMinLength(1)),
  /** Where the bot posts the messages that make it. */
  channelId: Snowflake,
  /** Members other than the author who have to react before a message goes up. */
  threshold: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(orDefault(5)),
  /** Keeps a post up when reactions drop below the threshold again. */
  keep: Schema.Boolean.pipe(orDefault(false)),
  /** Channels whose messages never go up, such as private ones. Board channels never do. */
  ignoredChannelIds: Schema.Array(Snowflake).pipe(orDefault([])),
});

/**
 * Bot settings: what the bot does in the guild. They live in the database,
 * where `!settings` edits them while the bot runs; src/settings/settings.ts
 * keeps them. Nothing here is a secret or needs a restart.
 */
export const BotSettingsSchema = Schema.Struct({
  /** What commands start with, e.g. `!` for `!help`. */
  prefix: Schema.String.check(Schema.isMinLength(1)).pipe(orDefault("!")),
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
   * - `boards.remove`: take a message off a board for good with `!board remove`
   * - `boards.manage`: create, change and delete boards with `!board create`, `edit` and `delete`
   *
   * The most specific rule that names a permission decides it, so
   * `-emoji.decide` beats `+emoji.*`, which beats `+*`. Between rules that
   * are just as specific, a role's rule beats Manage Expressions, which beats
   * `everyone`, and a higher role beats a lower one. A permission no rule
   * names is denied.
   *
   * Members with Manage Expressions get `+emoji.*` and `+sticker.*`. The
   * guild owner and members with Administrator may do everything, and only
   * they may change the settings. `!perms` shows what a member may do and
   * which rule decided it.
   */
  permissions: PermissionsSchema.pipe(orDefault({})),
  /** Channel where emoji and sticker proposals are put to a vote. Required when either is on. */
  pollsChannelId: Schema.optionalKey(Snowflake),
  /** Emoji proposals are disabled when this section is missing. */
  emoji: Schema.optionalKey(ProposalConfigSchema),
  /** Sticker proposals are disabled when this section is missing. */
  sticker: Schema.optionalKey(ProposalConfigSchema),
  /**
   * Polls members start with `!poll`, posted in the channel the command is
   * used in. Disabled when this section is missing. The bot needs Send
   * Messages, Embed Links and Add Reactions there, and Manage Messages to
   * delete the `!poll` message, move votes in single-choice polls, and take
   * back 🛑 from members who may not end a poll.
   */
  polls: Schema.optionalKey(PollsConfigSchema),
  /**
   * Messages where members react to give themselves roles. The bot posts and
   * updates them on startup and whenever this section changes. It needs
   * Manage Roles, with its own role above every menu role, and Send Messages,
   * Embed Links, Add Reactions and Manage Messages in the menu channels.
   * Removing a menu or an option takes down its message or reactions;
   * members keep the roles they have.
   */
  roleMenus: Schema.optionalKey(RoleMenusSchema),
  /**
   * Starboards: once enough members react to a message with a board's emoji,
   * the bot posts it in the board's channel. It needs View Channel and Read
   * Message History where members react, and Send Messages, Embed Links and
   * Attach Files in the board channels.
   */
  boards: Schema.optionalKey(Schema.Array(BoardSchema)),
});

export type BotSettings = typeof BotSettingsSchema.Type;
export type SettingsSection = keyof BotSettings;

/** The top-level keys of the bot settings, in the order the schema lists them. */
export const SETTINGS_SECTIONS = Object.keys(BotSettingsSchema.fields) as SettingsSection[];

/** An http or https URL with nothing after the host but a slash. */
const isOrigin = Schema.makeFilter((value: string) => {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "Expected an http or https URL";
  if (url.pathname !== "/" || url.search || url.hash) {
    return "Expected a URL without a path, like https://orianna.example.org";
  }
  return undefined;
});

/**
 * The web interface. Members sign in with their Fluxer account through the
 * bot's application, which takes its client secret too; see readClientSecret.
 */
const WebConfigSchema = Schema.Struct({
  /**
   * Where people open the web interface. Fluxer sends them back to
   * `<publicUrl>/auth/callback` after they sign in, so the application needs
   * that as a redirect URI.
   */
  publicUrl: Schema.String.check(isOrigin),
  /** The ID of the bot's application. */
  clientId: Snowflake,
  /** Where the bot listens. A reverse proxy with TLS goes in front. */
  host: Schema.String.check(Schema.isMinLength(1)).pipe(orDefault("127.0.0.1")),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(orDefault(8080)),
});

/**
 * The config file: how to reach Fluxer, where to keep data, and where to
 * serve the web interface. It's read once at startup, so changing it takes a
 * restart.
 */
export const ConfigSchema = Schema.Struct({
  /** Origin of the Fluxer instance. The client reads `/.well-known/fluxer` from here. */
  instance: Schema.String.check(Schema.isMinLength(1)),
  /** The guild this bot serves. Messages from anywhere else are ignored. */
  guildId: Snowflake,
  /** SQLite file. Relative paths resolve against the working directory. */
  database: Schema.String.check(Schema.isMinLength(1)).pipe(orDefault("./data/orianna.db")),
  /** The web interface is off when this section is missing. */
  web: Schema.optionalKey(WebConfigSchema),
});

/** The deployment keys of the config file. */
export interface Config {
  readonly instance: string;
  readonly guildId: string;
  readonly database: string;
  readonly web: WebConfig | undefined;
}

export type WebConfig = typeof WebConfigSchema.Type;

export type ProposalConfig = typeof ProposalConfigSchema.Type;
export type PollsConfig = typeof PollsConfigSchema.Type;
export type PermissionsConfig = typeof PermissionsSchema.Type;
export type RoleMenusConfig = typeof RoleMenusSchema.Type;
export type RoleMenuConfig = typeof RoleMenuSchema.Type;
export type BoardConfig = typeof BoardSchema.Type;

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

/** Bot settings that don't validate, one line per problem, each starting with its path. */
export class InvalidSettings extends Data.TaggedError("InvalidSettings")<{
  readonly problems: readonly string[];
}> {
  override get message(): string {
    return indent(this.problems);
  }
}

const indent = (problems: readonly string[]) => problems.map((p) => `  ${p}`).join("\n");

const decodeOptions = { errors: "all", onExcessProperty: "error" } as const;

export function parseConfig(raw: unknown): Effect.Effect<Config, ConfigError> {
  return Schema.decodeUnknownEffect(ConfigSchema)(raw, decodeOptions).pipe(
    Effect.mapError((err) => new ConfigError({ message: `invalid config:\n${indent(schemaProblems(err.issue))}` })),
    Effect.map(({ instance, guildId, database, web }) => ({
      instance,
      guildId,
      database,
      // Without the trailing slash, so paths can go straight after it.
      web: web && { ...web, publicUrl: new URL(web.publicUrl).origin },
    })),
  );
}

/**
 * Validates bot settings and fills in defaults. Problems have the same paths
 * as the keys in the document, like `/boards/1/threshold`. `guildId` is the
 * guild's, whose @everyone role can't have rules of its own.
 */
export function parseSettings(raw: unknown, guildId: string): Effect.Effect<BotSettings, InvalidSettings> {
  return Schema.decodeUnknownEffect(BotSettingsSchema)(raw, decodeOptions).pipe(
    Effect.mapError((err) => new InvalidSettings({ problems: schemaProblems(err.issue) })),
    Effect.flatMap((settings) => {
      const problems = [
        ...checkPollsChannel(settings),
        ...checkPermissions(settings, guildId),
        ...checkRoleMenus(settings),
        ...checkBoards(settings),
      ];
      return problems.length > 0 ? Effect.fail(new InvalidSettings({ problems })) : Effect.succeed(settings);
    }),
  );
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** One line per problem, each starting with where in the document it is. */
function schemaProblems(issue: SchemaIssue.Issue): string[] {
  return formatIssue(issue).issues.map(({ path = [], message }) => {
    const keys = path.map((p) => String(typeof p === "object" ? p.key : p));
    if (message === "Expected no excess property") {
      return `/${keys.slice(0, -1).join("/")}: unknown key ${keys.at(-1)}`;
    }
    return `/${keys.join("/")}: ${message}`;
  });
}

/** What the schema can't express: proposals need a channel to vote in. */
function checkPollsChannel(settings: BotSettings): string[] {
  const sections = (["emoji", "sticker"] as const).filter((key) => settings[key]);
  if (settings.pollsChannelId !== undefined || sections.length === 0) return [];

  const names = sections.join(" and ");
  const paths = sections.map((key) => `/${key}`).join(" and ");
  return [`/pollsChannelId: ${names} proposals need a channel to vote in; set it, or remove ${paths}`];
}

/** What the schema can't express: rule syntax, one rule per permission, and role IDs. */
function checkPermissions(settings: BotSettings, guildId: string): string[] {
  const { everyone, roles } = settings.permissions;
  const problems = checkRules(everyone, "/permissions/everyone");

  for (const [roleId, rules] of Object.entries(roles)) {
    const at = `/permissions/roles/${roleId}`;
    if (!/^[0-9]+$/.test(roleId)) {
      problems.push(`${at}: ${roleId} is not a role ID`);
    } else if (roleId === guildId) {
      problems.push(`${at}: that's the @everyone role; put its rules in /permissions/everyone`);
    } else {
      problems.push(...checkRules(rules, at));
    }
  }
  return problems;
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
      problems.push(`${at}/${i}: ${problem}`);
    } else if (targets.has(target)) {
      problems.push(`${at}/${i}: another rule in this list already names ${target}`);
    }
    targets.add(target);
  });
  return problems;
}

/** What the schema can't express: unique names, emoji per menu, and roles. */
function checkRoleMenus(settings: BotSettings): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const menuOfRole = new Map<string, string>();

  settings.roleMenus?.menus.forEach((menu, i) => {
    const at = `/roleMenus/menus/${i}`;
    if (names.has(menu.name)) problems.push(`${at}/name: another menu is also called ${menu.name}`);
    names.add(menu.name);

    const emoji = new Set<string>();
    menu.options.forEach((option, j) => {
      const here = `${at}/options/${j}`;
      const parsed = parseEmoji(option.emoji);
      if (!parsed) {
        problems.push(`${here}/emoji: ${option.emoji} is not an emoji; use a Unicode emoji, name:id or <:name:id>`);
      } else if (emoji.has(parsed.key)) {
        problems.push(`${here}/emoji: ${option.emoji} is already used in this menu`);
      } else {
        emoji.add(parsed.key);
      }

      const other = menuOfRole.get(option.roleId);
      if (other !== undefined) {
        problems.push(`${here}/roleId: the role is already in menu ${other}`);
      } else {
        menuOfRole.set(option.roleId, menu.name);
      }
    });
  });
  return problems;
}

/** What the schema can't express: unique names, and emoji the bot can read. */
function checkBoards(settings: BotSettings): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  settings.boards?.forEach((board, i) => {
    const at = `/boards/${i}`;
    if (names.has(board.name)) problems.push(`${at}/name: another board is also called ${board.name}`);
    names.add(board.name);
    if (!parseEmoji(board.emoji)) {
      problems.push(`${at}/emoji: ${board.emoji} is not an emoji; use a Unicode emoji, name:id or <:name:id>`);
    }
  });
  return problems;
}

export const loadConfig = Effect.fn("loadConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = (err: { message: string }) =>
    new ConfigError({ message: `couldn't read ${path}: ${err.message}` });
  if (!(yield* fs.exists(path).pipe(Effect.mapError(unreadable)))) {
    return yield* new ConfigError({ message: `config file not found: ${path}` });
  }

  const text = yield* fs.readFileString(path).pipe(Effect.mapError(unreadable));
  const raw = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (err) => new ConfigError({ message: `${path} is not valid JSON: ${(err as Error).message}` }),
  });
  return yield* parseConfig(raw);
});

/** The config file, read once at startup. */
export class AppConfig extends Context.Service<AppConfig, Config>()("orianna/AppConfig") {
  /** Reads ORIANNA_CONFIG, or `config.json` in the working directory. */
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const path = yield* Env.String("ORIANNA_CONFIG").pipe(Env.withDefault("config.json"));
      return yield* loadConfig(path);
    }),
  );

  /** The deployment keys. Bot settings come from the Settings service. */
  static readonly current: Effect.Effect<Config, never, AppConfig> = Effect.gen(function* () {
    return yield* AppConfig;
  });
}

/**
 * Reads a secret from the systemd credential `credential` when running as a
 * service, falling back to the environment variable for local development.
 */
const readSecret = (credential: string, variable: string, noun: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const credentials = yield* Env.option(Env.String("CREDENTIALS_DIRECTORY"));
    if (Option.isSome(credentials) && credentials.value) {
      const file = `${credentials.value}/${credential}`;
      if (yield* fs.exists(file)) {
        const secret = (yield* fs.readFileString(file)).trim();
        if (secret) return Redacted.make(secret);
      }
    }

    const secret = Option.getOrUndefined(yield* Env.option(Env.String(variable)))?.trim();
    if (secret) return Redacted.make(secret);

    return yield* new ConfigError({
      message: `no ${noun}: set ${variable} or provide a \`${credential}\` systemd credential`,
    });
  }).pipe(
    Effect.catchTags({
      PlatformError: (err) => Effect.fail(new ConfigError({ message: `couldn't read the ${noun}: ${err.message}` })),
      ConfigError: (err) => Effect.fail(new ConfigError({ message: err.message })),
    }),
  );

/** The bot token, from the systemd credential `token` or FLUXER_BOT_TOKEN. */
export const readToken = readSecret("token", "FLUXER_BOT_TOKEN", "bot token");

/**
 * The client secret of the bot's application, for signing in to the web
 * interface, from the systemd credential `client-secret` or FLUXER_CLIENT_SECRET.
 */
export const readClientSecret = readSecret("client-secret", "FLUXER_CLIENT_SECRET", "client secret");
