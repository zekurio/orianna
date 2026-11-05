import { Data, Effect } from "effect";
import type { Attachment, OptionSpec, OptionValue } from "./command.ts";

/** A user-facing problem with the arguments; the router replies with usage. */
export class ArgumentError extends Data.TaggedError("ArgumentError")<{ readonly message: string }> {}

const wrong = (message: string) => Effect.fail(new ArgumentError({ message }));

/** Splits off the first word. Returns null when the input is blank. */
export function nextWord(input: string): { word: string; rest: string } | null {
  const match = /^\s*(\S+)/.exec(input);
  if (!match) return null;
  return { word: match[1]!, rest: input.slice(match[0].length) };
}

/**
 * Opens or closes a quoted value. Phones turn `"` into curly or
 * language-specific quotes, so any double quote counts. Single quotes don't,
 * for values like `"Let's go"`.
 */
const QUOTE = /["“”„‟«»]/;

/** A word of the input, or a quoted value; `start` and `end` index the input. */
interface Token {
  text: string;
  quoted: boolean;
  /** A quote that runs to the end of the input. */
  unclosed: boolean;
  start: number;
  end: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }
    if (QUOTE.test(input[i]!)) {
      const close = input.slice(i + 1).search(QUOTE);
      const inner = close === -1 ? input.length : i + 1 + close;
      tokens.push({
        text: input.slice(i + 1, inner),
        quoted: true,
        unclosed: close === -1,
        start: i,
        end: Math.min(inner + 1, input.length),
      });
      i = inner + 1;
      continue;
    }
    const word = /^\S+/.exec(input.slice(i))![0];
    tokens.push({ text: word, quoted: false, unclosed: false, start: i, end: i + word.length });
    i += word.length;
  }
  return tokens;
}

/**
 * Parses prefix-command input against option specs, all by position, the way
 * chat bots took arguments before slash commands. A value with spaces goes in
 * quotes; an empty pair of quotes leaves an optional value out, to get to the
 * ones after it. A `rest` option takes the remaining text as typed, quotes
 * included. Attachment options take the message's attachments in order, then
 * links from the input wherever they are, so a file can be linked instead of
 * attached; a quoted link stays text.
 */
export function parseOptions(
  specs: readonly OptionSpec[],
  input: string,
  attachments: readonly Attachment[],
): Effect.Effect<Record<string, OptionValue>, ArgumentError> {
  return Effect.gen(function* () {
    const options: Record<string, OptionValue> = {};
    const tokens = tokenize(input);

    let wanted = specs.filter((s) => s.type === "attachment").length - attachments.length;
    const links: Attachment[] = [];
    const taken = new Set<Token>();
    for (const token of tokens) {
      if (wanted <= 0) break;
      const link = token.quoted ? undefined : linkOf(token.text);
      if (!link) continue;
      links.push(link);
      taken.add(token);
      wanted--;
    }
    const words = tokens.filter((t) => !taken.has(t));
    let next = 0;
    let nextAttachment = 0;
    let nextLink = 0;

    const missing = (spec: OptionSpec) =>
      spec.required !== false ? wrong(`missing ${spec.name}`) : Effect.void;

    for (const spec of specs) {
      if (spec.type === "attachment") {
        const file = attachments[nextAttachment++] ?? links[nextLink++];
        if (file?.linked && spec.attachedOnly) yield* wrong(`attach ${spec.name} to the message; links aren't taken`);
        if (file) options[spec.name] = file;
        else yield* missing(spec);
        continue;
      }

      if (spec.rest) {
        const first = words[next];
        next = words.length;
        const text = first ? textFrom(input, first.start, taken).trim() : "";
        if (text) options[spec.name] = text;
        else yield* missing(spec);
        continue;
      }

      const token = words[next++];
      if (!token || (token.quoted && token.text === "")) {
        yield* missing(spec);
        continue;
      }
      if (token.unclosed) yield* wrong("one of the quotes isn't closed");
      options[spec.name] = yield* convert(spec, token.text);
    }

    const extra = words[next];
    if (extra) return yield* wrong(`unexpected argument: ${extra.text}`);
    return options;
  });
}

/** The input from `start` on as typed, without the links attachments took. */
function textFrom(input: string, start: number, taken: ReadonlySet<Token>): string {
  let text = "";
  let at = start;
  for (const token of [...taken].filter((t) => t.start >= start).sort((a, b) => a.start - b.start)) {
    text += input.slice(at, token.start);
    at = token.end;
  }
  return text + input.slice(at);
}

/**
 * A word that is an http(s) link, optionally in `<...>` to suppress the embed.
 * Only http(s) is recognised, so nothing like `file://` ever reaches `fetch`.
 */
function linkOf(word: string): Attachment | undefined {
  const url = /^<?(https?:\/\/[^\s<>]+)>?$/i.exec(word)?.[1];
  if (!url || !URL.canParse(url)) return undefined;
  const { pathname, hostname } = new URL(url);
  const filename = pathname.split("/").at(-1) || hostname;
  return { url, filename, contentType: null, size: null, linked: true };
}

function convert(spec: OptionSpec, text: string): Effect.Effect<OptionValue, ArgumentError> {
  if (spec.type === "integer") {
    if (!/^-?\d+$/.test(text)) return wrong(`${spec.name} must be a whole number`);
    return Effect.succeed(Number(text));
  }
  return Effect.succeed(text);
}
