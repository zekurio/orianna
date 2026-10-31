import { type ReactNode, useState } from "react";
import type { Names } from "../rpc.ts";

// Message text as Fluxer shows it, as far as a board needs: mentions, custom
// emoji, links, bold, inline code and spoilers. Everything else stays as typed.

const TOKEN =
  /<@!?(\d+)>|<#(\d+)>|<(a?):(\w+):(\d+)>|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\|\|([^|]+)\|\||(https?:\/\/[^\s<>]+)/g;

export function MessageText({ text, names }: { text: string; names: Names }) {
  return <div className="message-text">{render(text, names)}</div>;
}

function render(text: string, names: Names): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, user, channel, , emojiName, emojiId, code, bold, spoiler, link] = match;
    const key = match.index;
    if (user) {
      out.push(
        <span key={key} className="mention">
          @{names.users[user] ?? "unknown member"}
        </span>,
      );
    } else if (channel) {
      out.push(
        <span key={key} className="mention">
          #{names.channels[channel] ?? "private channel"}
        </span>,
      );
    } else if (emojiId) {
      const url = names.emojis[emojiId];
      out.push(
        url ? (
          <img key={key} className="inline-emoji" src={url} alt={`:${emojiName}:`} title={`:${emojiName}:`} />
        ) : (
          `:${emojiName}:`
        ),
      );
    } else if (code) {
      out.push(<code key={key}>{code}</code>);
    } else if (bold) {
      out.push(<strong key={key}>{render(bold, names)}</strong>);
    } else if (spoiler) {
      out.push(<Spoiler key={key}>{render(spoiler, names)}</Spoiler>);
    } else if (link) {
      out.push(
        <a key={key} href={link} target="_blank" rel="noreferrer noopener">
          {link}
        </a>,
      );
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return <span className="spoiler shown">{children}</span>;
  return (
    <button type="button" className="spoiler" onClick={() => setShown(true)} aria-label="Show spoiler">
      <span aria-hidden="true">{children}</span>
    </button>
  );
}
