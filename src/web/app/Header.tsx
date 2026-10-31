import { BookOpenText, CaretDown, type Icon, ShieldStar, SignOut, Star, UserCircle } from "@phosphor-icons/react";
import { cn } from "cn";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "./App.tsx";
import portrait from "./orianna.png";
import { Link, navigate } from "./router.tsx";

const TABS: { to: string; label: string; icon: Icon }[] = [
  { to: "/starboard", label: "Starboard", icon: Star },
  { to: "/commands", label: "Commands", icon: BookOpenText },
];

/** Settings for the whole server, for the guild owner and members with Administrator. */
const ADMIN_TAB = { to: "/admin", label: "Admin", icon: ShieldStar };

export function Header({ path }: { path: string }) {
  const { admin } = useSession();
  const tabs = admin ? [...TABS, ADMIN_TAB] : TABS;
  return (
    <header className="sticky top-0 z-10 border-b bg-background">
      {/* The full width, unlike the pages, so the tabs have room to grow. */}
      <div className="flex h-16 w-full items-center gap-x-4 px-4 sm:gap-x-10 sm:px-6 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:pt-3">
        <Link
          to="/starboard"
          className="flex items-center gap-2 font-heading text-[1.375rem] leading-none font-semibold text-foreground no-underline"
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
                className={cn(
                  "relative flex items-center gap-2 px-3.5 font-heading text-[1.0625rem] font-medium no-underline",
                  current
                    ? "text-primary after:absolute after:inset-x-3.5 after:bottom-0 after:h-1 after:rounded-t after:bg-primary"
                    : "text-muted-foreground hover:text-foreground",
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="group ml-auto h-10 gap-2.5 rounded-full p-1 sm:pr-3.5">
          <Avatar>
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <span className="max-sm:hidden">{user.name}</span>
          <CaretDown className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180 max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="grid">
          <span className="text-foreground">{user.name}</span>
          {user.tag !== user.name && <span className="font-normal text-muted-foreground">{user.tag}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/profile")}>
          <UserCircle />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={signOut}>
          <SignOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST" });
  window.location.assign("/");
}
