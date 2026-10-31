import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowClockwise, CheckCircle, EyeSlash, File, GearSix, SortDescending, Star } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { type MouseEvent, type ReactNode, useState } from "react";
import { PageHeader } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  type Names,
  STARBOARD_PAGE_SIZE,
  type StarboardEntry as Entry,
  type StarboardInfo,
  type StarboardSort,
} from "../rpc.ts";
import { Api, STARBOARD_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";
import { inlineEmoji, MessageText } from "./MessageText.tsx";
import { StarboardSettings } from "./StarboardForm.tsx";

// The starboard, as shinpuru's web interface shows it: the entries, latest
// or top posts first, and more on request. Members with `starboard.config`
// change it here too, like `!starboard set` and `disable`.

const SORT_LABELS: Record<StarboardSort, string> = { latest: "Latest first", top: "Top posts first" };

const entriesQuery = (sort: StarboardSort, offset: number) =>
  Api.query("starboardEntries", { sort, offset }, { reactivityKeys: STARBOARD_KEYS });

export function StarboardPage() {
  const { configStarboard } = useSession();
  const starboard = useAtomValue(Api.query("starboard", undefined, { reactivityKeys: STARBOARD_KEYS }));
  const [sort, setSort] = useState<StarboardSort>("latest");
  // Each page is a query of its own; "Load more ..." adds the next one.
  const [pages, setPages] = useState(1);
  const refresh = useAtomRefresh(entriesQuery(sort, 0));
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string>();

  const info = AsyncResult.isSuccess(starboard) ? starboard.value : null;

  return (
    <>
      <PageHeader
        title="Starboard"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setSort(sort === "latest" ? "top" : "latest");
                setPages(1);
              }}
            >
              <SortDescending />
              {SORT_LABELS[sort]}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh"
              onClick={() => {
                setPages(1);
                refresh();
              }}
            >
              <ArrowClockwise />
            </Button>
            {configStarboard && (
              <Button
                variant={editing ? "secondary" : "outline"}
                aria-pressed={editing}
                onClick={() => {
                  setNotice(undefined);
                  setEditing(!editing);
                }}
              >
                <GearSix />
                Settings
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <Alert role="status">
          <CheckCircle />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {editing && (
        <StarboardSettings
          onCancel={() => setEditing(false)}
          onDone={(message) => {
            setEditing(false);
            setNotice(message);
          }}
        />
      )}
      {AsyncResult.matchWithError(starboard, {
        onInitial: () => <Loading />,
        onError: () => <Problem />,
        onDefect: () => <Problem />,
        onSuccess: () =>
          info ? (
            <div className="flex flex-col gap-4">
              {Array.from({ length: pages }, (_, i) => (
                <EntryPage
                  key={`${sort}/${i}`}
                  starboard={info}
                  sort={sort}
                  offset={i * STARBOARD_PAGE_SIZE}
                  last={i === pages - 1}
                  onMore={() => setPages(pages + 1)}
                />
              ))}
            </div>
          ) : (
            <NothingHere />
          ),
      })}
    </>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Spinner />
      Loading…
    </p>
  );
}

/** shinpuru's empty starboard. */
function NothingHere() {
  const { prefix } = useSession();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Star />
        </EmptyMedia>
        <EmptyTitle>Hm, nothing's going on here ...</EmptyTitle>
        <EmptyDescription>
          Did you already set up the starboard? If not, use the <code>{prefix}starboard</code> command to do so.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function EntryPage({
  starboard,
  sort,
  offset,
  last,
  onMore,
}: {
  starboard: StarboardInfo;
  sort: StarboardSort;
  offset: number;
  last: boolean;
  onMore: () => void;
}) {
  const page = useAtomValue(entriesQuery(sort, offset));
  return AsyncResult.matchWithError(page, {
    onInitial: () => <Loading />,
    onError: () => <Problem />,
    onDefect: () => <Problem />,
    onSuccess: ({ value: { entries, total, names } }) => {
      if (total === 0) return <NothingHere />;
      return (
        <>
          {entries.map((entry) => (
            <EntryCard key={entry.messageId} entry={entry} starboard={starboard} names={names} />
          ))}
          {last && offset + entries.length < total && <Button onClick={onMore}>Load more ...</Button>}
        </>
      );
    },
  });
}

/** An entry; clicking it opens the message in Fluxer, as on shinpuru. */
function EntryCard({ entry, starboard, names }: { entry: Entry; starboard: StarboardInfo; names: Names }) {
  const images = entry.media.filter((m) => m.kind === "image");
  const videos = entry.media.filter((m) => m.kind === "video");
  const files = entry.media.filter((m) => m.kind === "file");
  const open = (event: MouseEvent) => {
    // Links, spoilers and videos in the entry do their own thing.
    if ((event.target as Element).closest("a, button, video")) return;
    window.open(entry.messageUrl, "_blank", "noopener");
  };
  return (
    <Card className="cursor-pointer transition-transform duration-200 hover:scale-[1.01]" onClick={open}>
      <CardHeader className="flex items-center gap-3">
        <Avatar className="size-8">
          {entry.authorAvatar && <AvatarImage src={entry.authorAvatar} alt="avatar" />}
          <AvatarFallback>{entry.authorName?.slice(0, 1) ?? "?"}</AvatarFallback>
        </Avatar>
        <CardTitle className="min-w-0 truncate">
          <a href={entry.messageUrl} target="_blank" rel="noreferrer noopener" className="text-foreground">
            {entry.authorName ?? "A member"}
          </a>
        </CardTitle>
        <span className="flex items-center gap-1.5 text-primary" title={`${entry.score} votes`}>
          <StarboardEmoji starboard={starboard} />
          {entry.score}
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 rounded-lg bg-background p-3">
          {entry.content === null ? (
            <p className="text-sm text-muted-foreground">
              The bot hasn't caught up on this entry yet. Open it in Fluxer to read it.
            </p>
          ) : (
            entry.content && <MessageText text={entry.content} names={names} />
          )}
          {(images.length > 0 || videos.length > 0) && (
            <div className="flex gap-2">
              {images.map((m) => (
                <MediaTile key={m.url} blurred={m.blurred}>
                  <img src={m.url} alt={m.name} loading="lazy" className="max-h-80 w-full object-contain object-left-top" />
                </MediaTile>
              ))}
              {videos.map((m) => (
                <MediaTile key={m.url}>
                  <video className="max-h-80 w-full object-contain object-left-top" src={m.url} controls preload="metadata" />
                </MediaTile>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {files.map((m) => (
                <li key={m.url}>
                  <Button variant="outline" size="sm" asChild>
                    <a href={m.url} target="_blank" rel="noreferrer noopener">
                      <File />
                      {m.name}
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MediaTile({ blurred, children }: { blurred?: boolean | undefined; children: ReactNode }) {
  return (
    <div className="relative min-w-0 flex-1">
      {children}
      {blurred && (
        <Badge variant="secondary" className="absolute bottom-2 left-2 bg-background/85">
          <EyeSlash />
          NSFW, blurred
        </Badge>
      )}
    </div>
  );
}

function StarboardEmoji({ starboard }: { starboard: Pick<StarboardInfo, "emoji" | "emojiUrl"> }) {
  if (starboard.emojiUrl) return <img className={inlineEmoji} src={starboard.emojiUrl} alt={starboard.emoji} />;
  return <span className="text-[1.1em] leading-none">{starboard.emoji}</span>;
}
