import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { cn } from "cn";
import { AsyncResult } from "effect/reactivity";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { InfoButton } from "@/components/InfoButton";
import { Placeholder, TextSkeleton } from "@/components/loading";
import { SettingsGroup } from "@/components/settings";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmojiInfo, KarmaOff, KarmaStanding } from "../rpc.ts";
import { Api, KARMA_KEYS } from "./api.ts";
import { guildPath } from "./guild.tsx";
import { GuildIcon } from "./Header.tsx";
import { inlineEmoji } from "./MessageText.tsx";
import { Link } from "./router.tsx";

// The member's karma on the profile: one row for each server, with their
// place on its scoreboard and the votes they have left. Servers where karma
// is off are greyed out. How karma works in a server is behind the row's
// info button.

const myKarmaQuery = Api.query("myKarma", undefined, { reactivityKeys: KARMA_KEYS });

export function ProfileKarma() {
  const standings = useAtomValue(myKarmaQuery);
  return (
    <SettingsGroup title="Karma">
      {AsyncResult.matchWithError(standings, {
        onInitial: () => <StandingsSkeleton />,
        onError: () => <Note>Couldn't load your karma.</Note>,
        onDefect: () => <Note>Couldn't load your karma.</Note>,
        onSuccess: ({ value }) => (
          <ul className="divide-y">
            {value.map((standing) =>
              "off" in standing ? (
                <Off key={standing.guild.id} standing={standing} />
              ) : (
                <Standing key={standing.guild.id} standing={standing} />
              ),
            )}
          </ul>
        ),
      })}
    </SettingsGroup>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-5 py-4 text-muted-foreground">{children}</p>;
}

function StandingsSkeleton() {
  return (
    <Placeholder label="Loading your karma">
      <ul className="divide-y">
        {Array.from({ length: 2 }, (_, i) => (
          <li key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="size-10 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <TextSkeleton className={i % 2 ? "w-28" : "w-40"} />
              <TextSkeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-7 w-10" />
          </li>
        ))}
      </ul>
    </Placeholder>
  );
}

/** A server's row: its icon and name, the votes left, the member's karma and place, and how karma works there. */
function Standing({ standing }: { standing: KarmaStanding }) {
  const { guild, own, rank } = standing;
  const voting = standing.upvotes.length > 0 || standing.downvotes.length > 0;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-4 px-5 py-4">
      <GuildIcon guild={guild} className="size-10" />
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          to={guildPath(guild.id, "/karma")}
          className="truncate font-medium text-foreground"
          title={`${guild.name}'s scoreboard`}
        >
          {guild.name}
        </Link>
        {voting && <Votes standing={standing} />}
      </div>
      <div className="flex flex-col items-end">
        <strong
          className={cn(
            "font-heading text-2xl leading-tight font-semibold tabular-nums",
            own < 0 ? "text-destructive" : "text-primary",
          )}
        >
          {own}
        </strong>
        {rank !== null && <span className="text-xs text-muted-foreground">{ordinal(rank)}</span>}
      </div>
      <InfoButton label="How karma works here" title={`Karma in ${guild.name}`}>
        <Rules standing={standing} />
      </InfoButton>
    </li>
  );
}

/** A server where karma is off, greyed out, with what the member had when it was on. */
function Off({ standing: { guild, own } }: { standing: KarmaOff }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-4 opacity-50 grayscale">
      <GuildIcon guild={guild} className="size-10" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{guild.name}</span>
        <span className="text-sm text-muted-foreground">Off</span>
      </div>
      <strong className="font-heading text-2xl leading-tight font-semibold text-muted-foreground tabular-nums">
        {own}
      </strong>
    </li>
  );
}

/** 1st, 2nd, 3rd, 4th… */
function ordinal(n: number): string {
  const suffix: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };
  return `${n}${suffix[new Intl.PluralRules("en", { type: "ordinal" }).select(n)]}`;
}

/** Past this many votes an hour, the meter is one bar instead of a segment per vote. */
const MAX_SEGMENTS = 12;

