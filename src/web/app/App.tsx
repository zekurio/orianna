import { useAtomValue } from "@effect/atom-react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext, useEffect, useState } from "react";
import { type Session, SignInError } from "../rpc.ts";
import { Api } from "./api.ts";
import { Header } from "./Header.tsx";
import { BoardsPage, parseBoardPath } from "./Boards.tsx";
import { CommandsPage, NotFoundPage, SettingsPage } from "./pages.tsx";
import { navigate, usePath } from "./router.tsx";
import { SignIn } from "./SignIn.tsx";

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
    <main className="standalone">
      <h1>Orianna isn't answering</h1>
      <p>{message}</p>
      <button type="button" className="button" onClick={() => window.location.reload()}>
        <ArrowClockwise />
        Reload
      </button>
    </main>
  );
}

function Shell() {
  const path = usePath();

  useEffect(() => {
    if (path === "/") navigate("/boards", { replace: true });
    else if (path === "/settings") navigate("/settings/personal", { replace: true });
  }, [path]);

  return (
    <>
      <Header path={path} />
      <main className="page">
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
    case "/settings":
    case "/settings/personal":
      return <SettingsPage section="personal" />;
    case "/settings/server":
      return <SettingsPage section="server" />;
    case "/settings/boards":
      return <SettingsPage section="boards" />;
    default:
      return <NotFoundPage path={path} />;
  }
}
