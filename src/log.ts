import { createLogger, type Logger as FluxerLogger } from "@fluxerjs/core";
import { type ConsolaInstance, type ConsolaReporter, createConsola, LogLevels } from "consola";
import { createConsola as createBasicConsola } from "consola/basic";
import { type ColorFunction, colors } from "consola/utils";
import { Cause, Duration, Effect, Layer, Logger, type LogLevel, References } from "effect";
import { AppConfig, type LogLevelName } from "./config.ts";

// Everything the bot logs goes through consola to stdout: its own logs, the
// web server's requests and the calls the app makes, and fluxer.js's logger.
// On a terminal each line starts with its level on a coloured badge and has
// the tag and the time on the right. Anywhere else, like under systemd,
// they're plain lines the journal puts a time on.

/** The backdrop and the text colour of each level's badge. */
const BADGES: Record<string, [ColorFunction, ColorFunction]> = {
  fatal: [colors.bgRed, colors.black],
  error: [colors.bgRed, colors.black],
  warn: [colors.bgYellow, colors.black],
  info: [colors.bgCyan, colors.black],
};
const GREY_BADGE: [ColorFunction, ColorFunction] = [colors.bgBlackBright, colors.white];

const badged: ConsolaReporter = {
  log: ({ type, tag, date, args }) => {
    const [backdrop, text] = BADGES[type] ?? GREY_BADGE;
    // Padded to the longest level, so the messages line up.
    const badge = backdrop(text(` ${type.toUpperCase().padEnd(5)} `));
    const [first, ...more] = args
      .map((arg) =>
        typeof arg === "string"
          ? arg
          : arg instanceof Error
            ? (arg.stack ?? arg.message)
            : Bun.inspect(arg, { colors: Bun.enableANSIColors }),
      )
      .join(" ")
      .split("\n");
    const left = `${badge} ${first}`;
    const right = colors.gray([tag, date.toLocaleTimeString()].filter(Boolean).join(" "));
    const space = (process.stdout.columns ?? 0) - Bun.stringWidth(left) - Bun.stringWidth(right);
    process.stdout.write(`${[`${left}${" ".repeat(Math.max(space, 1))}${right}`, ...more].join("\n")}\n`);
  },
};

// Effect and fluxer.js leave out what's below the config's `logLevel`.
const consola = process.stdout.isTTY
  ? createConsola({ level: LogLevels.trace, reporters: [badged] })
  : createBasicConsola({ level: LogLevels.trace, stderr: process.stdout });

const tagged = new Map<string, ConsolaInstance>();

function consolaFor(tag: string | undefined): ConsolaInstance {
  if (tag === undefined) return consola;
  let instance = tagged.get(tag);
  if (!instance) tagged.set(tag, (instance = consola.withTag(tag)));
  return instance;
}

const TAG = "tag";

/** Tags the logs of an effect with what they're about, like `http` or `fluxer`. */
export const tagLogs = (tag: string) => Effect.annotateLogs(TAG, tag);

const METHODS: Record<LogLevel.LogLevel, "fatal" | "error" | "warn" | "info" | "debug" | "trace"> = {
  All: "trace",
  Fatal: "fatal",
  Error: "error",
  Warn: "warn",
  Info: "info",
  Debug: "debug",
  Trace: "trace",
  None: "trace",
};

/** Other annotations go after the message as `key=value`. */
const fields = (annotations: Readonly<Record<string, unknown>>): string[] =>
  Object.entries(annotations).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);

const pretty = Logger.make(({ message, logLevel, cause, fiber }) => {
  const { [TAG]: tag, ...annotations } = fiber.getRef(References.CurrentLogAnnotations);
  const [first, ...rest] = [
    ...(Array.isArray(message) ? message : [message]),
    ...fields(annotations),
    ...Cause.prettyErrors(cause),
  ];
  consolaFor(typeof tag === "string" ? tag : undefined)[METHODS[logLevel]](first, ...rest);
});

/** Logs through consola instead of Effect's default logger. */
export const PrettyLogger = Logger.layer([pretty]);

const SEVERITIES: Record<LogLevelName, LogLevel.Severity> = {
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
};

/** Leaves out the logs below the config's `logLevel`. */
export const MinimumLogLevel = Layer.effect(
  References.MinimumLogLevel,
  Effect.map(AppConfig.current, ({ logLevel }) => SEVERITIES[logLevel]),
);

/** fluxer.js's logger, with its lines tagged `fluxer`. */
export function fluxerLogger(level: LogLevelName): FluxerLogger {
  return createLogger({
    level,
    sink: (level, message, extra) => consolaFor("fluxer")[level](message, ...fields(extra ?? {})),
  });
}

/** `duration` in whole milliseconds, like `12ms`. */
export function millis(duration: Duration.Duration): string {
  return `${Math.round(Duration.toMillis(duration))}ms`;
}
