import { useId, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useGuild } from "../guild.tsx";
import { differs, problemAt, problemsUnder, type SectionProps, SettingsCard, useSave } from "./shared.tsx";

// Which server these settings are for, and its prefix.

export function GeneralSection({ settings }: SectionProps) {
  const guild = useGuild();
  const { save, busy, problems } = useSave("the prefix");
  const [prefix, setPrefix] = useState(settings.prefix);
  const id = useId();
  const problem = prefix.trim() === "" ? "The prefix can't be empty." : problemAt(problems, "/prefix");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-14 rounded-xl after:rounded-xl">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" className="rounded-xl" />}
            <AvatarFallback className="rounded-xl">{guild.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <div className="grid gap-0.5">
            <strong className="font-heading text-xl leading-tight">{guild.name}</strong>
            <span className="text-sm text-muted-foreground">
              These settings are this server's own. Switch servers in the header.
            </span>
          </div>
        </CardContent>
      </Card>

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
    </div>
  );
}
