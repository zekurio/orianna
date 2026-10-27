import {
  type AllowedMentionsOptions,
  EmbedBuilder,
  type MessageEditOptions,
  type MessageSendOptions,
} from "@fluxerjs/core";
import type { Embed, MessageBody } from "./body.ts";

/** Nobody is notified. */
export const NO_MENTIONS: AllowedMentionsOptions = { parse: [] };

/** Every mention in the text notifies, `@everyone` and `@here` included. */
export const ALL_MENTIONS: AllowedMentionsOptions = { parse: ["users", "roles", "everyone"] };

/**
 * Only the author of the message being replied to is notified. Replies can
 * echo what the user typed, so a name like `@everyone` mustn't ping anyone.
 */
export const REPLY_MENTION: AllowedMentionsOptions = { parse: [], repliedUser: true };

export function sendOptions(
  body: MessageBody,
  allowedMentions: AllowedMentionsOptions,
): MessageSendOptions {
  const { content, embeds } = split(body);
  return {
    content,
    embeds: embeds.length > 0 ? embeds.map(toBuilder) : undefined,
    allowedMentions,
  };
}

/** Like {@link sendOptions}, but clears the text or embeds the new body leaves out. */
export function editOptions(
  body: MessageBody,
  allowedMentions: AllowedMentionsOptions,
): MessageEditOptions {
  const { content, embeds } = split(body);
  return { content: content ?? null, embeds: embeds.map(toBuilder), allowedMentions };
}

function split(body: MessageBody): { content?: string; embeds: Embed[] } {
  return typeof body === "string"
    ? { content: body, embeds: [] }
    : { content: body.content, embeds: body.embeds ?? [] };
}

/** Goes through the builder's setters, which throw a RangeError past Fluxer's limits. */
function toBuilder(embed: Embed): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  if (embed.fields?.length) builder.setFields(...embed.fields);
  if (embed.footer) builder.setFooter({ text: embed.footer });
  if (embed.image) builder.setImage(embed.image);
  if (embed.thumbnail) builder.setThumbnail(embed.thumbnail);
  return builder;
}
