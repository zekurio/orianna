import { useAtomValue } from "@effect/atom-react";
import { MagnifyingGlass, ShieldStar } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { useDeferredValue, useMemo, useState } from "react";
import { ListCardSkeleton, Placeholder, TextSkeleton } from "@/components/loading";
import { PageHeader, SectionTitle } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { CommandInfo, CommandSection } from "../rpc.ts";
import { Api } from "./api.ts";
import { useSession } from "./App.tsx";
import { useGuild } from "./guild.tsx";

// The commands page: what `!help` lists for the member, with every option
// explained, and a search across all of it.

export function CommandsPage() {
  const { id: guildId } = useGuild();
  const commands = useAtomValue(Api.query("commands", { guildId }));
  const [query, setQuery] = useState("");
  return (
    <>
      <PageHeader title="Commands" lead="The ones you can run here." />
      <InputGroup className="h-10 sm:max-w-md">
        <InputGroupAddon>
          <MagnifyingGlass />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a command"
          aria-label="Find a command"
          autoFocus
        />
      </InputGroup>
      {AsyncResult.matchWithError(commands, {
        onInitial: () => (
          <Placeholder label="Loading the commands" className="flex flex-col gap-8">
            {[4, 3].map((rows, i) => (
              <div key={i} className="flex flex-col gap-3">
                <TextSkeleton className="h-7 w-36" />
                <ListCardSkeleton title={false} rows={rows} />
              </div>
            ))}
          </Placeholder>
        ),
        onError: () => <Problem />,
        onDefect: () => <Problem />,
        onSuccess: ({ value }) => <CommandList sections={value} query={query} />,
      })}
    </>
  );
}

function CommandList({ sections, query }: { sections: readonly CommandSection[]; query: string }) {
  const { prefix } = useGuild();
  // Typing stays quick however long the list is.
  const deferred = useDeferredValue(query);
  const shown = useMemo(() => {
    const terms = termsOf(deferred, prefix);
    return sections
      .map((section) => ({ ...section, commands: section.commands.filter((c) => matches(c, terms)) }))
      .filter((section) => section.commands.length > 0);
  }, [sections, deferred, prefix]);

  if (shown.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MagnifyingGlass />
          </EmptyMedia>
          <EmptyTitle>No command matches</EmptyTitle>
          <EmptyDescription>
            Nothing matches <q>{deferred.trim()}</q>.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {shown.map((section) => (
        <section key={section.group ?? ""} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <SectionTitle>{section.group === null ? "General" : `${prefix}${section.group}`}</SectionTitle>
            {section.description && <p className="text-muted-foreground">{section.description}</p>}
          </div>
          <Card className="gap-0 py-0">
            <ul className="divide-y">
              {section.commands.map((command) => (
                <CommandRow key={command.name} command={command} />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

function CommandRow({ command }: { command: CommandInfo }) {
  const { prefix } = useGuild();
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <code className="wrap-anywhere">
          <span className="font-semibold text-foreground">
            {prefix}
            {command.name}
          </span>
          {command.usage && <span className="text-muted-foreground"> {command.usage}</span>}
        </code>
        {command.adminOnly ? (
          <Badge variant="secondary" title="Only the server owner and members with Administrator may run it.">
            <ShieldStar />
            Admins
          </Badge>
        ) : (
          command.permission && (
            <Badge variant="outline" className="font-mono" title="The permission it takes, which you have.">
              {command.permission}
            </Badge>
          )
        )}
      </div>
      <p>{command.description}</p>
      {command.options.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          {command.options.map((option) => (
            <div key={option.name} className="contents">
              <dt>
                <code>{option.usage}</code>
              </dt>
              <dd className="text-muted-foreground">{option.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** The words of the search, in lowercase, without the prefix someone typed out of habit. */
function termsOf(query: string, prefix: string): string[] {
  const trimmed = query.trim().toLowerCase();
  const bare = trimmed.startsWith(prefix.toLowerCase()) ? trimmed.slice(prefix.length) : trimmed;
  return bare.split(/\s+/).filter(Boolean);
}

/** Every word is somewhere in the command: its name, what it does, its options or its permission. */
function matches(command: CommandInfo, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = [
    command.name,
    command.description,
    command.permission ?? "",
    ...command.options.flatMap((o) => [o.name, o.description]),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}
