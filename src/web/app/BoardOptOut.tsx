import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Api, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";

// Keeping your messages off the boards, like `!board optout` and `optin`.

const KEYS = ["board-opt-out"];

export function BoardOptOut() {
  const optedOut = useAtomValue(Api.query("boardOptOut", undefined, { reactivityKeys: KEYS }));
  return (
    <section className="setting">
      <div className="setting-text">
        <h3>Keep my messages off the boards</h3>
        <p className="hint">
          Your messages never go up on a board, however many react to them, and the ones already there come down.
          Turn it off again any time; messages go up again once someone reacts to them.
        </p>
      </div>
      {AsyncResult.matchWithError(optedOut, {
        onInitial: () => <span className="quiet">Loading…</span>,
        onError: () => <span className="form-error">Couldn't load this.</span>,
        onDefect: () => <span className="form-error">Couldn't load this.</span>,
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
    <div className="setting-control">
      {confirming ? (
        <span className="confirm">
          Your posts on the boards come down, and they don't keep their reactions.
          <button type="button" className="text-button danger" disabled={busy} onClick={() => change(true)}>
            Opt out
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
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
        <p className={message.error ? "form-error" : "hint"} role="status">
          {message.text}
        </p>
      )}
      <p className="hint">
        Same as <code>{prefix}board optout</code> and <code>{prefix}board optin</code> in chat.
      </p>
    </div>
  );
}
