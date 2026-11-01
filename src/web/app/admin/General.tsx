import { TrashIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGuild } from "../guild.tsx";
import { differs, problemAt, problemsUnder, type SectionProps, SettingsCard, useSave } from "./shared.tsx";

// Which server these settings are for, its prefix, and where it takes commands.

export function GeneralSection(props: SectionProps) {
  const guild = useGuild();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-14 rounded-xl after:rounded-xl">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" className="rounded-xl" />}
            <AvatarFallback className="rounded-xl">{guild.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <strong className="font-heading text-xl leading-tight">{guild.name}</strong>
        </CardContent>
      </Card>
      <PrefixCard {...props} />
      <CommandChannelsCard {...props} />
    </div>
  );
}

function PrefixCard({ settings }: SectionProps) {
  const { save, busy, problems } = useSave("the prefix");
  const [prefix, setPrefix] = useState(settings.prefix);
  const id = useId();
  const problem = prefix.trim() === "" ? "The prefix can't be empty." : problemAt(problems, "/prefix");

  return (
    <SettingsCard
      title="Prefix"
      dirty={differs(prefix, settings.prefix)}
      busy={busy}
      problems={problemsUnder(problems, "/prefix").filter((p) => !p.startsWith("/prefix: "))}
      onSave={() => {
        if (prefix.trim() !== "") save({ prefix: prefix.trim() });
      }}
      onReset={() => setPrefix(settings.prefix)}
    >
      <Field data-invalid={problem ? true : undefined} className="sm:max-w-xs">
        <FieldLabel htmlFor={id}>Prefix</FieldLabel>
        <Input
          id={id}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint ${id}-problem`}
        />
        <FieldDescription id={`${id}-hint`}>
          What commands start with, like <code>{prefix.trim() || "!"}help</code>.
        </FieldDescription>
        <FieldError id={`${id}-problem`}>{problem}</FieldError>
      </Field>
    </SettingsCard>
  );
}

const CHANNELS = "/commandChannels";

/** The channels the bot takes commands in; with none, it takes them everywhere. */
function CommandChannelsCard({ setup, settings }: SectionProps) {
  const { save, busy, problems } = useSave("the command channels");
  const [draft, setDraft] = useState(settings.commandChannels);
  const id = useId();
  const names = new Map(setup.channels.map((c) => [c.id, c.name]));
  const addable = setup.channels.filter((c) => !draft.includes(c.id));

  return (
    <SettingsCard
      title="Command channels"
      description="The bot only takes commands in these channels and their threads."
      dirty={differs(draft, settings.commandChannels)}
      busy={busy}
      problems={problemsUnder(problems, CHANNELS).filter((p) => !/^\/commandChannels\/\d+: /.test(p))}
      onSave={() => save({ commandChannels: draft })}
      onReset={() => setDraft(settings.commandChannels)}
    >
      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground">None, so it takes them in every channel.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {draft.map((channelId, i) => {
            const name = names.get(channelId);
            const problem = problemAt(problems, `${CHANNELS}/${i}`);
            return (
              <li key={channelId} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">
                    {name === undefined ? (
                      <>
                        Unknown channel <span className="text-xs text-muted-foreground tabular-nums">{channelId}</span>
                      </>
                    ) : (
                      `#${name}`
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    aria-label={`Remove ${name === undefined ? "the channel" : `#${name}`}`}
                    onClick={() => setDraft(draft.filter((_, j) => j !== i))}
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
      <Field className="sm:max-w-sm">
        <FieldLabel htmlFor={id} className="sr-only">
          Channel to add
        </FieldLabel>
        {/* Always empty, so picking a channel adds it and the placeholder comes back. */}
        <Select value="" onValueChange={(channelId) => setDraft([...draft, channelId])} disabled={addable.length === 0}>
          <SelectTrigger id={id} className="w-full">
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
      </Field>
    </SettingsCard>
  );
}
