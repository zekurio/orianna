import {
  type AllowedMentionsOptions,
  EmbedBuilder,
  type MessageEditOptions,
  type MessageSendOptions,
} from "@fluxerjs/core";
import type { Embed, MessageBody } from "./body.ts";

/** Nobody is notified. */
export const NO_MENTIONS: AllowedMentionsOptions = { parse: [] };

/**
 * Only `@everyone` and `@here` notify. Fluxer can't allow one without the
 * other, so text from users has to go through `defuseEveryone` first.
 */
export const EVERYONE_MENTIONS: AllowedMentionsOptions = { parse: ["everyone"] };

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
  if (embed.author) builder.setAuthor({ name: embed.author.name, iconURL: embed.author.iconUrl });
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  if (embed.fields?.length) builder.setFields(...embed.fields);
  if (embed.footer) builder.setFooter({ text: embed.footer });
  if (embed.image) builder.setImage(embed.image);
  if (embed.thumbnail) builder.setThumbnail(embed.thumbnail);
  if (embed.timestamp) builder.setTimestamp(embed.timestamp);
  return builder;
}
