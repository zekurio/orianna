import { useAtomValue } from "@effect/atom-react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext, useEffect, useState } from "react";
import { type Session, SignInError } from "../rpc.ts";
import { Api } from "./api.ts";
import { Header } from "./Header.tsx";
import { BoardsPage, parseBoardPath } from "./Boards.tsx";
import { AdminPage, CommandsPage, NotFoundPage, ProfilePage } from "./pages.tsx";
import { navigate, usePath } from "./router.tsx";
import { SignIn } from "./SignIn.tsx";
import { cn } from "cn";
import { container, standalone } from "@/components/page";
import { Button } from "@/components/ui/button";

const SIGN_IN_ERRORS: Record<SignInError, string> = {
  denied: "Signing in was cancelled on Fluxer.",
  expired: "That sign-in took too long, or started in another browser. Try again.",
  failed: "Fluxer couldn't sign you in. Try again in a moment.",
  "not-member": "Your Fluxer account isn't a member of the server.",
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

  const session = useAtomValue(Api.query("session", undefined));
  return AsyncResult.matchWithError(session, {
    onInitial: () => null,
    onError: (error) => {
      switch (error._tag) {
        case "SignedOut":
          return <SignIn message={signInError} />;
        case "NotMember":
          return <SignIn message={SIGN_IN_ERRORS["not-member"]} />;
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

/** Where pages that moved went. */
const MOVED: Record<string, string> = {
  "/settings": "/profile",
  "/settings/personal": "/profile",
  "/settings/server": "/admin",
};

function Shell() {
  const path = usePath();

  useEffect(() => {
    const to = path === "/" ? "/boards" : MOVED[path];
    if (to) navigate(to, { replace: true });
  }, [path]);

  return (
    <>
      <Header path={path} />
      <main className={cn(container, "flex flex-col gap-6 py-8 sm:py-12")}>
        <Page path={path} />
      </main>
    </>
  );
}

function Page({ path }: { path: string }) {
  const boards = parseBoardPath(path);
  if (boards) return <BoardsPage board={boards.board} view={boards.view} />;
  switch (path) {
    case "/":
      return <BoardsPage view="latest" />;
    case "/commands":
      return <CommandsPage />;
    case "/profile":
      return <ProfilePage />;
    case "/admin":
      return <AdminPage />;
    default:
      return <NotFoundPage path={path} />;
  }
}
