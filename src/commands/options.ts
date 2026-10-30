import { type Attachment, type OptionSpec, type OptionValue, UserError } from "./command.ts";

/** A user-facing problem with the arguments; the router replies with usage. */
export class ArgumentError extends UserError {
  override name = "ArgumentError";
}

/** Splits off the first word. Returns null when the input is blank. */
export function nextWord(input: string): { word: string; rest: string } | null {
  const match = /^\s*(\S+)/.exec(input);
  if (!match) return null;
  return { word: match[1]!, rest: input.slice(match[0].length) };
}

/**
 * Parses prefix-command input against option specs. Named options are taken
 * out first (`--name value`, see {@link OptionSpec.named}); the remaining words
 * fill string and integer options in order. Attachment options take the
 * message's attachments in order, then links from the input once those run
 * out, so a file can be linked instead of attached. A link in a named value
 * counts too when nothing earlier filled the attachment; otherwise it stays in
 * the value as text.
 */
export function parseOptions(
  specs: readonly OptionSpec[],
  input: string,
  attachments: readonly Attachment[],
): Record<string, OptionValue> {
  const options: Record<string, OptionValue> = {};
  const { positional, named } = splitNamed(specs, input);
  const slots = specs.filter((s) => s.type === "attachment").length;
  const { text, links } = slots > 0 ? splitLinks(positional) : { text: positional, links: [] };
  let wanted = slots - attachments.length - links.length;
  for (const [name, value] of named) {
    if (wanted <= 0) break;
    const found = splitLinks(value, wanted);
    if (found.links.length === 0) continue;
    links.push(...found.links);
    wanted -= found.links.length;
    // A value that was only the link counts as not given.
    const rest = found.text.trim();
    if (rest) named.set(name, rest);
    else named.delete(name);
  }
  let remaining = text;
  let nextAttachment = 0;
  let nextLink = 0;

  const missing = (spec: OptionSpec) => {
    if (spec.required !== false) throw new ArgumentError(`missing ${spec.name}`);
  };

  for (const spec of specs) {
    if (spec.named) {
      const text = named.get(spec.name);
      if (text === undefined) missing(spec);
      else options[spec.name] = convert(spec, text);
      continue;
    }

    if (spec.type === "attachment") {
      const file = attachments[nextAttachment++] ?? links[nextLink++];
      if (file) options[spec.name] = file;
      else missing(spec);
      continue;
    }

    if (spec.rest) {
      const text = remaining.trim();
      remaining = "";
      if (text) options[spec.name] = text;
      else missing(spec);
      continue;
    }

    const next = nextWord(remaining);
    if (!next) {
      missing(spec);
      continue;
    }
    remaining = next.rest;
    options[spec.name] = convert(spec, next.word);
  }

  const extra = nextWord(remaining)?.word ?? links[nextLink]?.url;
  if (extra) throw new ArgumentError(`unexpected argument: ${extra}`);
  return options;
}

/** A whole word that is an http(s) link, optionally in `<...>` to suppress the embed. */
const LINK = /(^|\s)<?(https?:\/\/[^\s<>]+)>?(?=\s|$)/gi;

/**
 * Takes up to `limit` links out of the input, leaving the other words in place.
 * Only http(s) is recognised, so nothing like `file://` ever reaches `fetch`.
 */
function splitLinks(input: string, limit = Infinity): { text: string; links: Attachment[] } {
  const links: Attachment[] = [];
  const text = input.replace(LINK, (word, space: string, url: string) => {
    if (links.length >= limit || !URL.canParse(url)) return word;
    const { pathname, hostname } = new URL(url);
    const filename = pathname.split("/").at(-1) || hostname;
    links.push({ url, filename, contentType: null, size: null, linked: true });
    return space;
  });
  return { text, links };
}

function convert(spec: OptionSpec, text: string): OptionValue {
  if (spec.type === "integer") {
    if (!/^-?\d+$/.test(text)) throw new ArgumentError(`${spec.name} must be a whole number`);
    return Number(text);
  }
  return text;
}

const FLAG = /(^|\s)--([A-Za-z][\w-]*)(?=\s|$)/g;

/**
 * Splits `positional --a one --b two words` into the positional part and the
 * named values. Only `--word` at the start of a word counts, so a lone `--` or
 * `a--b` in free text is left alone. A command without named options takes
 * every `--word` as text, as in `!poll Should we --force push?`.
 */
function splitNamed(specs: readonly OptionSpec[], input: string) {
  const known = new Set(specs.filter((s) => s.named).map((s) => s.name));
  const named = new Map<string, string>();
  if (known.size === 0) return { positional: input, named };
  const flags = [...input.matchAll(FLAG)];
  if (flags.length === 0) return { positional: input, named };

  flags.forEach((match, i) => {
    const name = match[2]!.toLowerCase();
    if (!known.has(name)) throw new ArgumentError(`unknown option --${name}`);
    if (named.has(name)) throw new ArgumentError(`--${name} was given twice`);

    const start = match.index + match[0].length;
    const end = flags[i + 1]?.index ?? input.length;
    const value = input.slice(start, end).trim();
    if (!value) throw new ArgumentError(`--${name} needs a value`);
    named.set(name, value);
  });
  return { positional: input.slice(0, flags[0]!.index), named };
}
