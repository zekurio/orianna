import { BookOpenText, CaretDown, type Icon, ShieldStar, SignOut, Star, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./App.tsx";
import portrait from "./orianna.png";
import { useAdminSections } from "./pages.tsx";
import { Link, usePath } from "./router.tsx";

const TABS: { to: string; label: string; icon: Icon }[] = [
  { to: "/boards", label: "Boards", icon: Star },
  { to: "/commands", label: "Commands", icon: BookOpenText },
];

/** For members who manage something in the server. */
const ADMIN_TAB = { to: "/admin", label: "Admin", icon: ShieldStar };

export function Header({ path }: { path: string }) {
  const tabs = useAdminSections().length > 0 ? [...TABS, ADMIN_TAB] : TABS;
  return (
    <header className="header">
      <Link to="/boards" className="wordmark">
        <img src={portrait} alt="" width={36} height={36} />
        Orianna
      </Link>
      <nav className="tabs" aria-label="Pages">
        {tabs.map(({ to, label, icon: TabIcon }) => {
          const current = path === to || path.startsWith(`${to}/`);
          return (
            <Link key={to} to={to} className="tab" aria-current={current ? "page" : undefined}>
              <TabIcon weight={current ? "fill" : undefined} />
              {label}
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
  const path = usePath();
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
        <CaretDown className="caret" size="1em" />
      </button>
      {open && (
        <div id="user-menu-panel" className="user-panel">
          <div className="user-who">
            <strong>{user.name}</strong>
            {user.tag !== user.name && <span>{user.tag}</span>}
          </div>
          <Link
            to="/profile"
            className="menu-item"
            aria-current={path === "/profile" ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            <UserCircle />
            Profile
          </Link>
          <button type="button" className="menu-item danger" onClick={signOut}>
            <SignOut />
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
