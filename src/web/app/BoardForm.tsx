import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FloppyDisk, Plus, Trash, X } from "@phosphor-icons/react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { BoardInput, BoardSetup } from "../rpc.ts";
import { Api, BOARD_KEYS, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";
import {
  buttonClass,
  checkboxClass,
  Confirm,
  cx,
  Field,
  FieldSet,
  Hint,
  inputClass,
  Loading,
  Notice,
  Tag,
} from "./ui.tsx";

// Setting up a board, for members with `boards.manage`, on the boards page:
// the same as `!board create`, `edit` and `delete` in chat. Each change is a
// settings change, recorded with who made it, and the boards start over with it.

type SetupBoard = BoardSetup["boards"][number];
type Channel = BoardSetup["channels"][number];
type Emoji = BoardSetup["emojis"][number];

/** The settings schema's rule for names. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Emoji that make good boards, for a quick pick. */
const QUICK_EMOJI = ["⭐", "💎", "🔥", "😂", "💀", "🪨", "🏆", "❤️"];

const NEW_BOARD: BoardInput = { name: "", emoji: "⭐", channelId: "", threshold: 5, keep: false, ignoredChannelIds: [] };

/**
 * The form for a new board, or for the board called `name`, once the
 * channels and emoji it offers are in.
 */
export function BoardEditor({
  name,
  onCancel,
  onDone,
}: {
  name?: string;
  onCancel: () => void;
  /** With the board's name afterwards, null once it's deleted, and what to tell the member. */
  onDone: (board: string | null, message: string) => void;
}) {
  const setup = useAtomValue(Api.query("boardSetup", undefined, { reactivityKeys: BOARD_KEYS }));
  return AsyncResult.matchWithError(setup, {
    onInitial: () => <Loading />,
    onError: (error) => (
      <Notice>
        {error._tag === "Refused" ? error.message : "The bot ran into a problem. Its log says what happened."}
      </Notice>
    ),
    onDefect: () => <Notice>The bot ran into a problem. Its log says what happened.</Notice>,
    onSuccess: ({ value }) => {
      const original = name === undefined ? undefined : value.boards.find((b) => b.name === name);
      if (name !== undefined && !original) {
        return <Notice>Someone deleted {name} meanwhile.</Notice>;
      }
      return <BoardForm setup={value} original={original} onCancel={onCancel} onDone={onDone} />;
    },
  });
}

/** Adds a board, or edits `original`. */
function BoardForm({
  setup,
  original,
  onCancel,
  onDone,
}: {
  setup: BoardSetup;
  original?: SetupBoard;
  onCancel: () => void;
  onDone: (board: string | null, message: string) => void;
}) {
  const { prefix } = useSession();
  const create = useAtomSet(Api.mutation("createBoard"), { mode: "promiseExit" });
  const edit = useAtomSet(Api.mutation("editBoard"), { mode: "promiseExit" });
  const remove = useAtomSet(Api.mutation("deleteBoard"), { mode: "promiseExit" });
  const [deleting, setDeleting] = useState(false);
  const [board, setBoard] = useState<BoardInput>(() => {
    if (!original) return { ...NEW_BOARD, channelId: setup.channels[0]?.id ?? "" };
    const { emojiUrl: _url, ...input } = original;
    return input;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const set = <K extends keyof BoardInput>(key: K, value: BoardInput[K]) => setBoard((b) => ({ ...b, [key]: value }));

  const nameProblem =
    board.name && !NAME.test(board.name)
      ? "Lowercase letters, digits and hyphens, up to 32, starting with a letter or digit."
      : undefined;
  const channel = setup.channels.find((c) => c.id === board.channelId);
  const ready = NAME.test(board.name) && board.emoji.trim() !== "" && board.channelId !== "" && board.threshold >= 1;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    if (original) {
      const exit = await edit({ payload: { name: original.name, board }, reactivityKeys: BOARD_KEYS });
      setBusy(false);
      if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
      onDone(board.name, exit.value ? `Saved ${board.name}.` : `Nothing about ${board.name} changed.`);
    } else {
      const exit = await create({ payload: { board }, reactivityKeys: BOARD_KEYS });
      setBusy(false);
      if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
      onDone(board.name, `Created ${board.name}. It's live now.`);
    }
  };

  const deleteBoard = async () => {
    if (!original) return;
    setBusy(true);
    setError(undefined);
    const exit = await remove({ payload: { name: original.name }, reactivityKeys: BOARD_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
    onDone(null, `Deleted ${original.name}. Its posts stay in its channel.`);
  };

  return (
    <form
      className="flex flex-col gap-6 rounded-2xl border border-brass bg-raised px-5 py-5 sm:px-6"
      onSubmit={submit}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[1.375rem] leading-tight">{original ? `Edit ${original.name}` : "New board"}</h2>
        <Hint>
          Changes apply right away and show up in <code>{prefix}settings log</code>.
        </Hint>
      </div>

      <Field
        label="Name"
        htmlFor={`${id}-name`}
        hintId={`${id}-name-hint`}
        problem={nameProblem !== undefined}
        hint={
          nameProblem ??
          (original
            ? "What members call it, like in !board top. Renaming keeps its posts and leaderboard."
            : "What members call it, like in !board top.")
        }
      >
        <input
          id={`${id}-name`}
          className={inputClass}
          value={board.name}
          onChange={(e) => set("name", e.target.value.toLowerCase())}
          placeholder="gems"
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={`${id}-name-hint`}
          required
        />
      </Field>

      <EmojiField
        id={`${id}-emoji`}
        value={board.emoji}
        emojis={setup.emojis}
        originalUrl={original?.emoji === board.emoji ? original.emojiUrl : null}
        onChange={(emoji) => set("emoji", emoji)}
      />

      <div className="grid gap-x-4 gap-y-6 sm:grid-cols-[1fr_12rem]">
        <Field
          label="Channel"
          htmlFor={`${id}-channel`}
          hint={
            channel?.nsfw
              ? "An NSFW channel, so posts show NSFW images as they are."
              : "Where the bot posts. NSFW images come blurred unless the channel is NSFW."
          }
        >
          <select
            id={`${id}-channel`}
            className={inputClass}
            value={board.channelId}
            onChange={(e) => set("channelId", e.target.value)}
            required
          >
            {board.channelId === "" && <option value="">Pick a channel</option>}
            {!channel && board.channelId !== "" && <option value={board.channelId}>A channel you can't see</option>}
            {setup.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
                {c.nsfw ? " (NSFW)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reactions needed" htmlFor={`${id}-threshold`} hint="The author's own doesn't count.">
          <input
            id={`${id}-threshold`}
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={Number.isNaN(board.threshold) ? "" : board.threshold}
            onChange={(e) => set("threshold", e.target.valueAsNumber)}
            required
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className={cx(checkboxClass, "mt-1")}
          checked={board.keep}
          onChange={(e) => set("keep", e.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-display font-medium">Keep posts up</span>
          <Hint>Leave a post up when reactions drop below the threshold again, like a hall of shame.</Hint>
        </span>
      </label>

      <ChannelChecklist
        channels={setup.channels.filter((c) => c.id !== board.channelId)}
        selected={board.ignoredChannelIds}
        onChange={(ids) => set("ignoredChannelIds", ids)}
      />

      {error && <Notice>{error}</Notice>}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
        {original && (
          <span className="mr-auto">
            {deleting ? (
              <Confirm
                confirm="Delete"
                cancel="Keep it"
                busy={busy}
                onConfirm={deleteBoard}
                onCancel={() => setDeleting(false)}
              >
                Delete {original.name}? Its posts stay up, but leave its leaderboard.
              </Confirm>
            ) : (
              <button
                type="button"
                className={buttonClass("danger")}
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash />
                Delete board
              </button>
            )}
          </span>
        )}
        <button type="button" className={buttonClass("secondary")} onClick={onCancel} disabled={busy}>
          <X />
          Cancel
        </button>
        <button type="submit" className={buttonClass()} disabled={!ready || busy}>
          {original ? <FloppyDisk /> : <Plus />}
          {busy ? "Saving…" : original ? "Save" : "Create board"}
        </button>
      </div>
    </form>
  );
}

/** A square button holding one emoji, brass while it's the one picked. */
const emojiTile =
  "grid size-11 flex-none place-items-center rounded-[10px] border bg-charcoal text-xl leading-none";

function EmojiField({
  id,
  value,
  emojis,
  originalUrl,
  onChange,
}: {
  id: string;
  value: string;
  emojis: readonly Emoji[];
  originalUrl: string | null;
  onChange: (emoji: string) => void;
}) {
  const custom = emojis.find((e) => e.text === value);
  const preview = custom?.url ?? originalUrl;
  const pick = (picked: boolean) =>
    cx(emojiTile, picked ? "border-brass bg-brass/14" : "border-line hover:border-rose");
  return (
    <FieldSet legend="Emoji">
      <div className="flex gap-2.5">
        <span className={cx(emojiTile, "border-line")} aria-hidden="true">
          {preview ? <img src={preview} alt="" className="size-7 object-contain" /> : value}
        </span>
        <input
          id={id}
          className={inputClass}
          aria-label="Emoji"
          value={custom ? `:${custom.name}:` : value}
          onChange={(e) => {
            // `:name:` of a server emoji counts as that emoji.
            const typed = e.target.value.trim();
            onChange(emojis.find((emoji) => `:${emoji.name}:` === typed)?.text ?? typed);
          }}
          placeholder="⭐"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      <Hint>Type or paste an emoji, or pick one below.</Hint>
      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto" role="group" aria-label="Pick an emoji">
        {QUICK_EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={pick(value === emoji)}
            aria-pressed={value === emoji}
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
        {emojis.map((emoji) => (
          <button
            key={emoji.text}
            type="button"
            className={pick(value === emoji.text)}
            aria-pressed={value === emoji.text}
            title={`:${emoji.name}:`}
            onClick={() => onChange(emoji.text)}
          >
            <img src={emoji.url} alt={`:${emoji.name}:`} loading="lazy" className="size-6 object-contain" />
          </button>
        ))}
      </div>
    </FieldSet>
  );
}

/**
 * Ignored channels. Ones the member can't see aren't listed, and stay
 * ignored, so editing never undoes what someone else set.
 */
function ChannelChecklist({
  channels,
  selected,
  onChange,
}: {
  channels: readonly Channel[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const listed = new Set(channels.map((c) => c.id));
  const hidden = selected.filter((id) => !listed.has(id)).length;
  const shown = channels.filter((c) => c.name.includes(filter.trim().toLowerCase().replace(/^#/, "")));
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((other) => other !== id));

  return (
    <FieldSet
      legend="Ignored channels"
      hint={
        <>
          Messages from these never go up on this board. The bot reads private channels too, so list the ones whose
          messages shouldn't be seen elsewhere.
          {hidden > 0 &&
            ` ${hidden} more ${hidden === 1 ? "channel you can't see is" : "channels you can't see are"} ignored too.`}
        </>
      }
    >
      {channels.length > 8 && (
        <input
          type="search"
          className={inputClass}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a channel"
          aria-label="Find a channel"
        />
      )}
      <div className="grid max-h-60 grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 overflow-y-auto rounded-[10px] border border-line bg-charcoal px-3 py-2">
        {shown.map((c) => (
          <label key={c.id} className="flex min-w-0 cursor-pointer items-center gap-2 py-1.5 wrap-anywhere">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={selected.includes(c.id)}
              onChange={(e) => toggle(c.id, e.target.checked)}
            />
            #{c.name}
            {c.nsfw && <Tag>NSFW</Tag>}
          </label>
        ))}
        {shown.length === 0 && <Hint>No channel matches.</Hint>}
      </div>
    </FieldSet>
  );
}
