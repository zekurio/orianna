import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { SettingRow } from "@/components/settings";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Api, failureMessage, STARBOARD_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";

// The starboard opt-out from shinpuru's privacy settings, like
// `!starboard optout` and `optin`, as a row of the profile page's privacy
// settings.

const KEYS = ["starboard-opt-out"];

export function StarboardOptOut() {
  const { prefix } = useSession();
  const id = useId();
  const optedOut = useAtomValue(Api.query("starboardOptOut", undefined, { reactivityKeys: KEYS }));
  return (
    <SettingRow
      id={id}
      title="Opt-out from starboard"
      description={
        <>
          The starboard allows users to vote high quality or funny messages into the "starboard", where all voted
          messages are presented with their vote count. This starboard is represented as channel on the server as
          well as section in the web interface. Therefore, the message content needs to be stored in the database.
          If you don't want your messages to be presented in the starboard, here you can opt-out from it globally.
        </>
      }
      hint={
        <>
          In chat: <code>{prefix}starboard optout</code> and <code>{prefix}starboard optin</code>.
        </>
      }
      control={AsyncResult.matchWithError(optedOut, {
        onInitial: () => <Spinner />,
        onError: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
        onDefect: () => <span className="text-sm text-destructive">Couldn't load this.</span>,
        onSuccess: ({ value }) => <OptOutSwitch optedOut={value} id={id} />,
      })}
    />
  );
}

function OptOutSwitch({ optedOut, id }: { optedOut: boolean; id: string }) {
  const set = useAtomSet(Api.mutation("setStarboardOptOut"), { mode: "promiseExit" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = async (next: boolean) => {
    setBusy(true);
    const exit = await set({ payload: { optedOut: next }, reactivityKeys: [...KEYS, ...STARBOARD_KEYS] });
    setBusy(false);
    setConfirming(false);
    if (Exit.isFailure(exit)) return toast.error(failureMessage(exit.cause));
    const removed = exit.value;
    if (!next) return toast.success("Your messages can get into the starboard again.");
    toast.success("Your messages stay out of the starboard now.", {
      description: removed > 0 ? `Took down ${removed} ${removed === 1 ? "post" : "posts"}.` : undefined,
    });
  };

  return (
    <>
      <Switch
        id={id}
        checked={optedOut}
        disabled={busy}
        aria-describedby={`${id}-description`}
        onCheckedChange={(checked) => {
          if (checked) setConfirming(true);
          else change(false);
        }}
      />
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
