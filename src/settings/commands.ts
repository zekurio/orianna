import { Effect, Result } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import { type CommandGroup, defineCommand, refuse } from "../commands/command.ts";
import type { SettingsSection } from "../config.ts";
import { downloadFile } from "../download.ts";
import { Fluxer } from "../fluxer.ts";
import { embedPages } from "../messages/body.ts";
import { timestamp } from "../polls/service.ts";
import { Settings, type SettingsChange } from "./settings.ts";

/** Far more than any settings file needs. */
const MAX_BYTES = 1024 * 1024;
/** Room for problems in a reply, which holds 2000 characters. */
const PROBLEMS_MAX = 1700;
const LOG_SIZE = 30;
const LOG_PAGE_SIZE = 10;

/**
 * `!settings export`, `import` and `log`, for the guild owner and members
 * with Administrator. A stopgap until the web interface edits the settings.
 */
export const settingsCommands = Effect.fnUntraced(function* () {
  const http = yield* Effect.context<HttpClient.HttpClient | Dns.Dns>();

  const exportSettings = defineCommand({
    name: "export",
    description: "Get the bot settings as a JSON file to edit and import again.",
    adminOnly: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const settings = yield* Settings.current;
        const data = new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`);
        yield* ctx.reply({
          content: `The bot settings. Edit them and send them back with \`${settings.prefix}settings import\`.`,
          files: [{ name: "settings.json", data }],
        });
      }),
  });

  const importSettings = defineCommand({
    name: "import",
    description: "Replace all bot settings with an attached JSON file, like the one export gives you.",
    options: [
      { name: "file", description: "The settings as JSON", type: "attachment", attachedOnly: true },
    ] as const,
    adminOnly: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const { file } = ctx.options;
        // Fluxer picks an attachment's URL, so its host is trusted even on a
        // private network; links never get here.
        const { client } = yield* Fluxer;
        const bytes = yield* downloadFile(file.url, {
          noun: "file",
          maxBytes: MAX_BYTES,
          trusted: [client.instance.endpoints.media, file.url],
        }).pipe(Effect.provideContext(http));
        const raw = yield* parseJson(bytes);

        const settings = yield* Settings;
        const result = yield* Effect.result(settings.replace(raw, ctx.userId));
        if (Result.isFailure(result)) {
          if (result.failure._tag === "FluxerError") return yield* result.failure;
          return yield* ctx.error(`The settings weren't changed:\n${problemBlock(result.failure.problems)}`);
        }
        const changed = result.success;
        yield* ctx.reply(
          changed.length === 0
            ? "That's what the settings are already; nothing changed."
            : `Changed ${list(changed)}. The new settings apply right away.`,
        );
      }),
  });

  const log = defineCommand({
    name: "log",
    description: "Show who changed the bot settings lately, and what.",
    adminOnly: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const changes = yield* (yield* Settings).history(LOG_SIZE);
        yield* ctx.replyPages(embedPages("Settings changes", changes.map(describe), LOG_PAGE_SIZE));
      }),
  });

  const group: CommandGroup = {
    name: "settings",
    description: "The bot settings.",
    subcommands: [exportSettings, importSettings, log],
  };
  return group;
});

function parseJson(bytes: Uint8Array) {
  return Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: (err) => err,
  }).pipe(
    Effect.catch((err) =>
      refuse(
        err instanceof SyntaxError ? `That file isn't valid JSON: ${err.message}` : "That file isn't UTF-8 text.",
      ),
    ),
  );
}

/** As many problems as fit in a code block, and how many are left out. */
function problemBlock(problems: readonly string[]): string {
  const shown: string[] = [];
  let length = 0;
  for (const problem of problems) {
    const line = problem.length > 300 ? `${problem.slice(0, 299)}…` : problem;
    if (length + line.length > PROBLEMS_MAX) break;
    shown.push(line);
    length += line.length + 1;
  }
  const left = problems.length - shown.length;
  return `\`\`\`\n${shown.join("\n")}\n\`\`\`${left > 0 ? `\n…and ${left} more.` : ""}`;
}

/** e.g. "<t:…:R> <@123> changed `emoji` and `starboard`" */
function describe(change: SettingsChange): string {
  const when = timestamp(change.changedAt);
  if (change.source === "defaults") return `${when} set to the defaults when the bot joined`;
  return `${when} <@${change.changedBy}> changed ${list(change.sections as SettingsSection[])}`;
}

/** `` `a` ``, `` `a` and `b` ``, `` `a`, `b` and `c` `` */
function list(sections: readonly string[]): string {
  const names = sections.map((s) => `\`${s}\``);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
