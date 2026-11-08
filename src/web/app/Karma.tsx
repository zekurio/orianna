import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowClockwise, GearSix, MagnifyingGlass, ThumbsUp } from "@phosphor-icons/react";
import { cn } from "cn";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Placeholder, TextSkeleton } from "@/components/loading";
import { PageHeader } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import type { KarmaBoard, KarmaEntry } from "../rpc.ts";
import { Api, KARMA_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";
import { useGuild } from "./guild.tsx";
import { KarmaSettings, karmaSetupQuery } from "./KarmaForm.tsx";
import { useKarmaView } from "./karmaView.ts";

// The server's karma scoreboard, as shinpuru's `/karma` shows it, with a
// search for members further down. Members with `karma.config` change karma
// here too. A member's own karma is on their profile.

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
              <Button variant="outline" className="max-sm:w-8 max-sm:px-0" onClick={() => setSettingsOpen(true)}>
                <GearSix />
                <span className="max-sm:sr-only">Settings</span>
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
  const { id: guildId } = useGuild();
  const { settingsOpen, setSettingsOpen } = useKarmaView();
  // Loaded with the page, so the form is there as soon as the dialog opens.
  useAtomMount(karmaSetupQuery(guildId));
  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Karma settings</DialogTitle>
        </DialogHeader>
        <KarmaSettings onCancel={() => setSettingsOpen(false)} onDone={() => setSettingsOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** {@link Board} while it loads. */
function BoardSkeleton() {
  return (
    <Placeholder label="Loading karma" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-full rounded-lg sm:max-w-sm" />
      <ScoreboardSkeleton />
    </Placeholder>
  );
}

function ScoreboardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-3 sm:px-5">
            <TextSkeleton className="w-5" />
            <Skeleton className="size-8 rounded-full" />
            <TextSkeleton className={i % 2 ? "w-28" : "w-40"} />
            <TextSkeleton className="ml-auto w-8" />
          </li>
        ))}
      </ul>
    </Card>
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
        <EmptyDescription>Members give each other karma by reacting to messages.</EmptyDescription>
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
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 300);
  // Back to the scoreboard as soon as the box is empty.
  const search = query.trim() ? debounced : "";
  if (board.top.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ThumbsUp />
          </EmptyMedia>
          <EmptyTitle>Nobody has karma here yet</EmptyTitle>
          <EmptyDescription>Members get it when others react to their messages.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <InputGroup className="h-9 sm:max-w-sm">
        <InputGroupAddon>
          <MagnifyingGlass />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          placeholder="Search members"
          aria-label="Search members"
          maxLength={100}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </InputGroup>
      {search ? <SearchResults key={search} query={search} /> : <Scoreboard entries={board.top} />}
    </div>
  );
}

/** The members matching a search, with their places on the whole scoreboard. */
function SearchResults({ query }: { query: string }) {
  const { id: guildId } = useGuild();
  const results = useAtomValue(Api.query("karmaSearch", { guildId, query }, { reactivityKeys: KARMA_KEYS }));
  return AsyncResult.matchWithError(results, {
    onInitial: () => (
      <Placeholder label="Searching">
        <ScoreboardSkeleton rows={3} />
      </Placeholder>
    ),
    onError: () => <Problem />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MagnifyingGlass />
            </EmptyMedia>
            <EmptyTitle>No one called "{query}" has karma</EmptyTitle>
            <EmptyDescription>Members show up here once they have some.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Scoreboard entries={value} />
      ),
  });
}

function Scoreboard({ entries }: { entries: readonly KarmaEntry[] }) {
  const { user } = useSession();
  return (
    <Card className="gap-0 py-0">
      <ol className="divide-y">
        {entries.map((entry) => (
          <li key={entry.userId} className="flex items-center gap-3 px-3 py-3 sm:px-5">
            <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{entry.rank}</span>
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
  );
}

/** `value`, once it has stayed the same for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
