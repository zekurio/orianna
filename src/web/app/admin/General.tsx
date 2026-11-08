import { XIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { SettingRow, SettingsGroup } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { differs, problemAt, problemsUnder, type SectionProps, SettingsForm, useSave } from "./shared.tsx";

// How members give the bot commands: the prefix, and the channels it takes
// them in.

const CHANNELS = "/commandChannels";

export function GeneralSection({ setup, settings }: SectionProps) {
  const { save, busy, problems } = useSave("the general settings");
  const saved = { prefix: settings.prefix, commandChannels: settings.commandChannels };
  const [draft, setDraft] = useState(saved);
  const id = useId();
  const names = new Map(setup.channels.map((c) => [c.id, c.name]));
  const addable = setup.channels.filter((c) => !draft.commandChannels.includes(c.id));
  const prefixProblem = draft.prefix.trim() === "" ? "The prefix can't be empty." : problemAt(problems, "/prefix");
  const channelProblems = draft.commandChannels.flatMap((channelId, i) => {
    const problem = problemAt(problems, `${CHANNELS}/${i}`);
    return problem ? [`#${names.get(channelId) ?? channelId}: ${problem}`] : [];
  });

  return (
    <SettingsForm
      dirty={differs(draft, saved)}
      busy={busy}
      problems={[
        ...problemsUnder(problems, "/prefix").filter((p) => !p.startsWith("/prefix: ")),
        ...problemsUnder(problems, CHANNELS).filter((p) => !/^\/commandChannels\/\d+: /.test(p)),
      ]}
      onSave={() => {
        if (draft.prefix.trim() !== "") save({ ...draft, prefix: draft.prefix.trim() });
      }}
      onReset={() => setDraft(saved)}
    >
      <SettingsGroup title="Commands">
        <SettingRow
          id={`${id}-prefix`}
          title="Prefix"
          problem={prefixProblem}
          control={
            <Input
              id={`${id}-prefix`}
              value={draft.prefix}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={prefixProblem ? true : undefined}
              aria-describedby={`${id}-prefix-description`}
              className="w-32 font-mono"
            />
          }
        />
        <SettingRow
          id={`${id}-channels`}
          title="Command channels"
          wide
          description={draft.commandChannels.length === 0 ? "All channels" : undefined}
          problem={channelProblems.join("\n") || undefined}
          control={
            // Always empty, so picking a channel adds it and the placeholder comes back.
            <Select
              value=""
              onValueChange={(channelId) =>
                setDraft({ ...draft, commandChannels: [...draft.commandChannels, channelId] })
              }
              disabled={addable.length === 0}
            >
              <SelectTrigger id={`${id}-channels`} className="w-full sm:w-56">
                <SelectValue placeholder="Add a channel" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    #{c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {draft.commandChannels.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {draft.commandChannels.map((channelId, i) => {
                const name = names.get(channelId);
                const label = name === undefined ? `Unknown channel ${channelId}` : `#${name}`;
                return (
                  <li
                    key={channelId}
                    className="flex h-8 items-center gap-1 rounded-lg border bg-background pr-1 pl-2.5 text-sm"
                  >
                    {label}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        setDraft({ ...draft, commandChannels: draft.commandChannels.filter((_, j) => j !== i) })
                      }
                    >
                      <XIcon />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </SettingRow>
      </SettingsGroup>
    </SettingsForm>
  );
}
