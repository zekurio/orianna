import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FloppyDiskIcon, ProhibitIcon, XIcon } from "@phosphor-icons/react";
import { Exit, Result, Schema, SchemaIssue } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useMemo, useState } from "react";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Problem } from "@/components/Problem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StarboardInput, type StarboardSetup } from "../rpc.ts";
import { Api, failureMessage, STARBOARD_KEYS } from "./api.ts";
import { useSession } from "./App.tsx";

// The starboard settings, for members with `starboard.config`, on the
// starboard page: the same as `!starboard set` and `disable` in chat. Each
// change is a settings change, recorded with who made it.

type Key = keyof StarboardInput;
/** The first problem with each field, as StarboardInput's checks word it. */
type Problems = Partial<Record<Key, string>>;

/** The fields in the order the form shows them, to focus the first one with a problem. */
const ORDER: readonly Key[] = ["channelId", "threshold", "emoji"];

const decodeInput = Schema.decodeUnknownResult(StarboardInput);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** The draft as the bot will take it, or what's wrong with it. */
function check(draft: StarboardInput): Result.Result<StarboardInput, Problems> {
  return Result.mapError(decodeInput(draft, { errors: "all" }), (error) => {
    const problems: Problems = {};
    for (const { path = [], message } of formatIssue(error.issue).issues) {
      const head = path[0];
      const key = String(typeof head === "object" ? head.key : head) as Key;
      problems[key] ??= message;
    }
    return problems;
  });
}

/** The form, once the channels and emoji it offers are in. */
export function StarboardSettings({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  /** With what to tell the member. */
  onDone: (message: string) => void;
}) {
  const setup = useAtomValue(Api.query("starboardSetup", undefined, { reactivityKeys: STARBOARD_KEYS }));
  return AsyncResult.matchWithError(setup, {
    onInitial: () => (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        Loading…
      </p>
    ),
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) => <StarboardForm setup={value} onCancel={onCancel} onDone={onDone} />,
  });
}

function StarboardForm({
  setup,
  onCancel,
  onDone,
}: {
  setup: StarboardSetup;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const { prefix } = useSession();
  const save = useAtomSet(Api.mutation("setStarboard"), { mode: "promiseExit" });
  const disable = useAtomSet(Api.mutation("disableStarboard"), { mode: "promiseExit" });
  const { config } = setup;
  const [draft, setDraft] = useState<StarboardInput>({
    channelId: config.channelId ?? "",
    threshold: config.threshold,
    emoji: config.emoji,
  });
  // A field's problem shows once the member has left it, or tried to save.
  const [touched, setTouched] = useState<ReadonlySet<Key>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();

  const set = <K extends Key>(key: K, value: StarboardInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const touch = (key: Key) => setTouched((keys) => (keys.has(key) ? keys : new Set(keys).add(key)));
  const checked = useMemo(() => check(draft), [draft]);
  const problems: Problems = Result.isFailure(checked) ? checked.failure : {};
  const problem = (key: Key) => (submitted || touched.has(key) ? problems[key] : undefined);
  /** The props that tie a control to its description and problem. */
  const control = (key: Key) => ({
    id: `${id}-${key}`,
    "aria-invalid": problem(key) ? true : undefined,
    "aria-describedby": `${id}-${key}-hint ${id}-${key}-problem`,
  });

  const channel = setup.channels.find((c) => c.id === draft.channelId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (Result.isFailure(checked)) {
      setSubmitted(true);
      const first = ORDER.find((key) => checked.failure[key]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    const exit = await save({ payload: { starboard: checked.success }, reactivityKeys: STARBOARD_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
    onDone("Set starboard config.");
  };

  const turnOff = async () => {
    setBusy(true);
    setError(undefined);
    const exit = await disable({ payload: undefined, reactivityKeys: STARBOARD_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
    onDone("Starboard disabled. Set a channel as starboard channel to enable the starboard.");
  };

  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Starboard settings</CardTitle>
          <CardDescription>
            Same as <code>{prefix}starboard set</code>. Changes apply right away and show up in{" "}
            <code>{prefix}settings log</code>.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <FieldGroup>
            {/* Room for a channel name, and no more than a number or a short emoji code needs. */}
            <div className="grid max-w-3xl gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,1fr)_10rem_14rem]">
              <Field data-invalid={problem("channelId") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-channelId`}>Channel</FieldLabel>
                <Select
                  value={draft.channelId}
                  onValueChange={(value) => set("channelId", value)}
                  onOpenChange={(open) => {
                    if (!open) touch("channelId");
                  }}
                >
                  <SelectTrigger {...control("channelId")} className="w-full">
                    <SelectValue placeholder="Pick a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {!channel && draft.channelId !== "" && (
                      <SelectItem value={draft.channelId}>A channel you can't see</SelectItem>
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
                  The channel where the starboard messages will appear.
                </FieldDescription>
                <FieldError id={`${id}-channelId-problem`}>{problem("channelId")}</FieldError>
              </Field>

              <Field data-invalid={problem("threshold") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-threshold`}>Threshold</FieldLabel>
                <Input
                  {...control("threshold")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={Number.isNaN(draft.threshold) ? "" : draft.threshold}
                  onChange={(e) => set("threshold", e.target.valueAsNumber)}
                  onBlur={() => touch("threshold")}
                  required
                />
                <FieldDescription id={`${id}-threshold-hint`}>
                  The minimum number of emoji votes until a message gets into the starboard.
                </FieldDescription>
                <FieldError id={`${id}-threshold-problem`}>{problem("threshold")}</FieldError>
              </Field>

              <Field data-invalid={problem("emoji") ? true : undefined}>
                <FieldLabel htmlFor={`${id}-emoji`}>Emoji</FieldLabel>
                <EmojiPicker
                  {...control("emoji")}
                  value={draft.emoji}
                  server={setup.emojis}
                  fallbackImage={draft.emoji === config.emoji ? config.emojiUrl : null}
                  onChange={(emoji) => set("emoji", emoji)}
                  onClose={() => touch("emoji")}
                />
                <FieldDescription id={`${id}-emoji-hint`}>The emoji to be used for starring messages.</FieldDescription>
                <FieldError id={`${id}-emoji-problem`}>{problem("emoji")}</FieldError>
              </Field>
            </div>

            {error && <Problem message={error} />}
          </FieldGroup>
        </CardContent>

        <CardFooter className="flex-wrap justify-end gap-2">
          {config.channelId !== null && (
            <Button type="button" variant="destructive" className="mr-auto" disabled={busy} onClick={turnOff}>
              <ProhibitIcon />
              Disable
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            <XIcon />
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : <FloppyDiskIcon />}
            {busy ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
