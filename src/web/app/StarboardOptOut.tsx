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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Api, failureMessage, STARBOARD_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";

// The starboard opt-out from shinpuru's privacy settings, like
// `!starboard optout` and `optin`.

const KEYS = ["starboard-opt-out"];

export function StarboardOptOut() {
  const { prefix } = useSession();
  const id = useId();
  const optedOut = useAtomValue(Api.query("starboardOptOut", undefined, { reactivityKeys: KEYS }));
  const [message, setMessage] = useState<Message>();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Starboard</CardTitle>
        <CardDescription>
          The starboard allows users to vote high quality or funny messages into the "starboard", where all voted
          messages are presented with their vote count. This starboard is represented as channel on the server as
          well as section in the web interface. Therefore, the message content needs to be stored in the database.
          If you don't want your messages to be presented in the starboard, here you can opt-out from it globally.
          Same as <code>{prefix}starboard optout</code> and <code>{prefix}starboard optin</code> in chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {AsyncResult.matchWithError(optedOut, {
          onInitial: () => <Spinner />,
          onError: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
          onDefect: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
          onSuccess: ({ value }) => <OptOutSwitch optedOut={value} id={id} say={setMessage} />,
        })}
        {message && (
          <p role="status" className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** What the last change did. */
type Message = { text: string; error?: boolean };

function OptOutSwitch({
  optedOut,
  id,
  say,
}: {
  optedOut: boolean;
  id: string;
  say: (message: Message | undefined) => void;
}) {
  const set = useAtomSet(Api.mutation("setStarboardOptOut"), { mode: "promiseExit" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = async (next: boolean) => {
    setBusy(true);
    const exit = await set({ payload: { optedOut: next }, reactivityKeys: [...KEYS, ...STARBOARD_KEYS] });
    setBusy(false);
    setConfirming(false);
    if (Exit.isFailure(exit)) return say({ text: failureMessage(exit.cause), error: true });
    const removed = exit.value;
    say({
      text: !next
        ? "Your messages can get into the starboard again."
        : removed > 0
          ? `Done. Took down ${removed} ${removed === 1 ? "post" : "posts"}.`
          : "Done. Your messages stay out of the starboard now.",
    });
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={optedOut}
          disabled={busy}
          onCheckedChange={(checked) => {
            say(undefined);
            if (checked) setConfirming(true);
            else change(false);
          }}
        />
        <Label htmlFor={id} className="whitespace-nowrap">
          Opt-out from starboard
        </Label>
      </div>
      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Opt-out from starboard?</AlertDialogTitle>
            <AlertDialogDescription>
              Your messages already in the starboard come down, and they don't keep their votes.
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
