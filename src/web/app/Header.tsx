import { BookOpenText, CaretDown, type Icon, ShieldStar, SignOut, Star, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./App.tsx";
import portrait from "./orianna.png";
import { Link, usePath } from "./router.tsx";
import { Avatar, container, cx } from "./ui.tsx";

const TABS: { to: string; label: string; icon: Icon }[] = [
  { to: "/boards", label: "Boards", icon: Star },
  { to: "/commands", label: "Commands", icon: BookOpenText },
];

/** Settings for the whole server, for the guild owner and members with Administrator. */
const ADMIN_TAB = { to: "/admin", label: "Admin", icon: ShieldStar };

export function Header({ path }: { path: string }) {
  const { admin } = useSession();
  const tabs = admin ? [...TABS, ADMIN_TAB] : TABS;
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-charcoal">
      <div
        className={cx(
          container,
          "flex h-16 items-center gap-x-4 sm:gap-x-10 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:pt-3",
        )}
      >
        <Link
          to="/boards"
          className="flex items-center gap-2 font-display text-[1.375rem] leading-none font-semibold text-porcelain no-underline hover:no-underline"
        >
          <img src={portrait} alt="" width={36} height={36} />
          Orianna
        </Link>
        <nav
          className="flex gap-1 self-stretch max-sm:order-1 max-sm:-mx-3.5 max-sm:h-12 max-sm:basis-full"
          aria-label="Pages"
        >
          {tabs.map(({ to, label, icon: TabIcon }) => {
            const current = path === to || path.startsWith(`${to}/`);
            return (
              <Link
                key={to}
                to={to}
                aria-current={current ? "page" : undefined}
                className={cx(
                  "relative flex items-center gap-2 px-3.5 font-display text-[1.0625rem] font-medium no-underline hover:no-underline",
                  current
                    ? "text-brass after:absolute after:inset-x-3.5 after:bottom-0 after:h-1 after:rounded-t after:bg-brass"
                    : "text-rose hover:text-porcelain",
                )}
              >
                <TabIcon weight={current ? "fill" : undefined} />
                {label}
              </Link>
            );
          })}
        </nav>
        <UserMenu />
      </div>
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
    <div className="relative ml-auto" ref={menu}>
      <button
        ref={button}
        type="button"
        className="group flex items-center gap-2.5 rounded-full border border-line p-1 text-porcelain hover:border-rose aria-expanded:border-rose sm:pr-3.5"
        aria-expanded={open}
        aria-controls="user-menu-panel"
        onClick={() => setOpen((open) => !open)}
      >
        <Avatar url={user.avatarUrl} size={32} />
        <span className="max-sm:hidden">{user.name}</span>
        <CaretDown
          className="text-rose transition-transform group-aria-expanded:rotate-180 motion-reduce:transition-none max-sm:hidden"
          size="1em"
        />
      </button>
      {open && (
        <div
          id="user-menu-panel"
          className="absolute top-[calc(100%+0.5rem)] right-0 min-w-60 origin-top-right animate-menu-open rounded-[14px] border border-line bg-raised p-1.5 shadow-[0_16px_40px_rgb(0_0_0/0.4)] motion-reduce:animate-none"
        >
          <div className="mb-1.5 grid border-b border-line px-3 pt-2 pb-3">
            <strong>{user.name}</strong>
            {user.tag !== user.name && <span className="text-sm text-rose">{user.tag}</span>}
          </div>
          <Link
            to="/profile"
            className={cx(menuItem, "text-porcelain hover:bg-charcoal aria-[current=page]:text-brass")}
            aria-current={path === "/profile" ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            <UserCircle />
            Profile
          </Link>
          <button type="button" className={cx(menuItem, "text-danger hover:bg-danger/12")} onClick={signOut}>
            <SignOut />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const menuItem =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left no-underline hover:no-underline";

async function signOut() {
  await fetch("/auth/logout", { method: "POST" });
  window.location.assign("/");
}
