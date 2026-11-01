import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowClockwise, GearSix, ThumbsUp } from "@phosphor-icons/react";
import { cn } from "cn";
import { AsyncResult } from "effect/reactivity";
import { Fragment, type ReactNode, useEffect } from "react";
import { Placeholder, TextSkeleton } from "@/components/loading";
import { PageHeader, SectionTitle } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmojiInfo, KarmaBoard } from "../rpc.ts";
import { Api, KARMA_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";
import { useGuild } from "./guild.tsx";
import { KarmaSettings, karmaSetupQuery } from "./KarmaForm.tsx";
import { useKarmaView } from "./karmaView.ts";
import { inlineEmoji } from "./MessageText.tsx";

// Karma, as shinpuru's `/karma` shows it: the member's own and the server's
// scoreboard. Members with `karma.config` change it here too.

const karmaQuery = (guildId: string) => Api.query("karma", { guildId }, { reactivityKeys: KARMA_KEYS });

export function KarmaPage() {
  const { id: guildId, configKarma } = useGuild();
  const karma = useAtomValue(karmaQuery(guildId));
  const refresh = useAtomRefresh(karmaQuery(guildId));
  const { setSettingsOpen, enter } = useKarmaView();
  useEffect(() => enter(guildId), [guildId]);

  return (
    <>
      <PageHeader
        title="Karma"
        actions={
          <>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={refresh}>
              <ArrowClockwise />
            </Button>
            {configKarma && (
              <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                <GearSix />
                Settings
              </Button>
            )}
          </>
        }
      />
      {configKarma && <SettingsDialog />}
      {AsyncResult.matchWithError(karma, {
        onInitial: () => <BoardSkeleton />,
        onError: () => <Problem />,
        onDefect: () => <Problem />,
        onSuccess: ({ value }) => (value ? <Board board={value} /> : <Off />),
      })}
    </>
  );
}

/** The karma settings, over the page. */
function SettingsDialog() {
  const { id: guildId, prefix } = useGuild();
  const { settingsOpen, setSettingsOpen } = useKarmaView();
  // Loaded with the page, so the form is there as soon as the dialog opens.
  useAtomMount(karmaSetupQuery(guildId));
  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Karma settings</DialogTitle>
          <DialogDescription>
            Same as <code>{prefix}karma set</code>, <code>block</code> and <code>addrule</code>. Changes apply right
            away and show up in <code>{prefix}settings log</code>.
          </DialogDescription>
        </DialogHeader>
        <KarmaSettings onCancel={() => setSettingsOpen(false)} onDone={() => setSettingsOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** {@link Board} while it loads. */
function BoardSkeleton() {
  return (
    <Placeholder label="Loading karma" className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <TextSkeleton className="w-32" />
          <Skeleton className="h-9 w-16" />
          <TextSkeleton className="w-2/3" />
        </CardContent>
      </Card>
      <TextSkeleton className="h-7 w-40" />
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-3">
              <TextSkeleton className="w-5" />
              <Skeleton className="size-8 rounded-full" />
              <TextSkeleton className={i % 2 ? "w-28" : "w-40"} />
              <TextSkeleton className="ml-auto w-8" />
            </li>
          ))}
        </ul>
      </Card>
    </Placeholder>
  );
}

/** Karma while it's off; with a way to set it up for members who may. */
function Off() {
  const { configKarma } = useGuild();
  const setSettingsOpen = useKarmaView((view) => view.setSettingsOpen);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ThumbsUp />
        </EmptyMedia>
        <EmptyTitle>Karma is off here</EmptyTitle>
        <EmptyDescription>
          Once it's on, members give each other karma by reacting to messages, and the starboard adds to it.
        </EmptyDescription>
      </EmptyHeader>
      {configKarma && (
        <EmptyContent>
          <Button onClick={() => setSettingsOpen(true)}>
            <GearSix />
            Set up karma
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function Board({ board }: { board: KarmaBoard }) {
  const { user } = useSession();
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <span className="text-muted-foreground">Your karma here</span>
          <strong className="font-heading text-4xl leading-none text-primary tabular-nums">{board.own}</strong>
          <p className="max-w-[72ch] text-sm text-muted-foreground">
            <HowItWorks board={board} />
          </p>
        </CardContent>
      </Card>
      <section className="flex flex-col gap-3">
        <SectionTitle>Scoreboard</SectionTitle>
        {board.top.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ThumbsUp />
              </EmptyMedia>
              <EmptyTitle>Nobody has karma here yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="gap-0 py-0">
            <ol className="divide-y">
              {board.top.map((entry, i) => (
                <li key={entry.userId} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                  <Avatar className="size-8">
                    <AvatarImage src={entry.avatarUrl} alt="" />
                    <AvatarFallback>{entry.name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate">
                    {entry.name}
                    {entry.userId === user.id && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <strong className={cn("tabular-nums", entry.value < 0 ? "text-destructive" : "text-primary")}>
                    {entry.value}
                  </strong>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </section>
    </>
  );
}

/** What gives and takes karma here, in a few sentences. */
function HowItWorks({ board }: { board: KarmaBoard }) {
  const { upvotes, downvotes, votesPerHour, penalty, starboardGain } = board;
  const votes =
    upvotes.length > 0 && downvotes.length > 0 ? (
      <>
        React with <Emojis list={upvotes} /> to give the author of a message a point, or <Emojis list={downvotes} /> to
        take one.
      </>
    ) : upvotes.length > 0 ? (
      <>
        React with <Emojis list={upvotes} /> to give the author of a message a point.
      </>
    ) : downvotes.length > 0 ? (
      <>
        React with <Emojis list={downvotes} /> to take a point from the author of a message.
      </>
    ) : null;
  return (
    <>
      {votes && (
        <>
          {votes} You can vote {votesPerHour === 1 ? "once" : `${votesPerHour} times`} an hour, once per message
          {penalty && downvotes.length > 0 ? ", and a downvote costs you a point too" : ""}.{" "}
        </>
      )}
      {starboardGain > 0 && (
        <>
          A message that gets into the starboard gives its author {starboardGain} {starboardGain === 1 ? "point" : "points"}.
        </>
      )}
    </>
  );
}

/** Emoji like "👍, 👌 or ✅". */
function Emojis({ list }: { list: readonly EmojiInfo[] }) {
  return list.map((emoji, i) => {
    const separator: ReactNode = i === 0 ? null : i === list.length - 1 ? " or " : ", ";
    return (
      <Fragment key={emoji.emoji}>
        {separator}
        {emoji.url ? (
          <img className={inlineEmoji} src={emoji.url} alt={emoji.emoji} />
        ) : (
          <span className="text-[1.1em] leading-none">{emoji.emoji}</span>
        )}
      </Fragment>
    );
  });
}
