import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ArrowSquareOut,
  CaretDown,
  ChatCircleText,
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
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { BOARD_PAGE_SIZE, type Board, type BoardPost, type Leader, type Names, type PostSort } from "../rpc.ts";
import { Api, BOARD_KEYS, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";
import { BoardEditor } from "./BoardForm.tsx";
import { Empty } from "./Empty.tsx";
import { inlineEmoji, MessageText, mention } from "./MessageText.tsx";
import { Link, navigate } from "./router.tsx";
import {
  Avatar,
  buttonClass,
  chipClass,
  Confirm,
  cx,
  Hint,
  Lead,
  Loading,
  Notice,
  PageHeader,
  panel,
  Saved,
  Tabs,
} from "./ui.tsx";

// The boards page: each board's posts, newest or most reacted first, and its
// leaderboard, like `!board top`. Members with `boards.remove` can take a
// message off a board, like `!board remove`.

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
          <Empty
            icon={Star}
            title="No boards yet"
            action={
              manageBoards && (
                <button type="button" className={buttonClass()} onClick={() => open("new")}>
                  <Plus />
                  New board
                </button>
              )
            }
          >
            {manageBoards ? (
              <>
                Create one, and messages that get enough reactions with its emoji go up in its channel. In chat
                it's <code>{prefix}board create</code>.
              </>
            ) : (
              "Once someone sets one up, messages with enough reactions show up here."
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
        {boards.map((b) => (
          <Link
            key={b.name}
            to={boardPath(b.name, view)}
            className={chipClass(b === board && editing !== "new")}
            aria-current={b === board && editing !== "new" ? "page" : undefined}
            onClick={() => {
              setEditing(null);
              setNotice(undefined);
            }}
          >
            <BoardEmoji board={b} />
            {b.name}
          </Link>
        ))}
        {manageBoards && (
          <button
            type="button"
            className={chipClass(editing === "new", true)}
            aria-pressed={editing === "new"}
            onClick={() => open("new")}
          >
            <Plus />
            New board
          </button>
        )}
      </nav>
      {notice && <Saved>{notice}</Saved>}
      {editor ??
        (board ? (
          <BoardPage board={board} canRemove={canRemove} view={view} onEdit={manageBoards ? () => open("board") : undefined} />
        ) : (
          name !== undefined &&
          !refreshing && (
            <Empty
              icon={MagnifyingGlass}
              title={`No board called ${name}`}
              action={
                <Link to={boardPath(first.name, "latest")} className={buttonClass("secondary")}>
                  Go to {first.name}
                </Link>
              }
            >
              It doesn't exist, or its channel is hidden from you.
            </Empty>
          )
        ))}
    </>
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
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <Lead>
          When {board.threshold} {board.threshold === 1 ? "member reacts" : "members react"} with{" "}
          <BoardEmoji board={board} />, a message goes up in <span className={mention}>#{board.channelName}</span>.
          {board.keep && " Posts stay up when reactions drop again."}
        </Lead>
        {onEdit && (
          <button type="button" className={buttonClass("secondary")} onClick={onEdit}>
            <PencilSimple />
            Edit board
          </button>
        )}
      </div>
      <Tabs
        label="Views"
        items={VIEWS.map(({ view: v, label, icon }) => ({
          to: boardPath(board.name, v),
          label,
          icon,
          current: v === view,
        }))}
      />
      {view === "leaderboard" ? (
        <Leaderboard board={board} />
      ) : (
        <Posts key={`${board.name}/${view}`} board={board} sort={view} canRemove={canRemove} />
      )}
    </>
  );
}

export function BoardEmoji({ board }: { board: Pick<Board, "emoji" | "emojiUrl"> }) {
  if (board.emojiUrl) return <img className={inlineEmoji} src={board.emojiUrl} alt={board.emoji} />;
  return <span className="text-[1.1em] leading-none">{board.emoji}</span>;
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
          <Empty icon={Sparkle} title={`Nothing on ${board.name} yet`}>
            React with <BoardEmoji board={board} /> to messages you like. Once{" "}
            {board.threshold === 1 ? "someone does" : `${board.threshold} of you do`}, they go up here.
          </Empty>
        );
      }
      return (
        <>
          {posts.map((post) => (
            <PostCard key={post.postId} post={post} board={board} names={names} canRemove={canRemove} />
          ))}
          {last && offset + posts.length < total && (
            <button type="button" className={cx(buttonClass("secondary"), "self-center")} onClick={onMore}>
              <CaretDown />
              Show more
            </button>
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
    <article className={cx(panel, "flex flex-col gap-3.5 px-5 py-4.5")}>
      <header className="flex items-center gap-3">
        <Avatar url={post.authorAvatar} size={40} />
        <div className="grid min-w-0">
          <strong className="truncate">{post.authorName ?? "A member"}</strong>
          <span className="text-sm text-rose">
            {channel ? `in #${channel}` : "in a private channel"}
            {post.sentAt !== null && (
              <>
                {" · "}
                <time dateTime={new Date(post.sentAt).toISOString()}>{dateFormat.format(post.sentAt)}</time>
              </>
            )}
          </span>
        </div>
        <span className={cx(count, "ml-auto")} title={`${post.count} reacted`}>
          <BoardEmoji board={board} />
          {post.count}
        </span>
      </header>
      {post.content === null ? (
        <Hint>The bot hasn't caught up on this post yet. Open it in Fluxer to read it.</Hint>
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
              className="relative overflow-hidden rounded-xl bg-charcoal"
            >
              <img src={m.url} alt={m.name} loading="lazy" className="max-h-112 w-full object-contain" />
              {m.blurred && (
                <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-charcoal/85 px-2.5 py-1 text-[0.8125rem] text-porcelain">
                  <EyeSlash />
                  NSFW, blurred
                </span>
              )}
            </a>
          ))}
        </div>
      )}
      {videos.map((m) => (
        <video
          key={m.url}
          className="max-h-112 w-full rounded-xl bg-charcoal object-contain"
          src={m.url}
          controls
          preload="metadata"
        />
      ))}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((m) => (
            <li key={m.url}>
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 hover:border-rose hover:no-underline"
              >
                <File />
                {m.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-[0.9375rem]">
        <a href={post.messageUrl} target="_blank" rel="noreferrer noopener" className={buttonClass("text")}>
          <ChatCircleText />
          Jump to message
        </a>
        <a href={post.postUrl} target="_blank" rel="noreferrer noopener" className={buttonClass("text")}>
          <ArrowSquareOut />
          Open post
        </a>
        {canRemove && <RemoveButton board={board} post={post} />}
      </footer>
    </article>
  );
}

/** Asks once more before taking the message off for good. */
function RemoveButton({ board, post }: { board: Board; post: BoardPost }) {
  const remove = useAtomSet(Api.mutation("removeFromBoard"), { mode: "promiseExit" });
  const [state, setState] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string>();

  const confirm = async () => {
    setState("busy");
    const exit = await remove({ payload: { board: board.name, postId: post.postId }, reactivityKeys: keysOf(board.name) });
    if (Exit.isFailure(exit)) {
      setError(failureMessage(exit.cause));
      setState("idle");
    }
  };

  return (
    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-right">
      {state === "idle" ? (
        <button type="button" className={buttonClass("danger")} onClick={() => setState("confirm")}>
          <Trash />
          Take off {board.name}
        </button>
      ) : (
        <Confirm
          confirm="Take it off"
          cancel="Keep it"
          busy={state === "busy"}
          onConfirm={confirm}
          onCancel={() => setState("idle")}
        >
          Take it off for good? It won't go up again.
        </Confirm>
      )}
      {error && (
        <Hint problem>
          <span role="alert">{error}</span>
        </Hint>
      )}
    </span>
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
        <Empty icon={Ranking} title="Nobody on the leaderboard yet">
          Members show up here once their messages go up on {board.name}.
        </Empty>
      ) : (
        <ol className="flex flex-col gap-2">
          {value.map((leader, i) => (
            <LeaderRow key={leader.userId} leader={leader} rank={i + 1} board={board} />
          ))}
        </ol>
      ),
  });
}

function LeaderRow({ leader, rank, board }: { leader: Leader; rank: number; board: Board }) {
  return (
    <li className={cx(panel, "flex items-center gap-3.5 px-4 py-2.5")}>
      <span
        className={cx(
          "w-8 text-center font-display text-xl leading-none font-semibold",
          rank === 1 ? "text-brass" : rank === 2 ? "text-porcelain" : "text-rose",
        )}
      >
        {rank}
      </span>
      <Avatar url={leader.avatarUrl} size={36} />
      <strong className="min-w-0 truncate">{leader.name ?? "A member"}</strong>
      <span className="ml-auto inline-flex items-center gap-3.5 whitespace-nowrap text-rose">
        {leader.posts} {leader.posts === 1 ? "post" : "posts"}
        <span className={count}>
          <BoardEmoji board={board} />
          {leader.reactions}
        </span>
      </span>
    </li>
  );
}

/** How many reacted: a brass pill with the board's emoji. */
const count =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-brass/14 px-3 py-1 font-display font-semibold text-brass";

function Problem({ message }: { message?: string }) {
  return <Notice>{message ?? "The bot ran into a problem. Its log says what happened."}</Notice>;
}