const minutes = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** How many votes the member has left this hour, as a meter, and when the next comes back once they're out. */
function Votes({ standing }: { standing: KarmaStanding }) {
  const refresh = useAtomRefresh(myKarmaQuery);
  const { votesPerHour, votesLeft, nextVoteAt, blocked } = standing;
  const now = useNow(nextVoteAt === null ? null : 30_000);
  // Ask again once a vote is back, so the meter fills up without a reload.
  useEffect(() => {
    if (nextVoteAt === null) return;
    const timer = setTimeout(refresh, Math.max(0, nextVoteAt - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [nextVoteAt]);

  if (blocked) return <p className="text-sm text-muted-foreground">Your votes don't count here.</p>;
  return (
    <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
      <div className="flex h-1.5 w-20 shrink-0 gap-0.5" aria-hidden>
        {votesPerHour <= MAX_SEGMENTS ? (
          Array.from({ length: votesPerHour }, (_, i) => (
            <span key={i} className={cn("flex-1 rounded-full", i < votesLeft ? "bg-primary" : "bg-border")} />
          ))
        ) : (
          <span className="flex-1 overflow-hidden rounded-full bg-border">
            <span className="block h-full bg-primary" style={{ width: `${(votesLeft / votesPerHour) * 100}%` }} />
          </span>
        )}
      </div>
      <span className="min-w-0">
        {votesLeft > 0
          ? `${votesLeft} of ${votesPerHour} ${votesPerHour === 1 ? "vote" : "votes"} left`
          : nextVoteAt !== null && now !== null
            ? `Out of votes, next one ${minutes.format(Math.max(1, Math.ceil((nextVoteAt - now) / 60_000)), "minute")}`
            : "Out of votes for now"}
      </span>
    </div>
  );
}

/** The time, every `interval` ms; null while `interval` is. */
function useNow(interval: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (interval === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return interval === null ? null : now;
}

/** What gives and takes karma in a server, as a key: what to do, and what it's worth. */
function Rules({ standing }: { standing: KarmaStanding }) {
  const { upvotes, downvotes, penalty, votesPerHour } = standing;
  const up = upvotes.length > 0;
  const down = downvotes.length > 0;
  if (!up && !down) {
    return <p className="text-muted-foreground">Nothing gives karma here right now.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3">
        {up && (
          <Rule symbol={<Emojis list={upvotes} />} amount={1}>
            React to give the author a point
          </Rule>
        )}
        {down && (
          <Rule symbol={<Emojis list={downvotes} />} amount={-1}>
            React to take a point away
            {penalty && <span className="block text-muted-foreground">It costs you a point too.</span>}
          </Rule>
        )}
      </ul>
      {(up || down) && (
        <p className="text-muted-foreground">
          You can vote {votesPerHour === 1 ? "once" : `${votesPerHour} times`} an hour.
        </p>
      )}
    </div>
  );
}

/** A row of {@link Rules}: the reaction or event, what to do, and the points. */
function Rule({ symbol, amount, children }: { symbol: ReactNode; amount: number; children: ReactNode }) {
  return (
    <li className="col-span-3 grid grid-cols-subgrid items-start">
      <span className="flex h-[1.55em] items-center gap-1">{symbol}</span>
      <span>{children}</span>
      <span
        className={cn(
          "pl-4 text-right font-heading font-semibold tabular-nums",
          amount < 0 ? "text-destructive" : "text-primary",
        )}
      >
        {amount < 0 ? `−${-amount}` : `+${amount}`}
      </span>
    </li>
  );
}

/** Emoji side by side, read out as "👍, 👌 or ✅". */
function Emojis({ list }: { list: readonly EmojiInfo[] }) {
  return list.map((emoji, i) => {
    const separator = i === 0 ? null : i === list.length - 1 ? " or " : ", ";
    return (
      <Fragment key={emoji.emoji}>
        {separator && <span className="sr-only">{separator}</span>}
        {emoji.url ? (
          <img className={inlineEmoji} src={emoji.url} alt={emoji.emoji} />
        ) : (
          <span className="text-[1.1em] leading-none">{emoji.emoji}</span>
        )}
      </Fragment>
    );
  });
}
