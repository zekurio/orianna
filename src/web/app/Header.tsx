import {
  BookOpenText,
  CaretDown,
  CaretUpDown,
  Check,
  type Icon,
  ShieldStar,
  SignOut,
  Star,
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
  { page: "/starboard", label: "Starboard", icon: Star },
  { page: "/commands", label: "Commands", icon: BookOpenText },
];

/** Settings for the whole guild, for its owner and members with Administrator. */
const ADMIN_TAB = { page: "/admin", label: "Admin", icon: ShieldStar };

export function Header({ path }: { path: string }) {
  const { guilds } = useSession();
  const { guildId: last } = useLastGuild();
  const current = useContext(GuildContext);
  // Outside a guild, like on the profile, the tabs lead back to the last one.
  const guild = current ?? homeGuild(guilds, last);
  const page = parseGuildPath(path)?.page;
  const tabs = guild?.admin ? [...TABS, ADMIN_TAB] : TABS;
  return (
    <header className="sticky top-0 z-10 border-b bg-background">
      {/* The full width, unlike the pages, so the tabs have room to grow. */}
      <div className="flex h-16 w-full items-center gap-x-4 px-4 sm:gap-x-10 sm:px-6 max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:pt-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-heading text-[1.375rem] leading-none font-semibold text-foreground no-underline"
          >
            <img src={portrait} alt="" width={36} height={36} />
            Orianna
          </Link>
          <span aria-hidden="true" className="text-2xl font-light text-border">
            /
          </span>
          <GuildSwitcher current={current} path={path} />
        </div>
        <nav
          className="flex gap-1 self-stretch max-sm:order-1 max-sm:-mx-3.5 max-sm:h-12 max-sm:basis-full"
          aria-label="Pages"
        >
          {guild &&
            tabs.map(({ page: to, label, icon: TabIcon }) => {
              const here = page === to || page?.startsWith(`${to}/`) === true;
              return (
                <Link
                  key={to}
                  to={guildPath(guild.id, to)}
                  aria-current={here ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-2 px-3.5 font-heading text-[1.0625rem] font-medium no-underline",
                    here
                      ? "text-primary after:absolute after:inset-x-3.5 after:bottom-0 after:h-1 after:rounded-t after:bg-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <TabIcon weight={here ? "fill" : undefined} />
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

/**
 * The guild the page is about, and a menu of the others the member shares
 * with the bot. Picking one keeps the page, like the starboard, in that guild.
 */
function GuildSwitcher({ current, path }: { current: GuildInfo | null; path: string }) {
  const { guilds } = useSession();
  if (guilds.length === 0) return <span className="text-muted-foreground">No servers</span>;
  const page = parseGuildPath(path)?.page ?? "/starboard";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-10 min-w-0 gap-2 px-2 font-medium text-foreground">
          {current ? (
            <>
              <GuildIcon guild={current} />
              <span className="truncate max-sm:max-w-[9rem]">{current.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Pick a server</span>
          )}
          <CaretUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Servers</DropdownMenuLabel>
        {guilds.map((guild) => (
          <DropdownMenuItem key={guild.id} onSelect={() => navigate(guildPath(guild.id, page))}>
            <GuildIcon guild={guild} />
            <span className="truncate">{guild.name}</span>
            {guild.id === current?.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GuildIcon({ guild }: { guild: GuildInfo }) {
  return (
    <Avatar className="size-7 rounded-lg after:rounded-lg">
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
