import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ArrowSquareOut,
  CaretDown,
  ChatCircleText,
  CheckCircle,
  EyeSlash,
  File,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Ranking,
  Sparkle,
  Star,
  Trash,
  TrendUp,
} from "@phosphor-icons/react";
import { cn } from "cn";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useState } from "react";
import { Lead, PageHeader } from "@/components/page";
import { Problem } from "@/components/Problem";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BOARD_PAGE_SIZE, type Board, type BoardPost, type Leader, type Names, type PostSort } from "../rpc.ts";
import { Api, BOARD_KEYS, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";
import { BoardEditor } from "./BoardForm.tsx";
import { inlineEmoji, MessageText, mention } from "./MessageText.tsx";
import { Link, navigate } from "./router.tsx";

// The boards page: each board's posts, newest or most reacted first, and its
// leaderboard, like `!board top`. Members with `boards.remove` can take a
// message off a board, like `!board remove`, and members with `boards.manage`
// set boards up here.

export type BoardView = PostSort | "leaderboard";

const VIEWS: { view: BoardView; label: string; suffix: string; icon: typeof Sparkle }[] = [
  { view: "latest", label: "Latest", suffix: "", icon: Sparkle },
  { view: "top", label: "Top posts", suffix: "/top", icon: TrendUp },
  { view: "leaderboard", label: "Leaderboard", suffix: "/leaderboard", icon: Ranking },
];

/** `/boards`, `/boards/gems`, `/boards/gems/top` and `/boards/gems/leaderboard`. */
export function parseBoardPath(path: string): { board?: string; view: BoardView } | undefined {
  const match = /^\/boards(?:\/([^/]+)(?:\/(top|leaderboard))?)?\/?$/.exec(path);
  if (!match) return undefined;
  return { board: match[1] && decodeURIComponent(match[1]), view: (match[2] as BoardView | undefined) ?? "latest" };
}

const boardPath = (board: string, view: BoardView) =>
  `/boards/${encodeURIComponent(board)}${VIEWS.find((v) => v.view === view)!.suffix}`;

/** Refreshes everything shown of a board once a message comes off it. */
const keysOf = (board: string) => [`board:${board}`];

export function BoardsPage({ board, view }: { board?: string; view: BoardView }) {
  const boards = useAtomValue(Api.query("boards", undefined, { reactivityKeys: BOARD_KEYS }));
  return AsyncResult.matchWithError(boards, {
    onInitial: () => <Heading />,
    onError: () => (
      <>
        <Heading />
        <Problem />
      </>
    ),
    onDefect: () => (
      <>
        <Heading />
        <Problem />
      </>
    ),
    onSuccess: ({ value, waiting }) => (
      <BoardList boards={value.boards} canRemove={value.canRemove} name={board} view={view} refreshing={waiting} />
    ),
  });
}

function Heading() {
  return <PageHeader title="Boards" />;
}

/** The board form that's open: a new board, or the board shown. */
type Editing = "new" | "board" | null;

function BoardList({
  boards,
  canRemove,
  name,
  view,
  refreshing,
}: {
  boards: readonly Board[];
  canRemove: boolean;
  name?: string;
  view: BoardView;
  /** The boards are being loaded again after a change. */
  refreshing: boolean;
}) {
  const { prefix, manageBoards } = useSession();
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string>();
  const first = boards[0];
  const board = boards.find((b) => b.name === name?.toLowerCase());

  useEffect(() => {
    if (name === undefined && first) navigate(boardPath(first.name, "latest"), { replace: true });
  }, [name, first]);
  const open = (next: Editing) => {
    setNotice(undefined);
    setEditing(next);
  };
  const done = (saved: string | null, message: string) => {
    setEditing(null);
    navigate(saved === null ? "/boards" : boardPath(saved, view === "leaderboard" ? view : "latest"));
    setNotice(message);
  };

  const editor = editing && (
    <BoardEditor name={editing === "board" ? board?.name : undefined} onCancel={() => setEditing(null)} onDone={done} />
  );

  if (!first) {
    return (
      <>
        <Heading />
        {notice && <Saved>{notice}</Saved>}
        {editor ?? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Star />
              </EmptyMedia>
              <EmptyTitle>No boards yet</EmptyTitle>
              <EmptyDescription>
                {manageBoards ? (
                  <>
                    Create one, and messages that get enough reactions with its emoji go up in its channel. In chat
                    it's <code>{prefix}board create</code>.
                  </>
                ) : (
                  "Once someone sets one up, messages with enough reactions show up here."
                )}
              </EmptyDescription>
            </EmptyHeader>
            {manageBoards && (
              <EmptyContent>
                <Button onClick={() => open("new")}>
                  <Plus />
                  New board
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </>
    );
  }

  return (
    <>
      <Heading />
      <nav className="-mb-1 flex gap-2 overflow-x-auto pb-1" aria-label="Boards">
        {boards.map((b) => {
          const current = b === board && editing !== "new";
          return (
            <Button key={b.name} variant={current ? "secondary" : "outline"} className="rounded-full" asChild>
              <Link
                to={boardPath(b.name, view)}
                aria-current={current ? "page" : undefined}
                onClick={() => {
                  setEditing(null);
                  setNotice(undefined);
                }}
              >
                <BoardEmoji board={b} />
                {b.name}
              </Link>
            </Button>
          );
        })}
        {manageBoards && (
          <Button
            variant={editing === "new" ? "secondary" : "ghost"}
            className="rounded-full"
            aria-pressed={editing === "new"}
            onClick={() => open("new")}
          >
            <Plus />
            New board
          </Button>
        )}
      </nav>
      {notice && <Saved>{notice}</Saved>}
      {editor ??
        (board ? (
          <BoardPage
            board={board}
            canRemove={canRemove}
            view={view}
            onEdit={manageBoards ? () => open("board") : undefined}
          />
        ) : (
          name !== undefined &&
          !refreshing && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MagnifyingGlass />
                </EmptyMedia>
                <EmptyTitle>No board called {name}</EmptyTitle>
                <EmptyDescription>It doesn't exist, or its channel is hidden from you.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" asChild>
                  <Link to={boardPath(first.name, "latest")}>Go to {first.name}</Link>
                </Button>
              </EmptyContent>
            </Empty>
          )
        ))}
    </>
  );
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <Alert role="status">
      <CheckCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function BoardPage({
  board,
  canRemove,
  view,
  onEdit,
}: {
  board: Board;
  canRemove: boolean;
  view: BoardView;
  /** Opens the board's form, for members who may set up boards. */
  onEdit?: () => void;
}) {
  return (
    <Tabs
      value={view}
      onValueChange={(next) => navigate(boardPath(board.name, next as BoardView))}
      className="gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <Lead>
          When {board.threshold} {board.threshold === 1 ? "member reacts" : "members react"} with{" "}
          <BoardEmoji board={board} />, a message goes up in <span className={mention}>#{board.channelName}</span>.
          {board.keep && " Posts stay up when reactions drop again."}
        </Lead>
        {onEdit && (
          <Button variant="outline" onClick={onEdit}>
            <PencilSimple />
            Edit board
          </Button>
        )}
      </div>
      <TabsList>
        {VIEWS.map(({ view: v, label, icon: ViewIcon }) => (
          <TabsTrigger key={v} value={v}>
            <ViewIcon />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={view}>
        {view === "leaderboard" ? (
          <Leaderboard board={board} />
        ) : (
          <Posts key={`${board.name}/${view}`} board={board} sort={view} canRemove={canRemove} />
        )}
      </TabsContent>
    </Tabs>
  );
}

export function BoardEmoji({ board }: { board: Pick<Board, "emoji" | "emojiUrl"> }) {
  if (board.emojiUrl) return <img className={inlineEmoji} src={board.emojiUrl} alt={board.emoji} />;
  return <span className="text-[1.1em] leading-none">{board.emoji}</span>;
}

/** How many reacted, with the board's emoji. */
function Count({ board, count }: { board: Board; count: number }) {
  return (
    <Badge variant="secondary" className="h-7 gap-1.5 bg-primary/14 px-3 text-sm text-primary" title={`${count} reacted`}>
      <BoardEmoji board={board} />
      {count}
    </Badge>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Spinner />
      {children}
    </p>
  );
}

function Posts({ board, sort, canRemove }: { board: Board; sort: PostSort; canRemove: boolean }) {
  // Each page is a query of its own; "Show more" adds the next one.
  const [pages, setPages] = useState(1);
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: pages }, (_, i) => (
        <PostPage
          key={i}
          board={board}
          sort={sort}
          offset={i * BOARD_PAGE_SIZE}
          last={i === pages - 1}
          canRemove={canRemove}
          onMore={() => setPages(pages + 1)}
        />
      ))}
    </div>
  );
}

function PostPage({
  board,
  sort,
  offset,
  last,
  canRemove,
  onMore,
}: {
  board: Board;
  sort: PostSort;
  offset: number;
  last: boolean;
  canRemove: boolean;
  onMore: () => void;
}) {
  const page = useAtomValue(
    Api.query("boardPosts", { board: board.name, sort, offset }, { reactivityKeys: keysOf(board.name) }),
  );
  return AsyncResult.matchWithError(page, {
    onInitial: () => <Loading>Loading posts…</Loading>,
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value: { posts, total, names } }) => {
      if (total === 0) {
        return (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Sparkle />
              </EmptyMedia>
              <EmptyTitle>Nothing on {board.name} yet</EmptyTitle>
              <EmptyDescription>
                React with <BoardEmoji board={board} /> to messages you like. Once{" "}
                {board.threshold === 1 ? "someone does" : `${board.threshold} of you do`}, they go up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      }
      return (
        <>
          {posts.map((post) => (
            <PostCard key={post.postId} post={post} board={board} names={names} canRemove={canRemove} />
          ))}
          {last && offset + posts.length < total && (
            <Button variant="outline" className="self-center" onClick={onMore}>
              <CaretDown />
              Show more
            </Button>
          )}
        </>
      );
    },
  });
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function PostCard({
  post,
  board,
  names,
  canRemove,
}: {
  post: BoardPost;
  board: Board;
  names: Names;
  canRemove: boolean;
}) {
  const channel = names.channels[post.channelId];
  const images = post.media.filter((m) => m.kind === "image");
  const videos = post.media.filter((m) => m.kind === "video");
  const files = post.media.filter((m) => m.kind === "file");
  return (
    <Card>
      <CardHeader className="flex items-center gap-3">
        <MemberAvatar url={post.authorAvatar} name={post.authorName} className="size-10" />
        <div className="grid min-w-0">
          <CardTitle className="truncate">{post.authorName ?? "A member"}</CardTitle>
          <CardDescription>
            {channel ? `in #${channel}` : "in a private channel"}
            {post.sentAt !== null && (
              <>
                {" · "}
                <time dateTime={new Date(post.sentAt).toISOString()}>{dateFormat.format(post.sentAt)}</time>
              </>
            )}
          </CardDescription>
        </div>
        <CardAction className="self-center">
          <Count board={board} count={post.count} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5 text-base">
        {post.content === null ? (
          <p className="text-sm text-muted-foreground">
            The bot hasn't caught up on this post yet. Open it in Fluxer to read it.
          </p>
        ) : (
          post.content && <MessageText text={post.content} names={names} />
        )}
        {images.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2">
            {images.map((m) => (
              <a
                key={m.url}
                href={m.url}
                target="_blank"
                rel="noreferrer noopener"
                className="relative overflow-hidden rounded-lg bg-background"
              >
                <img src={m.url} alt={m.name} loading="lazy" className="max-h-112 w-full object-contain" />
                {m.blurred && (
                  <Badge variant="secondary" className="absolute bottom-2 left-2 bg-background/85">
                    <EyeSlash />
                    NSFW, blurred
                  </Badge>
                )}
              </a>
            ))}
          </div>
        )}
        {videos.map((m) => (
          <video
            key={m.url}
            className="max-h-112 w-full rounded-lg bg-background object-contain"
            src={m.url}
            controls
            preload="metadata"
          />
        ))}
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
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t">
        <Button variant="ghost" size="sm" asChild>
          <a href={post.messageUrl} target="_blank" rel="noreferrer noopener">
            <ChatCircleText />
            Jump to message
          </a>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={post.postUrl} target="_blank" rel="noreferrer noopener">
            <ArrowSquareOut />
            Open post
          </a>
        </Button>
        {canRemove && <RemoveButton board={board} post={post} />}
      </CardFooter>
    </Card>
  );
}

/** Asks once more before taking the message off for good. */
function RemoveButton({ board, post }: { board: Board; post: BoardPost }) {
  const remove = useAtomSet(Api.mutation("removeFromBoard"), { mode: "promiseExit" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    const exit = await remove({
      payload: { board: board.name, postId: post.postId },
      reactivityKeys: keysOf(board.name),
    });
    setBusy(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
    else setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive">
          <Trash />
          Take off {board.name}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Take it off {board.name} for good?</AlertDialogTitle>
          <AlertDialogDescription>
            The post comes down, and the message won't go up on {board.name} again, however many react to it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Problem message={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // Stay open until the bot has answered.
              event.preventDefault();
              confirm();
            }}
          >
            {busy && <Spinner />}
            Take it off
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Leaderboard({ board }: { board: Board }) {
  const leaders = useAtomValue(Api.query("boardTop", { board: board.name }, { reactivityKeys: keysOf(board.name) }));
  return AsyncResult.matchWithError(leaders, {
    onInitial: () => <Loading>Loading the leaderboard…</Loading>,
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Ranking />
            </EmptyMedia>
            <EmptyTitle>Nobody on the leaderboard yet</EmptyTitle>
            <EmptyDescription>Members show up here once their messages go up on {board.name}.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="py-0">
          <ol className="divide-y">
            {value.map((leader, i) => (
              <LeaderRow key={leader.userId} leader={leader} rank={i + 1} board={board} />
            ))}
          </ol>
        </Card>
      ),
  });
}

function LeaderRow({ leader, rank, board }: { leader: Leader; rank: number; board: Board }) {
  return (
    <li className="flex items-center gap-3.5 px-4 py-3">
      <span
        className={cn(
          "w-8 text-center font-heading text-xl leading-none font-semibold",
          rank === 1 ? "text-primary" : rank === 2 ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {rank}
      </span>
      <MemberAvatar url={leader.avatarUrl} name={leader.name} className="size-9" />
      <strong className="min-w-0 truncate">{leader.name ?? "A member"}</strong>
      <span className="ml-auto inline-flex items-center gap-3.5 whitespace-nowrap text-muted-foreground">
        {leader.posts} {leader.posts === 1 ? "post" : "posts"}
        <Count board={board} count={leader.reactions} />
      </span>
    </li>
  );
}

function MemberAvatar({ url, name, className }: { url: string | null; name: string | null; className?: string }) {
  return (
    <Avatar className={className}>
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback>{name?.slice(0, 1) ?? "?"}</AvatarFallback>
    </Avatar>
  );
}
