import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Api, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";

// Keeping your messages off the boards, like `!board optout` and `optin`.

const KEYS = ["board-opt-out"];

export function BoardOptOut() {
  const { prefix } = useSession();
  const id = useId();
  const optedOut = useAtomValue(Api.query("boardOptOut", undefined, { reactivityKeys: KEYS }));
  const [message, setMessage] = useState<Message>();
  return (
    <Card>
      <CardHeader>
        <CardTitle id={id} className="text-base">
          Keep my messages off the boards
        </CardTitle>
        <CardDescription>
          Your messages never go up on a board, however many react to them, and the ones already there come down.
          Turn it off again any time; messages go up again once someone reacts to them. Same as{" "}
          <code>{prefix}board optout</code> and <code>{prefix}board optin</code> in chat.
        </CardDescription>
        <CardAction>
          {AsyncResult.matchWithError(optedOut, {
            onInitial: () => <Spinner />,
            onError: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
            onDefect: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
            onSuccess: ({ value }) => <OptOutSwitch optedOut={value} labelledBy={id} say={setMessage} />,
          })}
        </CardAction>
      </CardHeader>
      {message && (
        <CardContent>
          <p role="status" className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        </CardContent>
      )}
    </Card>
  );
}

/** What the last change did. */
type Message = { text: string; error?: boolean };

function OptOutSwitch({
  optedOut,
  labelledBy,
  say,
}: {
  optedOut: boolean;
  labelledBy: string;
  say: (message: Message | undefined) => void;
}) {
  const set = useAtomSet(Api.mutation("setBoardOptOut"), { mode: "promiseExit" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = async (next: boolean) => {
    setBusy(true);
    const exit = await set({ payload: { optedOut: next }, reactivityKeys: [...KEYS, "boards"] });
    setBusy(false);
    setConfirming(false);
    if (Exit.isFailure(exit)) return say({ text: failureMessage(exit.cause), error: true });
    const removed = exit.value;
    say({
      text: !next
        ? "Your messages can go on the boards again."
        : removed > 0
          ? `Done. Took down ${removed} ${removed === 1 ? "post" : "posts"}.`
          : "Done. Your messages stay off the boards now.",
    });
  };

  return (
    <>
      <Switch
        checked={optedOut}
        disabled={busy}
        aria-labelledby={labelledBy}
        onCheckedChange={(checked) => {
          say(undefined);
          if (checked) setConfirming(true);
          else change(false);
        }}
      />
      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep your messages off the boards?</AlertDialogTitle>
            <AlertDialogDescription>
              Your posts on the boards come down, and they don't keep their reactions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                // Stay open until the bot has answered.
                event.preventDefault();
                change(true);
              }}
            >
              {busy && <Spinner />}
              Opt out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
