import { type ChangeEvent, useId, useState } from "react";
import { SettingRow, SettingsGroup } from "@/components/settings";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
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
  SettingsForm,
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

/** The fields shown for a proposal kind and for polls, so their problems aren't listed twice. */
const PROPOSAL_FIELDS = ["votingHours", "maxOpenPerUser", "maxImageBytes", "threshold"];
const POLLS_FIELDS = ["defaultHours", "maxOpenPerUser"];

const unshown = (problems: Problems, path: string, fields: readonly string[]) =>
  problemsUnder(problems, path).filter((p) => !fields.some((key) => p.startsWith(`${path}/${key}: `)));

export function ProposalsSection({ setup, settings }: SectionProps) {
  const { save, busy, problems } = useSave("proposals and polls");
  const saved = {
    pollsChannelId: settings.pollsChannelId,
    emoji: settings.emoji,
    sticker: settings.sticker,
    polls: settings.polls,
  };
  const [draft, setDraft] = useState(saved);
  const id = useId();

  const needsChannel = (draft.emoji || draft.sticker) && !draft.pollsChannelId;
  const channelProblem = needsChannel ? "Proposals need a channel to vote in." : problemAt(problems, "/pollsChannelId");
  const invalid =
    needsChannel ||
    [draft.emoji, draft.sticker].some((p) => p && proposalProblems(p).length > 0) ||
    (draft.polls !== undefined && pollsProblems(draft.polls).length > 0);
  const known = new Set(setup.channels.map((c) => c.id));

  return (
    <SettingsForm
      dirty={differs(draft, saved)}
      busy={busy}
      problems={[
        ...unshown(problems, "/emoji", PROPOSAL_FIELDS),
        ...unshown(problems, "/sticker", PROPOSAL_FIELDS),
        ...unshown(problems, "/polls", POLLS_FIELDS),
      ]}
      onSave={() => {
        if (invalid) return;
        save({
          pollsChannelId: draft.pollsChannelId ?? null,
          emoji: draft.emoji ?? null,
          sticker: draft.sticker ?? null,
          polls: draft.polls ?? null,
        });
      }}
      onReset={() => setDraft(saved)}
    >
      <SettingsGroup title="Voting">
        <SettingRow
          id={`${id}-channel`}
          title="Polls channel"
          wide
          problem={channelProblem}
          control={
            <Select
              value={draft.pollsChannelId ?? NO_CHANNEL}
              onValueChange={(value) =>
                setDraft((d) => ({ ...d, pollsChannelId: value === NO_CHANNEL ? undefined : value }))
              }
            >
              <SelectTrigger
                id={`${id}-channel`}
                className="w-full sm:w-56"
                aria-invalid={channelProblem ? true : undefined}
              >
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
          }
        />
      </SettingsGroup>

      <ProposalGroup
        title="Emoji proposals"
        label="Members can propose emoji"
        path="/emoji"
        value={draft.emoji}
        problems={problems}
        onChange={(emoji) => setDraft((d) => ({ ...d, emoji }))}
      />
      <ProposalGroup
        title="Sticker proposals"
        label="Members can propose stickers"
        path="/sticker"
        value={draft.sticker}
        problems={problems}
        onChange={(sticker) => setDraft((d) => ({ ...d, sticker }))}
      />
      <PollsGroup value={draft.polls} problems={problems} onChange={(polls) => setDraft((d) => ({ ...d, polls }))} />
    </SettingsForm>
  );
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

function pollsProblems(p: Polls): string[] {
  return [
    !(p.defaultHours > 0 && p.defaultHours <= 672) && "defaultHours",
    !(Number.isInteger(p.maxOpenPerUser) && p.maxOpenPerUser >= 1) && "maxOpenPerUser",
  ].filter((key): key is string => key !== false);
}

function ProposalGroup({
  title,
  label,
  path,
  value,
  problems,
  onChange,
}: {
  title: string;
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
    <SettingsGroup title={title}>
      <SettingRow
        id={`${id}-on`}
        title={label}
        control={
          <Switch
            id={`${id}-on`}
            checked={value !== undefined}
            onCheckedChange={(on) => onChange(on ? PROPOSAL_DEFAULTS : undefined)}
          />
        }
      />
      {value && (
        <>
          <NumberRow
            id={`${id}-hours`}
            title="Voting time"
            unit="hours"
            value={value.votingHours}
            min={1}
            onChange={(votingHours) => set({ votingHours })}
            problem={problem("votingHours", "More than 0 hours.")}
          />
          <NumberRow
            id={`${id}-open`}
            title="Open proposals per member"
            value={value.maxOpenPerUser}
            min={1}
            onChange={(maxOpenPerUser) => set({ maxOpenPerUser })}
            problem={problem("maxOpenPerUser", "A whole number, 1 or more.")}
          />
          <NumberRow
            id={`${id}-size`}
            title="Largest upload"
            description="The instance's limit, 512 KiB by default."
            unit="KiB"
            value={value.maxImageBytes / 1024}
            min={1}
            onChange={(kib) => set({ maxImageBytes: Math.round(kib * 1024) })}
            problem={problem("maxImageBytes", "1 KiB or more.")}
          />
          <NumberRow
            id={`${id}-threshold`}
            title="Votes needed"
            description="Of members who can see the polls channel. It also needs more ✅ than ❌."
            unit="%"
            value={Math.round(value.threshold * 1000) / 10}
            min={1}
            max={100}
            onChange={(percent) => set({ threshold: percent / 100 })}
            problem={problem("threshold", "More than 0 and at most 100 percent.")}
          />
        </>
      )}
    </SettingsGroup>
  );
}

function PollsGroup({
  value,
  problems,
  onChange,
}: {
  value: Polls | undefined;
  problems: Problems;
  onChange: (value: Polls | undefined) => void;
}) {
  const id = useId();
  const local = value ? pollsProblems(value) : [];
  const problem = (key: string, message: string) =>
    local.includes(key) ? message : problemAt(problems, `/polls/${key}`);
  const set = (change: Partial<Polls>) => value && onChange({ ...value, ...change });

  return (
    <SettingsGroup title="Polls">
      <SettingRow
        id={`${id}-on`}
        title="Members can start polls"
        control={
          <Switch
            id={`${id}-on`}
            checked={value !== undefined}
            onCheckedChange={(on) => onChange(on ? POLLS_DEFAULTS : undefined)}
          />
        }
      />
      {value && (
        <>
          <NumberRow
            id={`${id}-hours`}
            title="Default length"
            description="For polls started without one. 672 at most."
            unit="hours"
            value={value.defaultHours}
            min={1}
            max={672}
            onChange={(defaultHours) => set({ defaultHours })}
            problem={problem("defaultHours", "More than 0 and at most 672 hours.")}
          />
          <NumberRow
            id={`${id}-open`}
            title="Open polls per member"
            value={value.maxOpenPerUser}
            min={1}
            onChange={(maxOpenPerUser) => set({ maxOpenPerUser })}
            problem={problem("maxOpenPerUser", "A whole number, 1 or more.")}
          />
        </>
      )}
    </SettingsGroup>
  );
}

function NumberRow({
  id,
  title,
  description,
  unit,
  value,
  min,
  max,
  onChange,
  problem,
}: {
  id: string;
  title: string;
  description?: string;
  unit?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  problem: string | undefined;
}) {
  const props = {
    id,
    type: "number",
    inputMode: "decimal",
    min,
    max,
    value: numberValue(value),
    onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.valueAsNumber),
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": `${id}-description`,
    // Without the spinner buttons, which crowd the number in a field this narrow.
    className: "text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
  } as const;
  return (
    <SettingRow
      id={id}
      title={title}
      description={description}
      problem={problem}
      control={
        unit ? (
          <InputGroup className="w-32">
            <InputGroupInput {...props} />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{unit}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <Input {...props} className={`w-32 ${props.className}`} />
        )
      }
    />
  );
}
