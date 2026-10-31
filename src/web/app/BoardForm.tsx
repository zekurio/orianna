import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FloppyDiskIcon, PlusIcon, TrashIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Exit, Result, Schema, SchemaIssue } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useMemo, useState } from "react";
import { BoardInput, type BoardSetup } from "../rpc.ts";
import { Api, BOARD_KEYS, failureMessage } from "./api.ts";
import { useSession } from "./App.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

// Setting up a board, for members with `boards.manage`, on the boards page:
// the same as `!board create`, `edit` and `delete` in chat. Each change is a
// settings change, recorded with who made it, and the boards start over with it.

type SetupBoard = BoardSetup["boards"][number];
type Channel = BoardSetup["channels"][number];
type Emoji = BoardSetup["emojis"][number];
type Key = keyof BoardInput;
/** The first problem with each field, as BoardInput's checks word it. */
type Problems = Partial<Record<Key, string>>;

/** The fields in the order the form shows them, to focus the first one with a problem. */
const ORDER: readonly Key[] = ["name", "emoji", "channelId", "threshold", "ignoredChannelIds"];

const NEW_BOARD: BoardInput = { name: "", emoji: "⭐", channelId: "", threshold: 5, keep: false, ignoredChannelIds: [] };

const decodeBoard = Schema.decodeUnknownResult(BoardInput);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** The draft as the bot will take it, or what's wrong with it. */
function check(draft: BoardInput): Result.Result<BoardInput, Problems> {
  return Result.mapError(decodeBoard(draft, { errors: "all" }), (error) => {
    const problems: Problems = {};
    for (const { path = [], message } of formatIssue(error.issue).issues) {
      const head = path[0];
      const key = String(typeof head === "object" ? head.key : head) as Key;
      problems[key] ??= message;
    }
    return problems;
  });
}

