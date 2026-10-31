import { type ReactNode, useEffect } from "react";
import { useSession } from "./App.tsx";
import { BoardOptOut } from "./BoardOptOut.tsx";
import { Link } from "./router.tsx";

// The pages behind the tabs and the user menu. Some only say what they're for so far.

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} – Orianna`;
  }, [title]);
}

function Unbuilt({ children }: { children?: ReactNode }) {
  return <p className="unbuilt">{children ?? "This page isn't built yet."}</p>;
}

export function CommandsPage() {
  const { prefix } = useSession();
  useTitle("Commands");
  return (
    <>
      <h1>Commands</h1>
      <p className="lead">
        The commands you can use, and how to use them. They all start with <code>{prefix}</code>.
      </p>
      <Unbuilt />
    </>
  );
}

export function ProfilePage() {
  const { user, admin } = useSession();
  useTitle("Profile");
  return (
    <>
      <h1>Profile</h1>
      <section className="profile-card">
        <img className="avatar" src={user.avatarUrl} alt="" width={64} height={64} />
        <div className="profile-who">
          <strong>{user.name}</strong>
          {user.tag !== user.name && <span>{user.tag}</span>}
          {admin && <span className="tag owner-tag">Server admin</span>}
        </div>
      </section>
      <h2 className="section-title">Your settings</h2>
      <p className="lead">Settings that only change things for you.</p>
      <BoardOptOut />
    </>
  );
}

/** Settings for the whole server, for the guild owner and members with Administrator. */
export function AdminPage() {
  const { admin, prefix } = useSession();
  useTitle("Admin");
  return (
    <>
      <h1>Admin</h1>
      {admin ? (
        <>
          <p className="lead">What the bot does in the server: the prefix, permissions and every feature.</p>
          <Unbuilt>
            This page isn't built yet. Until it is, use <code>{prefix}settings export</code> and{" "}
            <code>{prefix}settings import</code> in chat.
          </Unbuilt>
        </>
      ) : (
        <p className="lead">Only the server owner and members with Administrator can change the bot settings.</p>
      )}
    </>
  );
}

export function NotFoundPage({ path }: { path: string }) {
  useTitle("Not found");
  return (
    <>
      <h1>Nothing here</h1>
      <p className="lead">
        There's no page at <code>{path}</code>. <Link to="/boards">Go to the boards</Link>.
      </p>
    </>
  );
}
