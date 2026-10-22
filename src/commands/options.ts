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
 * Parses prefix-command input against option specs. Words fill string and
 * integer options in order; attachment options take the message's attachments
 * in order.
 */
export function parseOptions(
  specs: readonly OptionSpec[],
  input: string,
  attachments: readonly Attachment[],
): Record<string, OptionValue> {
  const options: Record<string, OptionValue> = {};
  let remaining = input;
  let nextAttachment = 0;

  const missing = (spec: OptionSpec) => {
    if (spec.required !== false) throw new ArgumentError(`missing ${spec.name}`);
  };

  for (const spec of specs) {
    if (spec.type === "attachment") {
      const attachment = attachments[nextAttachment++];
      if (attachment) options[spec.name] = attachment;
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

    if (spec.type === "integer") {
      if (!/^-?\d+$/.test(next.word)) {
        throw new ArgumentError(`${spec.name} must be a whole number`);
      }
      options[spec.name] = Number(next.word);
    } else {
      options[spec.name] = next.word;
    }
  }

  const extra = nextWord(remaining);
  if (extra) throw new ArgumentError(`unexpected argument: ${extra.word}`);
  return options;
}
