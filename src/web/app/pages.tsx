import { Star, User, UsersThree } from "@phosphor-icons/react";
import { type ReactNode, useEffect } from "react";
import { useSession } from "./App.tsx";
import { BoardSettings } from "./BoardSettings.tsx";
import { Link } from "./router.tsx";

// The pages behind the tabs. They only say what they're for so far.

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

const SECTIONS = {
  personal: { label: "Personal", path: "/settings/personal", icon: User },
  server: { label: "Server", path: "/settings/server", icon: UsersThree },
  boards: { label: "Boards", path: "/settings/boards", icon: Star },
} as const;

export function SettingsPage({ section }: { section: keyof typeof SECTIONS }) {
  const { admin, manageBoards, prefix } = useSession();
  useTitle(`${SECTIONS[section].label} settings`);
  const sections = [
    SECTIONS.personal,
    ...(admin ? [SECTIONS.server] : []),
    ...(manageBoards ? [SECTIONS.boards] : []),
  ];

  return (
    <>
      <h1>Settings</h1>
      {/* A lone tab isn't worth showing. */}
      {sections.length > 1 && (
        <nav className="sections" aria-label="Settings">
          {sections.map(({ path, label, icon: SectionIcon }) => (
            <Link
              key={path}
              to={path}
              className="section"
              aria-current={path === SECTIONS[section].path ? "page" : undefined}
            >
              <SectionIcon />
              {label}
            </Link>
          ))}
        </nav>
      )}
      {section === "boards" ? (
        manageBoards ? (
          <BoardSettings />
        ) : (
          <p className="lead">Setting up boards takes the boards.manage permission.</p>
        )
      ) : section === "personal" ? (
        <>
          <p className="lead">Settings that only change things for you.</p>
          <Unbuilt />
        </>
      ) : admin ? (
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
