import { useAtomValue } from "@effect/atom-react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext, useEffect, useState } from "react";
import { type Session, SignInError } from "../rpc.ts";
import { Api } from "./api.ts";
import { Header } from "./Header.tsx";
import { CommandsPage } from "./Commands.tsx";
import { AdminPage, parseAdminPath } from "./admin/AdminPage.tsx";
import { GuildContext, guildPath, homeGuild, parseGuildPath, useLastGuild } from "./guild.tsx";
import { NoGuildsPage, NotFoundPage, ProfilePage } from "./pages.tsx";
import { navigate, usePath } from "./router.tsx";
import { SignIn } from "./SignIn.tsx";
import { StarboardPage } from "./Starboard.tsx";
import { cn } from "cn";
import { container, standalone } from "@/components/page";
import { Button } from "@/components/ui/button";

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

  return (
    <GuildContext value={guild ?? null}>
      <Header path={path} />
      <main className={cn(container, "flex flex-col gap-6 py-8 sm:py-12")}>
        <Page path={path} />
      </main>
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
  if (adminTab) return <AdminPage key={guild.id} tab={adminTab} />;
  switch (inGuild.page) {
    case "/starboard":
      return <StarboardPage key={guild.id} />;
    case "/commands":
      return <CommandsPage key={guild.id} />;
    default:
      return <NotFoundPage path={path} />;
  }
}
