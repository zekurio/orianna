import { Star, UsersThree } from "@phosphor-icons/react";
import { type ReactNode, useEffect } from "react";
import { useSession } from "./App.tsx";
import { BoardSettings } from "./BoardSettings.tsx";
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
      <Unbuilt />
    </>
  );
}

/** The sections of the admin pages, and who gets each. */
const ADMIN_SECTIONS = [
  { key: "boards", label: "Boards", path: "/admin/boards", icon: Star, for: "manageBoards" },
  { key: "server", label: "Server", path: "/admin/server", icon: UsersThree, for: "admin" },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number]["key"];

/** The admin sections the member gets, in the order the tabs show them. */
export function useAdminSections() {
  const session = useSession();
  return ADMIN_SECTIONS.filter((s) => session[s.for]);
}

export function AdminPage({ section }: { section: AdminSection }) {
  const { prefix } = useSession();
  const sections = useAdminSections();
  const current = ADMIN_SECTIONS.find((s) => s.key === section)!;
  useTitle(`${current.label} – Admin`);
  const allowed = sections.some((s) => s.key === section);

  return (
    <>
      <h1>Admin</h1>
      {/* A lone tab isn't worth showing. */}
      {sections.length > 1 && (
        <nav className="sections" aria-label="Admin">
          {sections.map(({ path, label, icon: SectionIcon }) => (
            <Link key={path} to={path} className="section" aria-current={path === current.path ? "page" : undefined}>
              <SectionIcon />
              {label}
            </Link>
          ))}
        </nav>
      )}
      {!allowed ? (
        <p className="lead">
          {section === "boards"
            ? "Setting up boards takes the boards.manage permission."
            : "Only the server owner and members with Administrator can change the bot settings."}
        </p>
      ) : section === "boards" ? (
        <BoardSettings />
      ) : (
        <>
          <p className="lead">What the bot does in the server: the prefix, permissions and every feature.</p>
          <Unbuilt>
            This page isn't built yet. Until it is, use <code>{prefix}settings export</code> and{" "}
            <code>{prefix}settings import</code> in chat.
          </Unbuilt>
        </>
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
