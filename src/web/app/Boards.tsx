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
import { MessageText } from "./MessageText.tsx";
import { Link, navigate } from "./router.tsx";

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

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} – Orianna`;
  }, [title]);
}

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

function Heading({ board }: { board?: Board }) {
  useTitle(board ? `${board.name} – Boards` : "Boards");
  return <h1>Boards</h1>;
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
                <button type="button" className="button" onClick={() => open("new")}>
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
      <Heading board={board} />
      <nav className="board-picker" aria-label="Boards">
        {boards.map((b) => (
          <Link
            key={b.name}
            to={boardPath(b.name, view)}
            className="board-chip"
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
            className="board-chip new-chip"
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
                <Link to={boardPath(first.name, "latest")} className="button quiet-button">
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

function Saved({ children }: { children: string }) {
  return (
    <p className="saved" role="status">
      {children}
    </p>
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
      <div className="board-summary">
        <p className="lead">
          When {board.threshold} {board.threshold === 1 ? "member reacts" : "members react"} with{" "}
          <BoardEmoji board={board} />, a message goes up in <span className="mention">#{board.channelName}</span>.
          {board.keep && " Posts stay up when reactions drop again."}
        </p>
        {onEdit && (
          <button type="button" className="button quiet-button" onClick={onEdit}>
            <PencilSimple />
            Edit board
          </button>
        )}
      </div>
      <nav className="sections" aria-label="Views">
        {VIEWS.map(({ view: v, label, icon: ViewIcon }) => (
          <Link
            key={v}
            to={boardPath(board.name, v)}
            className="section"
            aria-current={v === view ? "page" : undefined}
          >
            <ViewIcon />
            {label}
          </Link>
        ))}
      </nav>
      <div className="board-view">
        {view === "leaderboard" ? (
          <Leaderboard board={board} />
        ) : (
          <Posts key={`${board.name}/${view}`} board={board} sort={view} canRemove={canRemove} />
        )}
      </div>
    </>
  );
}

export function BoardEmoji({ board }: { board: Pick<Board, "emoji" | "emojiUrl"> }) {
  if (board.emojiUrl) return <img className="inline-emoji" src={board.emojiUrl} alt={board.emoji} />;
  return <span className="unicode-emoji">{board.emoji}</span>;
}

function Posts({ board, sort, canRemove }: { board: Board; sort: PostSort; canRemove: boolean }) {
  // Each page is a query of its own; "Show more" adds the next one.
  const [pages, setPages] = useState(1);
  return (
    <div className="posts">
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
    onInitial: () => <p className="quiet">Loading posts…</p>,
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
            <button type="button" className="button quiet-button" onClick={onMore}>
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
    <article className="post">
      <header className="post-head">
        <Avatar url={post.authorAvatar} size={40} />
        <div className="post-who">
          <strong>{post.authorName ?? "A member"}</strong>
          <span>
            {channel ? `in #${channel}` : "in a private channel"}
            {post.sentAt !== null && (
              <>
                {" · "}
                <time dateTime={new Date(post.sentAt).toISOString()}>{dateFormat.format(post.sentAt)}</time>
              </>
            )}
          </span>
        </div>
        <span className="post-count" title={`${post.count} reacted`}>
          <BoardEmoji board={board} />
          {post.count}
        </span>
      </header>
      {post.content === null ? (
        <p className="quiet">The bot hasn't caught up on this post yet. Open it in Fluxer to read it.</p>
      ) : (
        post.content && <MessageText text={post.content} names={names} />
      )}
      {images.length > 0 && (
        <div className="post-media">
          {images.map((m) => (
            <a key={m.url} href={m.url} target="_blank" rel="noreferrer noopener" className="post-image">
              <img src={m.url} alt={m.name} loading="lazy" />
              {m.blurred && (
                <span className="blur-badge">
                  <EyeSlash />
                  NSFW, blurred
                </span>
              )}
            </a>
          ))}
        </div>
      )}
      {videos.map((m) => (
        <video key={m.url} className="post-video" src={m.url} controls preload="metadata" />
      ))}
      {files.length > 0 && (
        <ul className="post-files">
          {files.map((m) => (
            <li key={m.url}>
              <a href={m.url} target="_blank" rel="noreferrer noopener">
                <File />
                {m.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <footer className="post-actions">
        <a href={post.messageUrl} target="_blank" rel="noreferrer noopener">
          <ChatCircleText />
          Jump to message
        </a>
        <a href={post.postUrl} target="_blank" rel="noreferrer noopener">
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

  if (state === "idle") {
    return (
      <>
        <button type="button" className="text-button danger" onClick={() => setState("confirm")}>
          <Trash />
          Take off {board.name}
        </button>
        {error && (
          <span className="post-error" role="alert">
            {error}
          </span>
        )}
      </>
    );
  }
  return (
    <span className="confirm">
      Take it off for good? It won't go up again.
      <button type="button" className="text-button danger" disabled={state === "busy"} onClick={confirm}>
        Take it off
      </button>
      <button type="button" className="text-button" disabled={state === "busy"} onClick={() => setState("idle")}>
        Keep it
      </button>
    </span>
  );
}

function Leaderboard({ board }: { board: Board }) {
  const leaders = useAtomValue(Api.query("boardTop", { board: board.name }, { reactivityKeys: keysOf(board.name) }));
  return AsyncResult.matchWithError(leaders, {
    onInitial: () => <p className="quiet">Loading the leaderboard…</p>,
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <Empty icon={Ranking} title="Nobody on the leaderboard yet">
          Members show up here once their messages go up on {board.name}.
        </Empty>
      ) : (
        <ol className="leaders">
          {value.map((leader, i) => (
            <LeaderRow key={leader.userId} leader={leader} rank={i + 1} board={board} />
          ))}
        </ol>
      ),
  });
}

function LeaderRow({ leader, rank, board }: { leader: Leader; rank: number; board: Board }) {
  return (
    <li className="leader">
      <span className="rank" data-podium={rank <= 3 ? rank : undefined}>
        {rank}
      </span>
      <Avatar url={leader.avatarUrl} size={36} />
      <strong className="leader-name">{leader.name ?? "A member"}</strong>
      <span className="leader-stats">
        {leader.posts} {leader.posts === 1 ? "post" : "posts"}
        <span className="post-count">
          <BoardEmoji board={board} />
          {leader.reactions}
        </span>
      </span>
    </li>
  );
}

function Avatar({ url, size }: { url: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <span className="avatar avatar-blank" style={{ width: size, height: size }} />;
  return <img className="avatar" src={url} alt="" width={size} height={size} onError={() => setBroken(true)} />;
}

function Problem({ message }: { message?: string }) {
  return (
    <p className="notice" role="alert">
      {message ?? "The bot ran into a problem. Its log says what happened."}
    </p>
  );
}
