// Messages the bot sends, as plain data. Only messages/fluxer.ts turns them
// into fluxer.js payloads, so features and commands don't depend on its types.
//
// Embeds are for messages that stay up and get read again: role menus, help,
// lists. Replies in a conversation, errors included, stay plain text.

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  /** 24-bit RGB. */
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  /** An http(s) URL, or `attachment://name` for a file sent with the message. */
  image?: string;
  thumbnail?: string;
}

/** Plain text, or text and embeds. */
export type MessageBody = string | { content?: string; embeds?: Embed[] };

/** Colour of standing messages. */
export const ACCENT = 0xc8a45a;

/**
 * Adds `text` to the footer of the last embed, or as an italic line under the
 * text when the body has no embed.
 */
export function appendFooter(body: MessageBody, text: string): MessageBody {
  const below = (content: string | undefined) =>
    [content, `*${text}*`].filter(Boolean).join("\n\n");
  if (typeof body === "string") return below(body);

  const embeds = body.embeds ?? [];
  const last = embeds.at(-1);
  if (!last) return { ...body, content: below(body.content) };
  const footer = last.footer ? `${last.footer} · ${text}` : text;
  return { ...body, embeds: [...embeds.slice(0, -1), { ...last, footer }] };
}

/**
 * Puts a zero-width space after the `@` of `@everyone` and `@here`. The text
 * looks the same but can't notify anyone, even in a message that lets the
 * bot's own `@here` through.
 */
export function defuseEveryone(text: string): string {
  return text.replace(/@(everyone|here)/gi, "@\u200B$1");
}

/** One embed per page, each listing up to `perPage` of the lines. */
export function embedPages(
  title: string,
  lines: readonly string[],
  perPage: number,
): MessageBody[] {
  const pages: MessageBody[] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    const description = lines.slice(i, i + perPage).join("\n");
    pages.push({ embeds: [{ title, description, color: ACCENT }] });
  }
  return pages;
}
