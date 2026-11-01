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
import { Placeholder } from "@/components/loading";
import { SettingRow } from "@/components/settings";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Api, failureMessage, STARBOARD_KEYS } from "./api.ts";

// The starboard opt-out from shinpuru's privacy settings, like
// `!starboard optout` and `optin`, as a row of the profile page's privacy
// settings.

const KEYS = ["starboard-opt-out"];

export function StarboardOptOut() {
  const id = useId();
  const optedOut = useAtomValue(Api.query("starboardOptOut", undefined, { reactivityKeys: KEYS }));
  return (
    <SettingRow
      id={id}
      title="Keep me off the starboard"
      description="Your messages won't be posted there, and the bot won't store them for it."
      control={AsyncResult.matchWithError(optedOut, {
        onInitial: () => (
          <Placeholder>
            <Skeleton className="h-[18.4px] w-8 rounded-full" />
          </Placeholder>
        ),
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
    if (!next) return toast.success("Your messages can go on the starboard again");
    toast.success("You're off the starboard", {
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
            <AlertDialogTitle>Leave the starboard?</AlertDialogTitle>
            <AlertDialogDescription>Your posts on it are taken down and lose their votes.</AlertDialogDescription>
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
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
