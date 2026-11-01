import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { FloppyDiskIcon, PlusIcon, ProhibitIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { Cause, Exit, Result, Schema, SchemaIssue } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { toast } from "sonner";
import { EmojiPicker, type ServerEmoji } from "@/components/EmojiPicker";
import { FieldSkeleton, Placeholder } from "@/components/loading";
import { Problem } from "@/components/Problem";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
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
import { KarmaInput, type KarmaRuleInput, type KarmaSetup } from "../rpc.ts";
import { numberValue, type Problems, problemAt } from "./admin/shared.tsx";
import { Api, failureMessage, KARMA_KEYS } from "./api.ts";
import { useGuild } from "./guild.tsx";

// The karma settings, for members with `karma.config`, in a dialog on the
// karma page. They're the `karma` section of the bot settings, so each change
// is recorded with who made it. The form checks the numbers; the bot checks
// the rest, and its problems come back by path, like `/karma/upvotes/0: …`,
// to show by the field.

const ROOT = "/karma";

/** As many as the settings take. */
const MAX_EMOJI = 20;

/** `<@id>`, `<@!id>` or a bare ID, as `!karma` takes them. */
const MEMBER = /^(?:<@!?(\d+)>|(\d+))$/;

const ACTIONS: Record<KarmaRuleInput["action"], string> = {
  role: "Give a role",
  message: "Send a DM",
  kick: "Kick",
  ban: "Ban",
};

const decodeInput = Schema.decodeUnknownResult(KarmaInput);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** What's wrong with the draft before the bot sees it, with paths like the bot's. */
function check(draft: KarmaInput): string[] {
  const problems = (["upvotes", "downvotes"] as const).flatMap((list) =>
    draft[list].flatMap((emoji, i) => (emoji === "" ? [`${ROOT}/${list}/${i}: Pick an emoji.`] : [])),
  );
  const decoded = decodeInput(draft, { errors: "all" });
  if (Result.isFailure(decoded)) {
    for (const { path = [], message } of formatIssue(decoded.failure.issue).issues) {
      problems.push(`${ROOT}/${path.map((p) => String(typeof p === "object" ? p.key : p)).join("/")}: ${message}`);
    }
  }
  return problems;
}

/** What the form offers. Mount it ahead with `useAtomMount`, so the form is ready when it opens. */
export const karmaSetupQuery = (guildId: string) =>
  Api.query("karmaSetup", { guildId }, { reactivityKeys: KARMA_KEYS });

/** The form, once what it offers is in. */
export function KarmaSettings({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const setup = useAtomValue(karmaSetupQuery(useGuild().id));
  return AsyncResult.matchWithError(setup, {
    // The form's fields, so the dialog doesn't jump when they come in.
    onInitial: () => (
      <Placeholder label="Loading the settings" className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
      </Placeholder>
    ),
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) => <KarmaForm setup={value} onCancel={onCancel} onDone={onDone} />,
  });
}

function KarmaForm({ setup, onCancel, onDone }: { setup: KarmaSetup; onCancel: () => void; onDone: () => void }) {
  const { id: guildId } = useGuild();
  const save = useAtomSet(Api.mutation("setKarma"), { mode: "promiseExit" });
  const disable = useAtomSet(Api.mutation("disableKarma"), { mode: "promiseExit" });
  const [draft, setDraft] = useState<KarmaInput>(setup.config);
  // The form's own problems show once the member tried to save; the bot's stay until the next save.
  const [submitted, setSubmitted] = useState(false);
  const [rejected, setRejected] = useState<Problems>([]);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const set = <K extends keyof KarmaInput>(key: K, value: KarmaInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const problems: Problems = [...(submitted ? check(draft) : []), ...rejected];
  const problem = (path: string) => problemAt(problems, `${ROOT}/${path}`);
  // The problems no field shows.
  const shownHere = (p: string) =>
    /^\/karma\/(upvotes\/\d+|downvotes\/\d+|votesPerHour|blocklist\/\d+|rules\/\d+\/(when|value|action|roleId|message)): /.test(
      p,
    );
  const rest = problems.filter((p) => !shownHere(p));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (check(draft).length > 0) return setSubmitted(true);
    setBusy(true);
    const exit = await save({ payload: { guildId, karma: draft }, reactivityKeys: KARMA_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as { _tag?: string; problems?: readonly string[] };
      if (failure._tag === "SettingsRejected" && failure.problems) {
        setRejected(failure.problems);
        return toast.error("Couldn't save karma", { description: "Check the marked fields." });
      }
      return toast.error(failureMessage(exit.cause));
    }
    toast.success(setup.on ? "Saved karma" : "Karma is on");
    onDone();
  };

  const turnOff = async () => {
    setBusy(true);
    const exit = await disable({ payload: { guildId }, reactivityKeys: KARMA_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) return toast.error(failureMessage(exit.cause));
    toast.success("Karma is off", { description: "Members keep their karma." });
    onDone();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <FieldGroup>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <EmojiList
            list="upvotes"
            legend="Upvotes"
            value={draft.upvotes}
            server={setup.emojis}
            problems={problems}
            onChange={(upvotes) => set("upvotes", upvotes)}
          />
          <EmojiList
            list="downvotes"
            legend="Downvotes"
            value={draft.downvotes}
            server={setup.emojis}
            problems={problems}
            onChange={(downvotes) => set("downvotes", downvotes)}
          />

          <Field data-invalid={problem("votesPerHour") ? true : undefined}>
            <FieldLabel htmlFor={`${id}-votes`}>Votes per hour</FieldLabel>
            <Input
              id={`${id}-votes`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={numberValue(draft.votesPerHour)}
              onChange={(e) => set("votesPerHour", e.target.valueAsNumber)}
              aria-invalid={problem("votesPerHour") ? true : undefined}
            />
            <FieldDescription>Per member.</FieldDescription>
            <FieldError>{problem("votesPerHour")}</FieldError>
          </Field>

          <Field className="self-start">
            <FieldLabel htmlFor={`${id}-penalty`}>Downvoting costs the voter a point</FieldLabel>
            {/* As tall as the input next to it, so the switch lines up with it. */}
            <div className="flex h-8 items-center">
              <Switch id={`${id}-penalty`} checked={draft.penalty} onCheckedChange={(on) => set("penalty", on)} />
            </div>
          </Field>
        </div>

        <Blocklist
          value={draft.blocklist}
          names={setup.blocked}
          problems={problems}
          onChange={(blocklist) => set("blocklist", blocklist)}
        />

        <FieldSet>
          <FieldLegend variant="label">Rules</FieldLegend>
          <FieldDescription>What happens when a member's karma crosses a value.</FieldDescription>
          {draft.rules.length > 0 && (
            <ul className="flex flex-col gap-4">
              {draft.rules.map((rule, i) => (
                <RuleRow
                  key={i}
                  rule={rule}
                  at={`rules/${i}`}
                  roles={setup.roles}
                  problems={problems}
                  onChange={(next) => set("rules", draft.rules.with(i, next))}
                  onRemove={() => set("rules", draft.rules.filter((_, j) => j !== i))}
                />
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => set("rules", [...draft.rules, { when: "above", value: 10, action: "role" }])}
          >
            <PlusIcon />
            Add rule
          </Button>
        </FieldSet>

        {rest.length > 0 && <Problem message={rest.join("\n")} />}
      </FieldGroup>
      <DialogFooter>
        {setup.on && (
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
          {busy ? "Saving…" : setup.on ? "Save" : "Turn on"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EmojiList({
  list,
  legend,
  value,
  server,
  problems,
  onChange,
}: {
  list: "upvotes" | "downvotes";
  legend: string;
  value: readonly string[];
  server: readonly ServerEmoji[];
  problems: Problems;
  onChange: (value: readonly string[]) => void;
}) {
  const id = useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      {value.length > 0 && (
        <ul className="flex flex-col gap-2">
          {value.map((emoji, i) => {
            const problem = problemAt(problems, `${ROOT}/${list}/${i}`);
            return (
              <li key={i}>
                <Field data-invalid={problem ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-${i}`} className="sr-only">
                    {legend}, emoji {i + 1}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <EmojiPicker
                      id={`${id}-${i}`}
                      aria-invalid={problem ? true : undefined}
                      value={emoji}
                      server={server}
                      onChange={(next) => onChange(value.with(i, next))}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      aria-label="Remove emoji"
                      onClick={() => onChange(value.filter((_, j) => j !== i))}
                    >
                      <TrashIcon />
                    </Button>
                  </div>
                  <FieldError>{problem}</FieldError>
                </Field>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={value.length >= MAX_EMOJI}
        onClick={() => onChange([...value, ""])}
      >
        <PlusIcon />
        Add emoji
      </Button>
    </FieldSet>
  );
}

/** Members who can't give or get karma. */
function Blocklist({
  value,
  names,
  problems,
  onChange,
}: {
  value: readonly string[];
  /** Of those still in the server. */
  names: Readonly<Record<string, string>>;
  problems: Problems;
  onChange: (value: readonly string[]) => void;
}) {
  const id = useId();
  const [entry, setEntry] = useState("");
  const [invalid, setInvalid] = useState(false);

  const add = () => {
    const match = MEMBER.exec(entry.trim());
    if (!match) return setInvalid(true);
    const userId = (match[1] ?? match[2])!;
    if (!value.includes(userId)) onChange([...value, userId]);
    setEntry("");
    setInvalid(false);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // Adds the member instead of saving the form.
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">Blocklist</FieldLegend>
      <FieldDescription>Members who can't give or get karma.</FieldDescription>
      {value.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {value.map((userId, i) => {
            const problem = problemAt(problems, `${ROOT}/blocklist/${i}`);
            return (
              <li key={userId} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">
                    {names[userId] ?? "A member who left"}{" "}
                    <span className="text-xs text-muted-foreground tabular-nums">{userId}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    aria-label="Unblock"
                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                  >
                    <TrashIcon />
                  </Button>
                </div>
                {problem && <p className="text-sm text-destructive">{problem}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <Field data-invalid={invalid ? true : undefined} className="sm:max-w-md">
        <FieldLabel htmlFor={`${id}-member`} className="sr-only">
          Member to block
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id={`${id}-member`}
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={onKey}
            placeholder="User ID or mention"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid ? true : undefined}
          />
          <Button type="button" variant="outline" onClick={add} disabled={entry.trim() === ""}>
            <PlusIcon />
            Block
          </Button>
        </div>
        <FieldError>{invalid ? "That isn't a mention or a user ID." : undefined}</FieldError>
      </Field>
    </FieldSet>
  );
}

function RuleRow({
  rule,
  at,
  roles,
  problems,
  onChange,
  onRemove,
}: {
  rule: KarmaRuleInput;
  /** Its path under `/karma`, like `rules/0`. */
  at: string;
  roles: KarmaSetup["roles"];
  problems: Problems;
  onChange: (rule: KarmaRuleInput) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const problem = (key: string) => problemAt(problems, `${ROOT}/${at}/${key}`);
  const invalid = (key: string) => (problem(key) ? true : undefined);
  const { roleId: _roleId, message: _message, ...bare } = rule;
  const known = roles.some((r) => r.id === rule.roleId);

  return (
    <li className="grid gap-3 sm:grid-cols-[9rem_6rem_9rem_minmax(0,1fr)_auto] sm:items-start">
      <Field data-invalid={invalid("when")}>
        <FieldLabel htmlFor={`${id}-when`} className="sm:sr-only">
          When karma
        </FieldLabel>
        <Select value={rule.when} onValueChange={(when) => onChange({ ...rule, when: when as KarmaRuleInput["when"] })}>
          <SelectTrigger id={`${id}-when`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="above">Rises above</SelectItem>
            <SelectItem value="below">Drops below</SelectItem>
          </SelectContent>
        </Select>
        <FieldError>{problem("when")}</FieldError>
      </Field>

      <Field data-invalid={invalid("value")}>
        <FieldLabel htmlFor={`${id}-value`} className="sm:sr-only">
          Value
        </FieldLabel>
        <Input
          id={`${id}-value`}
          type="number"
          inputMode="numeric"
          step={1}
          value={numberValue(rule.value)}
          onChange={(e) => onChange({ ...rule, value: e.target.valueAsNumber })}
          aria-invalid={invalid("value")}
        />
        <FieldError>{problem("value")}</FieldError>
      </Field>

      <Field data-invalid={invalid("action")}>
        <FieldLabel htmlFor={`${id}-action`} className="sm:sr-only">
          Then
        </FieldLabel>
        <Select
          value={rule.action}
          // Each action takes its own argument, so the old one goes.
          onValueChange={(action) => onChange({ ...bare, action: action as KarmaRuleInput["action"] })}
        >
          <SelectTrigger id={`${id}-action`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ACTIONS).map(([action, label]) => (
              <SelectItem key={action} value={action}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError>{problem("action")}</FieldError>
      </Field>

      {rule.action === "role" ? (
        <Field data-invalid={invalid("roleId")}>
          <FieldLabel htmlFor={`${id}-role`} className="sm:sr-only">
            Role
          </FieldLabel>
          <Select value={rule.roleId ?? ""} onValueChange={(roleId) => onChange({ ...bare, roleId })}>
            <SelectTrigger id={`${id}-role`} className="w-full" aria-invalid={invalid("roleId")}>
              <SelectValue placeholder="Pick a role" />
            </SelectTrigger>
            <SelectContent>
              {!known && rule.roleId !== undefined && <SelectItem value={rule.roleId}>Unknown role</SelectItem>}
              {roles.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  @{role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{problem("roleId")}</FieldError>
        </Field>
      ) : rule.action === "message" ? (
        <Field data-invalid={invalid("message")}>
          <FieldLabel htmlFor={`${id}-message`} className="sm:sr-only">
            Message
          </FieldLabel>
          <Input
            id={`${id}-message`}
            value={rule.message ?? ""}
            onChange={(e) => onChange(e.target.value === "" ? bare : { ...bare, message: e.target.value })}
            placeholder="What the DM says"
            maxLength={1000}
            aria-invalid={invalid("message")}
          />
          <FieldError>{problem("message")}</FieldError>
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground sm:pt-2">They get a DM first.</p>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-destructive hover:text-destructive max-sm:justify-self-end"
        aria-label="Remove rule"
        onClick={onRemove}
      >
        <TrashIcon />
      </Button>
    </li>
  );
}
