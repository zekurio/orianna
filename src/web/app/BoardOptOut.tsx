import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Api, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";
import { Confirm, cx, Hint, Loading, panel } from "./ui.tsx";

// Keeping your messages off the boards, like `!board optout` and `optin`.

const KEYS = ["board-opt-out"];

/** A checkbox drawn as a switch: a track, brass when on, with a knob that slides. */
const switchClass =
  "relative h-6 w-11 flex-none cursor-pointer appearance-none rounded-full bg-line transition-colors " +
  "after:absolute after:top-0.75 after:left-0.75 after:size-4.5 after:rounded-full after:bg-porcelain " +
  "after:transition-transform checked:bg-brass checked:after:translate-x-5 checked:after:bg-charcoal " +
  "disabled:cursor-progress disabled:opacity-60 motion-reduce:transition-none motion-reduce:after:transition-none";

export function BoardOptOut() {
  const optedOut = useAtomValue(Api.query("boardOptOut", undefined, { reactivityKeys: KEYS }));
  return (
    <section className={cx(panel, "flex flex-wrap items-start gap-x-8 gap-y-4 px-5 py-4.5")}>
      <div className="flex flex-[1_1_20rem] flex-col gap-1">
        <h3 className="text-lg leading-snug">Keep my messages off the boards</h3>
        <Hint>
          Your messages never go up on a board, however many react to them, and the ones already there come down.
          Turn it off again any time; messages go up again once someone reacts to them.
        </Hint>
      </div>
      {AsyncResult.matchWithError(optedOut, {
        onInitial: () => <Loading />,
        onError: () => <Hint problem>Couldn't load this.</Hint>,
        onDefect: () => <Hint problem>Couldn't load this.</Hint>,
        onSuccess: ({ value }) => <OptOutSwitch optedOut={value} />,
      })}
    </section>
  );
}

function OptOutSwitch({ optedOut }: { optedOut: boolean }) {
  const { prefix } = useSession();
  const set = useAtomSet(Api.mutation("setBoardOptOut"), { mode: "promiseExit" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();

  const change = async (next: boolean) => {
    setBusy(true);
    const exit = await set({ payload: { optedOut: next }, reactivityKeys: [...KEYS, "boards"] });
    setBusy(false);
    setConfirming(false);
    if (Exit.isFailure(exit)) return setMessage({ text: failureMessage(exit.cause), error: true });
    const removed = exit.value;
    setMessage({
      text: !next
        ? "Your messages can go on the boards again."
        : removed > 0
          ? `Done. Took down ${removed} ${removed === 1 ? "post" : "posts"}.`
          : "Done. Your messages stay off the boards now.",
    });
  };

  return (
    <div className="flex flex-[1_1_14rem] flex-col items-end gap-2 text-right">
      {confirming ? (
        <Confirm confirm="Opt out" busy={busy} onConfirm={() => change(true)} onCancel={() => setConfirming(false)}>
          Your posts on the boards come down, and they don't keep their reactions.
        </Confirm>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-2.5 font-display font-medium">
          <input
            type="checkbox"
            role="switch"
            className={switchClass}
            checked={optedOut}
            disabled={busy}
            onChange={(e) => {
              setMessage(undefined);
              if (e.target.checked) setConfirming(true);
              else change(false);
            }}
          />
          <span>{optedOut ? "On" : "Off"}</span>
        </label>
      )}
      {message && (
        <Hint problem={message.error}>
          <span role="status">{message.text}</span>
        </Hint>
      )}
      <Hint>
        Same as <code>{prefix}board optout</code> and <code>{prefix}board optin</code> in chat.
      </Hint>
    </div>
  );
}
