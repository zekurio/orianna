import { useAtomValue } from "@effect/atom-react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { type Session, SignInError } from "../rpc.ts";
import { Api } from "./api.ts";
import { Header, TabBar } from "./Header.tsx";
import { CommandsPage } from "./Commands.tsx";
import { parseAdminPath } from "./admin/paths.ts";
import { GuildContext, guildPath, homeGuild, parseGuildPath, useLastGuild } from "./guild.tsx";
import { KarmaPage } from "./Karma.tsx";
import { NoGuildsPage, NotFoundPage, ProfilePage } from "./pages.tsx";
import { navigate, usePath } from "./router.tsx";
import { SignIn } from "./SignIn.tsx";
import { cn } from "cn";
import { Placeholder, SettingsGroupSkeleton } from "@/components/loading";
import { container, PageHeader, standalone } from "@/components/page";
import { Button } from "@/components/ui/button";

// Only admins open the Admin tab, so its code waits until one does.
const AdminPage = lazy(() => import("./admin/AdminPage.tsx").then(({ AdminPage }) => ({ default: AdminPage })));

const SIGN_IN_ERRORS: Record<SignInError, string> = {
  denied: "Signing in was cancelled on Fluxer.",
  expired: "That sign-in took too long, or started in another browser. Try again.",
  failed: "Fluxer couldn't sign you in. Try again in a moment.",
};

const SessionContext = createContext<Session | null>(null);

/** The signed-in member. Only pages inside the signed-in app use it. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession is only for the signed-in app");
  return session;
}

export function App() {
  // The callback sends the browser back with ?error= when signing in failed.
  const [error] = useState(() => new URLSearchParams(window.location.search).get("error"));
  useEffect(() => {
    if (error !== null) navigate(window.location.pathname, { replace: true });
  }, [error]);
  const signInError = Schema.is(SignInError)(error) ? SIGN_IN_ERRORS[error] : undefined;

  // Refreshed when an admin changes the prefix.
  const session = useAtomValue(Api.query("session", undefined, { reactivityKeys: ["session"] }));
  return AsyncResult.matchWithError(session, {
    onInitial: () => null,
    onError: (error) => {
      switch (error._tag) {
        case "SignedOut":
          return <SignIn message={signInError} />;
        case "NotMember":
          return <Unavailable message="The bot ran into a problem. Its log says what happened." />;
        case "RpcClientError":
          return <Unavailable message="The bot didn't answer. Check that it's running, then reload the page." />;
      }
    },
    onDefect: () => <Unavailable message="The bot ran into a problem. Its log says what happened." />,
    onSuccess: ({ value }) => (
      <SessionContext value={value}>
        <Shell />
      </SessionContext>
    ),
  });
}

function Unavailable({ message }: { message: string }) {
  return (
    <main className={standalone}>
      <h1 className="text-3xl text-foreground">Orianna isn't answering</h1>
      <p className="max-w-[38ch]">{message}</p>
      <Button size="lg" onClick={() => window.location.reload()}>
        <ArrowClockwise />
        Reload
      </Button>
    </main>
  );
}

function Shell() {
  const path = usePath();
  const { guilds } = useSession();
  const { guildId: last, remember } = useLastGuild();
  const scroller = useRef<HTMLDivElement>(null);
  const inGuild = parseGuildPath(path);
  const guild = inGuild && guilds.find((g) => g.id === inGuild.guildId);

  useEffect(() => {
    if (guild) remember(guild.id);
  }, [guild?.id]);
  useEffect(() => {
    const home = homeGuild(guilds, last);
    if (path === "/" && home) navigate(guildPath(home.id), { replace: true });
    else if (inGuild?.page === "/") navigate(guildPath(inGuild.guildId), { replace: true });
  }, [path]);
  // The page scrolls in its own box, which the browser leaves where it was
  // when another page comes in.
  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [path]);

  return (
    <GuildContext value={guild ?? null}>
      {/* The page scrolls in its own box under the header, so scrolling past
          either end bounces the page and leaves the header where it is. The
          box is positioned so hidden labels and inputs, which are
          absolutely positioned, scroll inside it instead of making the
          window scroll too. Space for the scrollbar is always kept, so the
          page doesn't shift sideways when it grows long enough to scroll.
          The shell is fixed to the viewport rather than sized to it: phone
          browsers can make the window a little taller than the viewport,
          like Chrome with its address bar along the bottom, and a swipe
          would then scroll the window, pushing the header off the top and
          leaving a gap under the tab bar. Scrolling also stops at the
          box's ends instead of carrying on to the window. */}
      <div className="fixed inset-0 flex flex-col">
        <Header path={path} />
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]">
          <main className={cn(container, "flex min-h-full flex-col gap-6 py-6 sm:py-12")}>
            <Page path={path} />
          </main>
        </div>
        <TabBar path={path} />
      </div>
    </GuildContext>
  );
}

function Page({ path }: { path: string }) {
  const { guilds } = useSession();
  if (path === "/profile") return <ProfilePage />;
  if (path === "/" && guilds.length === 0) return <NoGuildsPage />;
  const inGuild = parseGuildPath(path);
  if (!inGuild) return <NotFoundPage path={path} />;
  const guild = guilds.find((g) => g.id === inGuild.guildId);
  if (!guild) return <NotFoundPage path={path} />;

  const adminTab = parseAdminPath(inGuild.page);
  // Keyed by guild, so a page starts over in another guild.
  if (adminTab) {
    return (
      <Suspense fallback={<AdminSkeleton />}>
        <AdminPage key={guild.id} tab={adminTab} />
      </Suspense>
    );
  }
  switch (inGuild.page) {
    case "/karma":
      return <KarmaPage key={guild.id} />;
    case "/commands":
      return <CommandsPage key={guild.id} />;
    default:
      return <NotFoundPage path={path} />;
  }
}

/** The Admin tab while its code loads. */
function AdminSkeleton() {
  return (
    <>
      <PageHeader title="Admin" />
      <Placeholder label="Loading the settings" className="flex flex-col gap-8">
        <SettingsGroupSkeleton rows={2} />
        <SettingsGroupSkeleton rows={4} />
      </Placeholder>
    </>
  );
}
