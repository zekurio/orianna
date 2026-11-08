import {
  BookOpenText,
  CaretDown,
  CaretUpDown,
  Check,
  type Icon,
  ShieldStar,
  SignOut,
  ThumbsUp,
  UserCircle,
} from "@phosphor-icons/react";
import { cn } from "cn";
import { useContext } from "react";
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
import type { GuildInfo } from "../rpc.ts";
import { useSession } from "./App.tsx";
import { GuildContext, guildPath, homeGuild, parseGuildPath, useLastGuild } from "./guild.tsx";
import portrait from "./orianna.png";
import { Link, navigate } from "./router.tsx";

/** A guild's pages, by their path within it. */
const TABS: { page: string; label: string; icon: Icon }[] = [
  { page: "/karma", label: "Karma", icon: ThumbsUp },
  { page: "/commands", label: "Commands", icon: BookOpenText },
];

/** Settings for the whole guild, for its owner and members with Administrator. */
const ADMIN_TAB = { page: "/admin", label: "Admin", icon: ShieldStar };

/**
 * The guild the tabs lead to: the page's, or outside a guild, like on the
 * profile, the last one looked at.
 */
function useTabGuild(): GuildInfo | undefined {
  const { guilds } = useSession();
  const { guildId: last } = useLastGuild();
  const current = useContext(GuildContext);
  return current ?? homeGuild(guilds, last);
}

/** The tabs of `guild`, and whether each is the page at `path`. */
function tabsOf(guild: GuildInfo, path: string) {
  const page = parseGuildPath(path)?.page;
  return (guild.admin ? [...TABS, ADMIN_TAB] : TABS).map((tab) => ({
    ...tab,
    to: guildPath(guild.id, tab.page),
    here: page === tab.page || page?.startsWith(`${tab.page}/`) === true,
  }));
}

export function Header({ path }: { path: string }) {
  const guild = useTabGuild();
  return (
    <header className="z-10 shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]">
      {/* The full width, unlike the pages, so the tabs have room to grow. On
          narrow screens, like phones, the tabs move to the bottom of the
          screen, under the thumb. */}
      <div className="flex h-14 w-full items-center gap-x-2 px-3 sm:h-16 sm:gap-x-6 sm:px-6 xl:gap-x-10">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3 lg:flex-initial">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-heading text-[1.375rem] leading-none font-semibold text-foreground no-underline"
          >
            <img src={portrait} alt="" width={36} height={36} />
            <span className="max-sm:sr-only">Orianna</span>
          </Link>
          <span aria-hidden="true" className="text-2xl font-light text-border">
            /
          </span>
          <GuildSwitcher current={guild} path={path} />
        </div>
        <nav className="flex shrink-0 gap-1 self-stretch max-lg:hidden" aria-label="Pages">
          {guild &&
            tabsOf(guild, path).map(({ to, here, label, icon: TabIcon }) => (
              <Link
                key={to}
                to={to}
                aria-current={here ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2 px-3.5 font-heading text-[1.0625rem]/6 font-medium no-underline",
                  here
                    ? "text-primary after:absolute after:inset-x-3.5 after:bottom-0 after:h-1 after:rounded-t after:bg-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <TabIcon weight={here ? "fill" : undefined} />
                {label}
              </Link>
            ))}
        </nav>
        <UserMenu />
      </div>
    </header>
  );
}

/** The tabs on narrow screens: a bar along the bottom, within reach of a thumb. */
export function TabBar({ path }: { path: string }) {
  const guild = useTabGuild();
  if (!guild) return null;
  return (
    <nav
      className="z-10 flex shrink-0 border-t bg-background px-1 pb-[env(safe-area-inset-bottom)] lg:hidden"
      aria-label="Pages"
    >
      {tabsOf(guild, path).map(({ to, here, label, icon: TabIcon }) => (
        <Link
          key={to}
          to={to}
          aria-current={here ? "page" : undefined}
          className={cn(
            "relative flex h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 font-heading text-[0.8125rem]/4 font-medium no-underline [-webkit-tap-highlight-color:transparent]",
            here
              ? "text-primary before:absolute before:top-0 before:left-1/2 before:h-1 before:w-12 before:-translate-x-1/2 before:rounded-b before:bg-primary"
              : "text-muted-foreground active:text-foreground",
          )}
        >
          <TabIcon size="1.5rem" weight={here ? "fill" : undefined} />
          <span className="max-w-full truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * The guild the page is about, or outside a guild the one the tabs lead to,
 * and a menu of the others the member shares with the bot. Picking one keeps
 * the page, like karma, in that guild; outside a guild, like on the
 * profile, it stays on the page and points the tabs at that guild.
 */
function GuildSwitcher({ current, path }: { current: GuildInfo | undefined; path: string }) {
  const { guilds } = useSession();
  const remember = useLastGuild((state) => state.remember);
  if (!current) return <span className="text-muted-foreground">No servers</span>;
  const page = parseGuildPath(path)?.page;
  const pick = (guildId: string) => (page ? navigate(guildPath(guildId, page)) : remember(guildId));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-10 min-w-0 gap-2 px-2 font-medium text-foreground">
          <GuildIcon guild={current} />
          <span className="truncate">{current.name}</span>
          <CaretUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className="w-72">
        <DropdownMenuLabel>Servers</DropdownMenuLabel>
        {guilds.map((guild) => (
          <DropdownMenuItem key={guild.id} onSelect={() => pick(guild.id)}>
            <GuildIcon guild={guild} />
            <span className="truncate">{guild.name}</span>
            {guild.id === current.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A server's icon, or its initials without one. */
export function GuildIcon({ guild, className }: { guild: Pick<GuildInfo, "name" | "iconUrl">; className?: string }) {
  return (
    <Avatar className={cn("size-7 rounded-lg after:rounded-lg", className)}>
      {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" className="rounded-lg" />}
      <AvatarFallback className="rounded-lg text-xs">{initials(guild.name)}</AvatarFallback>
    </Avatar>
  );
}

/** What Fluxer shows for a server without an icon: the first letter of each word. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => [...word][0] ?? "")
    .join("")
    .slice(0, 3);
}

function UserMenu() {
  const { user } = useSession();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="group h-10 shrink-0 gap-2.5 rounded-full p-1 sm:ml-auto sm:pr-3.5 lg:max-xl:pr-1">
          <Avatar>
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <span className="max-sm:hidden lg:max-xl:hidden">{user.name}</span>
          <CaretDown className="text-muted-foreground transition-transform group-data-[state=open]:rotate-180 max-sm:hidden lg:max-xl:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={12} className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2.5 px-2 py-2">
          <Avatar>
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0">
            <span className="truncate text-sm text-foreground">{user.name}</span>
            {user.tag !== user.name && <span className="truncate font-normal">{user.tag}</span>}
          </span>
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
