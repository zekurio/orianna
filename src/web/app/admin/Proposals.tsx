import { useId, useState } from "react";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  differs,
  numberValue,
  type Problems,
  problemAt,
  problemsUnder,
  type SectionProps,
  type Settings,
  SettingsCard,
  useSave,
} from "./shared.tsx";

// Emoji and sticker proposals, which share the polls channel, and the polls
// members start with `!poll`. A section that's missing turns its feature off.

type Proposal = NonNullable<Settings["emoji"]>;
type Polls = NonNullable<Settings["polls"]>;

/** The defaults the settings schema fills in, for a feature that's turned on. */
const PROPOSAL_DEFAULTS: Proposal = { votingHours: 48, maxOpenPerUser: 3, maxImageBytes: 524288, threshold: 1 };
const POLLS_DEFAULTS: Polls = { defaultHours: 24, maxOpenPerUser: 5 };

/** Leaves the polls channel unset. */
const NO_CHANNEL = "none";

export function ProposalsSection(props: SectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <ProposalsCard {...props} />
      <PollsCard {...props} />
    </div>
  );
}

function ProposalsCard({ setup, settings }: SectionProps) {
  const { save, busy, problems } = useSave("proposals");
  const saved = { pollsChannelId: settings.pollsChannelId, emoji: settings.emoji, sticker: settings.sticker };
  const [draft, setDraft] = useState(saved);
  const id = useId();

  const needsChannel = (draft.emoji || draft.sticker) && !draft.pollsChannelId;
  const channelProblem = needsChannel ? "Proposals need a channel to vote in." : problemAt(problems, "/pollsChannelId");
  const invalid = needsChannel || [draft.emoji, draft.sticker].some((p) => p && proposalProblems(p).length > 0);
  const known = new Set(setup.channels.map((c) => c.id));

  return (
    <SettingsCard
      title="Emoji and sticker proposals"
      description="Members put emojis and stickers up for a vote."
      dirty={differs(draft, saved)}
      busy={busy}
      problems={[
        ...problemsUnder(problems, "/emoji").filter((p) => !shownProblem(p, "/emoji")),
        ...problemsUnder(problems, "/sticker").filter((p) => !shownProblem(p, "/sticker")),
      ]}
      onSave={() => {
        if (invalid) return;
        save({
          pollsChannelId: draft.pollsChannelId ?? null,
          emoji: draft.emoji ?? null,
          sticker: draft.sticker ?? null,
        });
      }}
      onReset={() => setDraft(saved)}
    >
      <Field data-invalid={channelProblem ? true : undefined} className="sm:max-w-sm">
        <FieldLabel htmlFor={`${id}-channel`}>Polls channel</FieldLabel>
        <Select
          value={draft.pollsChannelId ?? NO_CHANNEL}
          onValueChange={(value) =>
            setDraft((d) => ({ ...d, pollsChannelId: value === NO_CHANNEL ? undefined : value }))
          }
        >
          <SelectTrigger id={`${id}-channel`} className="w-full" aria-invalid={channelProblem ? true : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CHANNEL}>None</SelectItem>
            {draft.pollsChannelId && !known.has(draft.pollsChannelId) && (
              <SelectItem value={draft.pollsChannelId}>A channel the bot can't see</SelectItem>
            )}
            {setup.channels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                #{c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Where proposals are voted on.</FieldDescription>
        <FieldError>{channelProblem}</FieldError>
      </Field>

      <ProposalFields
        legend="Emoji proposals"
        label="Members can propose emoji"
        path="/emoji"
        value={draft.emoji}
        problems={problems}
        onChange={(emoji) => setDraft((d) => ({ ...d, emoji }))}
      />
      <ProposalFields
        legend="Sticker proposals"
        label="Members can propose stickers"
        path="/sticker"
        value={draft.sticker}
        problems={problems}
        onChange={(sticker) => setDraft((d) => ({ ...d, sticker }))}
      />
    </SettingsCard>
  );
}

/** The fields shown for a proposal kind, so their problems aren't listed twice. */
const PROPOSAL_FIELDS = ["votingHours", "maxOpenPerUser", "maxImageBytes", "threshold"];

function shownProblem(problem: string, path: string): boolean {
  return PROPOSAL_FIELDS.some((key) => problem.startsWith(`${path}/${key}: `));
}

/** What's wrong with a proposal kind's numbers, before the bot sees them. */
function proposalProblems(p: Proposal): string[] {
  return [
    !(p.votingHours > 0) && "votingHours",
    !(Number.isInteger(p.maxOpenPerUser) && p.maxOpenPerUser >= 1) && "maxOpenPerUser",
    !(Number.isInteger(p.maxImageBytes) && p.maxImageBytes >= 1024) && "maxImageBytes",
    !(p.threshold > 0 && p.threshold <= 1) && "threshold",
  ].filter((key): key is string => key !== false);
}

function ProposalFields({
  legend,
  label,
  path,
  value,
  problems,
  onChange,
}: {
  legend: string;
  label: string;
  path: string;
  value: Proposal | undefined;
  problems: Problems;
  onChange: (value: Proposal | undefined) => void;
}) {
  const id = useId();
  const local = value ? proposalProblems(value) : [];
  const problem = (key: string, message: string) =>
    local.includes(key) ? message : problemAt(problems, `${path}/${key}`);
  const set = (change: Partial<Proposal>) => value && onChange({ ...value, ...change });

  return (
    // The border goes on a wrapper: a fieldset draws its legend into its own top border.
    // The legend also sits outside the fieldset's flex layout, so it takes a margin for
    // the gap a card leaves under its title.
    <div className="border-t pt-5">
      <FieldSet className="gap-4">
        <FieldLegend className="mb-4">{legend}</FieldLegend>
        <Field orientation="horizontal">
          <Switch
            id={`${id}-on`}
            checked={value !== undefined}
            onCheckedChange={(on) => onChange(on ? PROPOSAL_DEFAULTS : undefined)}
          />
          <FieldLabel htmlFor={`${id}-on`}>{label}</FieldLabel>
        </Field>
        {value && (
          <FieldGroup className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            <NumberField
              id={`${id}-hours`}
              label="Voting time, in hours"
              value={value.votingHours}
              min={1}
              onChange={(votingHours) => set({ votingHours })}
              problem={problem("votingHours", "More than 0 hours.")}
            />
            <NumberField
              id={`${id}-open`}
              label="Open proposals per member"
              value={value.maxOpenPerUser}
              min={1}
              onChange={(maxOpenPerUser) => set({ maxOpenPerUser })}
              problem={problem("maxOpenPerUser", "A whole number, 1 or more.")}
            />
            <NumberField
              id={`${id}-size`}
              label="Largest upload, in KiB"
              hint="The instance's limit, 512 KiB by default."
              value={value.maxImageBytes / 1024}
              min={1}
              onChange={(kib) => set({ maxImageBytes: Math.round(kib * 1024) })}
              problem={problem("maxImageBytes", "1 KiB or more.")}
            />
            <NumberField
              id={`${id}-threshold`}
              label="Votes needed, in percent"
              hint="Of members who can see the polls channel. It also needs more ✅ than ❌."
              value={Math.round(value.threshold * 1000) / 10}
              min={1}
              max={100}
              onChange={(percent) => set({ threshold: percent / 100 })}
              problem={problem("threshold", "More than 0 and at most 100 percent.")}
            />
          </FieldGroup>
        )}
      </FieldSet>
    </div>
  );
}

function PollsCard({ settings }: SectionProps) {
  const { save, busy, problems } = useSave("polls");
  const [draft, setDraft] = useState(settings.polls);
  const id = useId();

  const hoursBad = draft !== undefined && !(draft.defaultHours > 0 && draft.defaultHours <= 672);
  const openBad = draft !== undefined && !(Number.isInteger(draft.maxOpenPerUser) && draft.maxOpenPerUser >= 1);
  const set = (change: Partial<Polls>) => setDraft((d) => d && { ...d, ...change });

  return (
    <SettingsCard
      title="Polls"
      dirty={differs(draft, settings.polls)}
      busy={busy}
      problems={problemsUnder(problems, "/polls").filter(
        (p) => !p.startsWith("/polls/defaultHours: ") && !p.startsWith("/polls/maxOpenPerUser: "),
      )}
      onSave={() => {
        if (!hoursBad && !openBad) save({ polls: draft ?? null });
      }}
      onReset={() => setDraft(settings.polls)}
    >
      <Field orientation="horizontal">
        <Switch
          id={`${id}-on`}
          checked={draft !== undefined}
          onCheckedChange={(on) => setDraft(on ? POLLS_DEFAULTS : undefined)}
        />
        <FieldLabel htmlFor={`${id}-on`}>Members can start polls</FieldLabel>
      </Field>
      {draft && (
        <FieldGroup className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <NumberField
            id={`${id}-hours`}
            label="Default length, in hours"
            hint="For polls started without one. 672 at most."
            value={draft.defaultHours}
            min={1}
            max={672}
            onChange={(defaultHours) => set({ defaultHours })}
            problem={hoursBad ? "More than 0 and at most 672 hours." : problemAt(problems, "/polls/defaultHours")}
          />
          <NumberField
            id={`${id}-open`}
            label="Open polls per member"
            value={draft.maxOpenPerUser}
            min={1}
            onChange={(maxOpenPerUser) => set({ maxOpenPerUser })}
            problem={openBad ? "A whole number, 1 or more." : problemAt(problems, "/polls/maxOpenPerUser")}
          />
        </FieldGroup>
      )}
    </SettingsCard>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
  problem,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  problem: string | undefined;
}) {
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        value={numberValue(value)}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint ${id}-problem`}
        className="sm:max-w-40"
      />
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      <FieldError id={`${id}-problem`}>{problem}</FieldError>
    </Field>
  );
}
