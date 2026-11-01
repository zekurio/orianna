import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DownloadSimpleIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type ChangeEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Placeholder, TextSkeleton } from "@/components/loading";
import { Problem } from "@/components/Problem";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { SettingsChangeInfo } from "../../rpc.ts";
import { Api, failureMessage, KARMA_KEYS, STARBOARD_KEYS } from "../api.ts";
import { useGuild } from "../guild.tsx";
import { ADMIN_KEYS, type SectionProps } from "./shared.tsx";

// The settings as a file, like `!settings export` and `import`, and who
// changed them lately, like `!settings log`.

/** The settings file, as large as `!settings import` takes. */
const MAX_FILE_BYTES = 1024 * 1024;

export function HistorySection({ settings }: SectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsFile settings={settings} />
      <ChangeLog />
    </div>
  );
}

function SettingsFile({ settings }: Pick<SectionProps, "settings">) {
  const { id: guildId } = useGuild();
  const importSettings = useAtomSet(Api.mutation("importSettings"), { mode: "promiseExit" });
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ name: string; document: unknown }>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly string[]>([]);

  const exportFile = () => {
    const blob = new Blob([`${JSON.stringify(settings, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "settings.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return toast.error("That file is over 1 MiB.");
    try {
      setPending({ name: file.name, document: JSON.parse(await file.text()) });
    } catch (err) {
      toast.error(`${file.name} isn't valid JSON`, { description: (err as Error).message });
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const exit = await importSettings({
      payload: { guildId, document: pending.document },
      reactivityKeys: [...ADMIN_KEYS, "session", ...STARBOARD_KEYS, ...KARMA_KEYS],
    });
    setBusy(false);
    setPending(undefined);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as { _tag?: string; problems?: readonly string[] };
      if (failure._tag === "SettingsRejected" && failure.problems) {
        setProblems(failure.problems);
        toast.error("The settings weren't changed", { description: "See the problems below." });
      } else {
        toast.error(failureMessage(exit.cause));
      }
      return;
    }
    setProblems([]);
    const changed = exit.value;
    toast.success(changed.length > 0 ? "Imported the settings" : "Nothing changed", {
      description: changed.length > 0 ? `Changed ${changed.join(", ")}.` : undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings file</CardTitle>
        <CardDescription>All settings as JSON. Importing replaces them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportFile}>
            <DownloadSimpleIcon />
            Export
          </Button>
          <Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <Spinner /> : <UploadSimpleIcon />}
            Import…
          </Button>
          <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={pick} />
        </div>
        {problems.length > 0 && <Problem message={problems.join("\n")} />}
      </CardContent>
      <AlertDialog open={pending !== undefined} onOpenChange={(open) => !open && setPending(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace all bot settings?</AlertDialogTitle>
            <AlertDialogDescription>
              Features {pending?.name} leaves out are turned off. Nothing changes if the file has problems.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirm}>
              <UploadSimpleIcon />
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function ChangeLog() {
  const log = useAtomValue(Api.query("settingsLog", { guildId: useGuild().id }, { reactivityKeys: ADMIN_KEYS }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>The last 30 changes.</CardDescription>
      </CardHeader>
      <CardContent>
        {AsyncResult.matchWithError(log, {
          onInitial: () => (
            <Placeholder label="Loading the history" className="flex flex-col gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <TextSkeleton className="w-36" />
                  <TextSkeleton className={i % 2 ? "w-40" : "w-56"} />
                </div>
              ))}
            </Placeholder>
          ),
          onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
          onDefect: () => <Problem />,
          onSuccess: ({ value }) => (
            <ol className="divide-y">
              {value.map((change) => (
                <ChangeRow key={change.at} change={change} />
              ))}
            </ol>
          ),
        })}
      </CardContent>
    </Card>
  );
}

function ChangeRow({ change }: { change: SettingsChangeInfo }) {
  const who =
    change.source === "defaults" ? "Set to the defaults when the bot joined" : `${change.by?.name ?? "A member"} changed`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3 first:pt-0 last:pb-0">
      <time dateTime={new Date(change.at).toISOString()} className="w-40 shrink-0 text-sm text-muted-foreground">
        {dateFormat.format(change.at)}
      </time>
      <span>{who}</span>
      {change.source === "command" && (
        <span className="flex flex-wrap gap-1.5">
          {change.sections.map((section) => (
            <Badge key={section} variant="outline" className="font-mono">
              {section}
            </Badge>
          ))}
        </span>
      )}
    </li>
  );
}