function Problem({ children }: { children: string }) {
  return (
    <Alert variant="destructive">
      <WarningCircleIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

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
    onInitial: () => (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        Loading…
      </p>
    ),
    onError: (error) => (
      <Problem>
        {error._tag === "Refused" ? error.message : "The bot ran into a problem. Its log says what happened."}
      </Problem>
    ),
    onDefect: () => <Problem>The bot ran into a problem. Its log says what happened.</Problem>,
    onSuccess: ({ value }) => {
      const original = name === undefined ? undefined : value.boards.find((b) => b.name === name);
      if (name !== undefined && !original) {
        return (
          <Alert>
            <WarningCircleIcon />
            <AlertDescription>Someone deleted {name} meanwhile.</AlertDescription>
          </Alert>
        );
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
  const [board, setBoard] = useState<BoardInput>(() => {
    if (!original) return { ...NEW_BOARD, channelId: setup.channels[0]?.id ?? "" };
    const { emojiUrl: _url, ...input } = original;
    return input;
  });
  // A field's problem shows once the member has left it, or tried to save.
  const [touched, setTouched] = useState<ReadonlySet<Key>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();

  const set = <K extends Key>(key: K, value: BoardInput[K]) => setBoard((b) => ({ ...b, [key]: value }));
  const touch = (key: Key) => setTouched((keys) => (keys.has(key) ? keys : new Set(keys).add(key)));
  const checked = useMemo(() => check(board), [board]);
  const problems: Problems = Result.isFailure(checked) ? checked.failure : {};
  const problem = (key: Key) => (submitted || touched.has(key) ? problems[key] : undefined);
  /** The props that tie a control to its description and problem. */
  const control = (key: Key) => ({
    id: `${id}-${key}`,
    "aria-invalid": problem(key) ? true : undefined,
    "aria-describedby": `${id}-${key}-hint ${id}-${key}-problem`,
  });

  const channel = setup.channels.find((c) => c.id === board.channelId);
  const known = new Set(setup.channels.map((c) => c.id));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (Result.isFailure(checked)) {
      setSubmitted(true);
      const first = ORDER.find((key) => checked.failure[key]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    const input = checked.success;
    setBusy(true);
    setError(undefined);
    if (original) {
      const exit = await edit({ payload: { name: original.name, board: input }, reactivityKeys: BOARD_KEYS });
      setBusy(false);
      if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
      onDone(input.name, exit.value ? `Saved ${input.name}.` : `Nothing about ${input.name} changed.`);
    } else {
      const exit = await create({ payload: { board: input }, reactivityKeys: BOARD_KEYS });
      setBusy(false);
      if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
      onDone(input.name, `Created ${input.name}. It's live now.`);
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
    <form onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{original ? `Edit ${original.name}` : "New board"}</CardTitle>
          <CardDescription>
            Changes apply right away and show up in <code>{prefix}settings log</code>.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <FieldGroup>
            {/* Room for a name and a channel name, and no more than a short emoji code or a number needs. */}
            <div className="grid max-w-3xl gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,1fr)_16rem]">
              <Field data-invalid={problem("name") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  {...control("name")}
                  value={board.name}
                  onChange={(e) => set("name", e.target.value.toLowerCase())}
                  onBlur={() => touch("name")}
                  placeholder="gems"
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <FieldDescription id={`${id}-name-hint`}>
                  What members call it, like in <code>{prefix}board top</code>.
                  {original && " Renaming keeps its posts and leaderboard."}
                </FieldDescription>
                <FieldError id={`${id}-name-problem`}>{problem("name")}</FieldError>
              </Field>

              <EmojiField
                control={control("emoji")}
                problem={problem("emoji")}
                value={board.emoji}
                emojis={setup.emojis}
                originalUrl={original?.emoji === board.emoji ? original.emojiUrl : null}
                onChange={(emoji) => set("emoji", emoji)}
                onClose={() => touch("emoji")}
              />

              <Field data-invalid={problem("channelId") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-channelId`}>Channel</FieldLabel>
                <Select
                  value={board.channelId}
                  onValueChange={(value) => set("channelId", value)}
                  onOpenChange={(open) => {
                    if (!open) touch("channelId");
                  }}
                >
                  <SelectTrigger {...control("channelId")} className="w-full">
                    <SelectValue placeholder="Pick a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {!channel && board.channelId !== "" && (
                      <SelectItem value={board.channelId}>A channel you can't see</SelectItem>
                    )}
                    {setup.channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        #{c.name}
                        {c.nsfw && " (NSFW)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription id={`${id}-channelId-hint`}>
                  {channel?.nsfw
                    ? "An NSFW channel, so posts show NSFW images as they are."
                    : "Where the bot posts. NSFW images come blurred unless the channel is NSFW."}
                </FieldDescription>
                <FieldError id={`${id}-channelId-problem`}>{problem("channelId")}</FieldError>
              </Field>

              <Field data-invalid={problem("threshold") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-threshold`}>Reactions needed</FieldLabel>
                <Input
                  {...control("threshold")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={Number.isNaN(board.threshold) ? "" : board.threshold}
                  onChange={(e) => set("threshold", e.target.valueAsNumber)}
                  onBlur={() => touch("threshold")}
                  required
                />
                <FieldDescription id={`${id}-threshold-hint`}>The author's own doesn't count.</FieldDescription>
                <FieldError id={`${id}-threshold-problem`}>{problem("threshold")}</FieldError>
              </Field>

              <Field orientation="horizontal" className="sm:col-span-2">
                <Switch
                  id={`${id}-keep`}
                  checked={board.keep}
                  onCheckedChange={(keep) => set("keep", keep)}
                  aria-describedby={`${id}-keep-hint`}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-keep`}>Keep posts up</FieldLabel>
                  <FieldDescription id={`${id}-keep-hint`}>
                    Leave a post up when reactions drop below the threshold again, like a hall of shame.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </div>

            <ChannelChecklist
              id={`${id}-ignoredChannelIds`}
              problem={problem("ignoredChannelIds")}
              channels={setup.channels.filter((c) => c.id !== board.channelId)}
              selected={board.ignoredChannelIds}
              hidden={board.ignoredChannelIds.filter((ignored) => !known.has(ignored)).length}
              onChange={(ids) => {
                set("ignoredChannelIds", ids);
                touch("ignoredChannelIds");
              }}
            />

            {error && <Problem>{error}</Problem>}
          </FieldGroup>
        </CardContent>

        <CardFooter className="flex-wrap justify-end gap-2">
          {original && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive" className="mr-auto" disabled={busy}>
                  <TrashIcon />
                  Delete board
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {original.name}?</AlertDialogTitle>
                  <AlertDialogDescription>Its posts stay up, but leave its leaderboard.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={deleteBoard}>
                    <TrashIcon />
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            <XIcon />
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : original ? <FloppyDiskIcon /> : <PlusIcon />}
            {busy ? "Saving…" : original ? "Save" : "Create board"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function EmojiField({
  control,
  problem,
  value,
  emojis,
  originalUrl,
  onChange,
  onClose,
}: {
  control: { id: string; "aria-invalid"?: boolean; "aria-describedby": string };
  problem: string | undefined;
  value: string;
  emojis: readonly Emoji[];
  originalUrl: string | null;
  onChange: (emoji: string) => void;
  onClose: () => void;
}) {
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor={control.id}>Emoji</FieldLabel>
      <EmojiPicker
        {...control}
        value={value}
        server={emojis}
        fallbackImage={originalUrl}
        onChange={onChange}
        onClose={onClose}
      />
      <FieldDescription id={`${control.id}-hint`}>What members react with.</FieldDescription>
      <FieldError id={`${control.id}-problem`}>{problem}</FieldError>
    </Field>
  );
}

/**
 * Ignored channels. Ones the member can't see aren't listed, and stay
 * ignored, so editing never undoes what someone else set.
 */
function ChannelChecklist({
  id,
  problem,
  channels,
  selected,
  hidden,
  onChange,
}: {
  id: string;
  problem: string | undefined;
  channels: readonly Channel[];
  selected: readonly string[];
  /** How many of `selected` the member can't see. */
  hidden: number;
  onChange: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = channels.filter((c) => c.name.includes(filter.trim().toLowerCase().replace(/^#/, "")));
  const toggle = (channel: string, on: boolean) =>
    onChange(on ? [...selected, channel] : selected.filter((other) => other !== channel));

  return (
    <FieldSet aria-describedby={`${id}-hint ${id}-problem`}>
      <FieldLegend>Ignored channels</FieldLegend>
      <FieldDescription id={`${id}-hint`}>
        Messages from these never go up on this board. The bot reads private channels too, so list the ones whose
        messages shouldn't be seen elsewhere.
        {hidden > 0 &&
          ` ${hidden} more ${hidden === 1 ? "channel you can't see is" : "channels you can't see are"} ignored too.`}
      </FieldDescription>
      {channels.length > 8 && (
        <Input
          type="search"
          className="sm:max-w-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a channel"
          aria-label="Find a channel"
        />
      )}
      <div
        id={id}
        tabIndex={-1}
        className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-3 overflow-y-auto rounded-lg border p-3"
      >
        {shown.map((c) => (
          <Field key={c.id} orientation="horizontal">
            <Checkbox
              id={`${id}-${c.id}`}
              checked={selected.includes(c.id)}
              onCheckedChange={(on) => toggle(c.id, on === true)}
            />
            <FieldLabel htmlFor={`${id}-${c.id}`} className="min-w-0 font-normal wrap-anywhere">
              #{c.name}
              {c.nsfw && <Badge variant="destructive">NSFW</Badge>}
            </FieldLabel>
          </Field>
        ))}
        {shown.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {channels.length === 0 ? "There's no other channel to ignore." : "No channel matches."}
          </p>
        )}
      </div>
      <FieldError id={`${id}-problem`}>{problem}</FieldError>
    </FieldSet>
  );
}
