import { useEffect, useRef, useState } from "react";
import { useSession } from "./App.tsx";
import portrait from "./orianna.png";
import { Link } from "./router.tsx";

const TABS = [
  { to: "/boards", label: "Boards" },
  { to: "/commands", label: "Commands" },
  { to: "/settings", label: "Settings" },
];

export function Header({ path }: { path: string }) {
  return (
    <header className="header">
      <Link to="/boards" className="wordmark">
        <img src={portrait} alt="" width={36} height={36} />
        Orianna
      </Link>
      <nav className="tabs" aria-label="Pages">
        {TABS.map((tab) => {
          const current = path === tab.to || path.startsWith(`${tab.to}/`);
          return (
            <Link key={tab.to} to={tab.to} className="tab" aria-current={current ? "page" : undefined}>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <UserMenu />
    </header>
  );
}

function UserMenu() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // A click anywhere else or Escape closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={menu}>
      <button
        ref={button}
        type="button"
        className="user-button"
        aria-expanded={open}
        aria-controls="user-menu-panel"
        onClick={() => setOpen((open) => !open)}
      >
        <img className="avatar" src={user.avatarUrl} alt="" width={32} height={32} />
        <span className="user-name">{user.name}</span>
      </button>
      {open && (
        <div id="user-menu-panel" className="user-panel">
          <div className="user-who">
            <strong>{user.name}</strong>
            {user.tag !== user.name && <span>{user.tag}</span>}
          </div>
          <button type="button" className="menu-item" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST" });
  window.location.assign("/");
}
