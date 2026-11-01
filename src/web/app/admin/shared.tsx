import { useAtomSet } from "@effect/atom-react";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Problem } from "@/components/Problem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { BotSettings } from "../../../config.ts";
import type { AdminSetup } from "../../rpc.ts";
import { Api, failureMessage, KARMA_KEYS, STARBOARD_KEYS } from "../api.ts";
import { useGuild } from "../guild.tsx";

// What the Admin tab's sections share. Each section edits a few top-level
// keys of the bot settings and saves just those; the bot checks the whole
// settings on every save, like `!settings import`, and its problems come
// back with their paths, like `/polls/defaultHours: …`, to show by the field.

export type Settings = BotSettings;

/** What every section gets: the settings and what they can name. */
export interface SectionProps {
  setup: AdminSetup;
  settings: Settings;
}

/** Everything the Admin tab shows, refreshed after each save. */
export const ADMIN_KEYS = ["admin"];

export const setupQuery = (guildId: string) => Api.query("adminSetup", { guildId }, { reactivityKeys: ADMIN_KEYS });

/** Saving can change the prefix in the session, and the starboard or karma if their sections changed. */
const SAVE_KEYS = [...ADMIN_KEYS, "session", ...STARBOARD_KEYS, ...KARMA_KEYS];

/** The bot's problems with the last save, by path. */
export type Problems = readonly string[];

/** The problem at exactly `path`, like `/polls/defaultHours`, without the path. */
export function problemAt(problems: Problems, path: string): string | undefined {
  const found = problems.find((p) => p.startsWith(`${path}: `));
  return found?.slice(path.length + 2);
}

/** The problems at `path` or below it, with their paths. */
export function problemsUnder(problems: Problems, path: string): string[] {
  return problems.filter((p) => p.startsWith(`${path}: `) || p.startsWith(`${path}/`));
}

/**
 * Saves sections of the settings; a section set to null is removed. Says how
 * it went in a toast, and keeps the bot's problems for the form to show.
 */
export function useSave(label: string) {
  const { id: guildId } = useGuild();
  const save = useAtomSet(Api.mutation("saveSettings"), { mode: "promiseExit" });
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Problems>([]);

  const run = async (sections: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    const exit = await save({ payload: { guildId, sections }, reactivityKeys: SAVE_KEYS });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as { _tag?: string; problems?: readonly string[] };
      if (failure._tag === "SettingsRejected" && failure.problems) {
        setProblems(failure.problems);
        toast.error(`Couldn't save ${label}`, { description: "The bot didn't take it. What's wrong is marked." });
      } else {
        toast.error(failureMessage(exit.cause));
      }
      return false;
    }
    setProblems([]);
    toast.success(exit.value.length > 0 ? `Saved ${label}` : `Nothing about ${label} changed`);
    return true;
  };

  return { save: run, busy, problems };
}

/**
 * A section of the Admin tab: a card with a form, and Save and Reset for
 * what changed. `problems` are the ones no field shows.
 */
export function SettingsCard({
  title,
  description,
  dirty,
  busy,
  problems = [],
  onSave,
  onReset,
  children,
}: {
  title: string;
  description?: ReactNode;
  dirty: boolean;
  busy: boolean;
  problems?: readonly string[];
  onSave: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty && !busy) onSave();
  };
  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {children}
          {problems.length > 0 && <Problem message={problems.join("\n")} />}
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t">
          {dirty && (
            <Button type="button" variant="ghost" onClick={onReset} disabled={busy}>
              <ArrowCounterClockwiseIcon />
              Reset
            </Button>
          )}
          <Button type="submit" disabled={!dirty || busy}>
            {busy ? <Spinner /> : <FloppyDiskIcon />}
            {busy ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

/** Whether the draft differs from what's saved. A key set to undefined counts as missing. */
export function differs(draft: unknown, saved: unknown): boolean {
  return !same(draft, saved);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const leftKeys = keys(left);
  return leftKeys.length === keys(right).length && leftKeys.every((k) => same(left[k], right[k]));
}

/** A number input's value, or NaN while it's empty. */
export function numberValue(value: number): number | "" {
  return Number.isNaN(value) ? "" : value;
}
