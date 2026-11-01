import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FloppyDiskIcon, ProhibitIcon, XIcon } from "@phosphor-icons/react";
import { Exit, Result, Schema, SchemaIssue } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmojiPicker } from "@/components/EmojiPicker";
import { FieldSkeleton, Placeholder } from "@/components/loading";
import { Problem } from "@/components/Problem";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StarboardInput, type StarboardSetup } from "../rpc.ts";
import { Api, failureMessage, KARMA_KEYS, STARBOARD_KEYS } from "./api.ts";
import { useGuild } from "./guild.tsx";

// The starboard settings, for members with `starboard.config`, in a dialog
// on the starboard page: the same as `!starboard set` and `disable` in chat.
// Each change is a settings change, recorded with who made it.

type Key = keyof StarboardInput;
/** The first problem with each field, as StarboardInput's checks word it. */
type Problems = Partial<Record<Key, string>>;

/** The fields in the order the form shows them, to focus the first one with a problem. */
const ORDER: readonly Key[] = ["channelId", "threshold", "emoji", "karma"];

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

/** What the form offers. Mount it ahead with `useAtomMount`, so the form is ready when it opens. */
export const setupQuery = (guildId: string) =>
  Api.query("starboardSetup", { guildId }, { reactivityKeys: STARBOARD_KEYS });

/** The form, once the channels and emoji it offers are in. */
export function StarboardSettings({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const setup = useAtomValue(setupQuery(useGuild().id));
  return AsyncResult.matchWithError(setup, {
    // The form's fields, so the dialog doesn't jump when they come in.
    onInitial: () => (
      <Placeholder label="Loading the settings" className="flex flex-col gap-5">
        <FieldSkeleton />
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <FieldSkeleton />
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
      </Placeholder>
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
  onDone: () => void;
}) {
  const { id: guildId } = useGuild();
  const save = useAtomSet(Api.mutation("setStarboard"), { mode: "promiseExit" });
  const disable = useAtomSet(Api.mutation("disableStarboard"), { mode: "promiseExit" });
  const { config } = setup;
  const [draft, setDraft] = useState<StarboardInput>({
    channelId: config.channelId ?? "",
    threshold: config.threshold,
    emoji: config.emoji,
    karma: config.karma,
  });
  // A field's problem shows once the member has left it, or tried to save.
  const [touched, setTouched] = useState<ReadonlySet<Key>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const set = <K extends Key>(key: K, value: StarboardInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const touch = (key: Key) => setTouched((keys) => (keys.has(key) ? keys : new Set(keys).add(key)));
  const checked = useMemo(() => check(draft), [draft]);
  const problems: Problems = Result.isFailure(checked) ? checked.failure : {};
  const problem = (key: Key) => (submitted || touched.has(key) ? problems[key] : undefined);
  /** The props that tie a control to its description, where it has one, and problem. */
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
    // The karma page says what getting into the starboard gives.
    const exit = await save({
      payload: { guildId, starboard: checked.success },
      reactivityKeys: [...STARBOARD_KEYS, ...KARMA_KEYS],
    });
    setBusy(false);
    if (Exit.isFailure(exit)) return toast.error(failureMessage(exit.cause));
    toast.success(config.channelId === null ? "The starboard is on" : "Saved the starboard");
    onDone();
  };

  const turnOff = async () => {
    setBusy(true);
    const exit = await disable({ payload: { guildId }, reactivityKeys: [...STARBOARD_KEYS, ...KARMA_KEYS] });
    setBusy(false);
    if (Exit.isFailure(exit)) return toast.error(failureMessage(exit.cause));
    toast.success("The starboard is off");
    onDone();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <FieldGroup>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <Field data-invalid={problem("channelId") ? true : undefined} className="sm:col-span-2">
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
            <FieldError id={`${id}-channelId-problem`}>{problem("channelId")}</FieldError>
          </Field>

          <Field data-invalid={problem("threshold") ? true : undefined}>
            <FieldLabel htmlFor={`${id}-threshold`}>Votes needed</FieldLabel>
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
            <FieldError id={`${id}-emoji-problem`}>{problem("emoji")}</FieldError>
          </Field>

          <Field data-invalid={problem("karma") ? true : undefined}>
            <FieldLabel htmlFor={`${id}-karma`}>Karma gain</FieldLabel>
            <Input
              {...control("karma")}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={Number.isNaN(draft.karma) ? "" : draft.karma}
              onChange={(e) => set("karma", e.target.valueAsNumber)}
              onBlur={() => touch("karma")}
              required
            />
            <FieldDescription id={`${id}-karma-hint`}>For the author, while karma is on.</FieldDescription>
            <FieldError id={`${id}-karma-problem`}>{problem("karma")}</FieldError>
          </Field>
        </div>
      </FieldGroup>
      <DialogFooter>
        {config.channelId !== null && (
          <Button type="button" variant="destructive" className="sm:mr-auto" disabled={busy} onClick={turnOff}>
            <ProhibitIcon />
            Turn off
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
      </DialogFooter>
    </form>
  );
}
