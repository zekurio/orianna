import { useAtomValue } from "@effect/atom-react";
import { MagnifyingGlass, ShieldStar } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { useDeferredValue, useMemo, useState } from "react";
import { ListCardSkeleton, Placeholder, TextSkeleton } from "@/components/loading";
import { PageHeader, SectionTitle, WithSidebar } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { CommandInfo, CommandSection } from "../rpc.ts";
import { Api } from "./api.ts";
import { useGuild } from "./guild.tsx";
import { MessageText } from "./MessageText.tsx";

// The commands page: what `!help` lists for the member, with every option
// explained as `!help <command>` does, and a search across all of it.

/** Descriptions mention no one; they only need the inline code rendered. */
const NO_NAMES = { users: {}, channels: {}, emojis: {} };

const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

export function CommandsPage() {
  const { id: guildId } = useGuild();
  const commands = useAtomValue(Api.query("commands", { guildId }));
  const [query, setQuery] = useState("");
  const failed = (
    <>
      <PageHeader title="Commands" />
      <Problem />
    </>
  );
  return AsyncResult.matchWithError(commands, {
    onInitial: () => <CommandBrowser sections={undefined} query={query} onQuery={setQuery} />,
    onError: () => failed,
    onDefect: () => failed,
    onSuccess: ({ value }) => <CommandBrowser sections={value} query={query} onQuery={setQuery} />,
  });
}

/** The element a section's link jumps to. */
const sectionId = (title: string) => "commands-" + title.toLowerCase();

/**
 * The page, with the search and a link to each section along the window's
 * left edge on wide screens, and only the search above the list on narrow
 * ones. Without sections, they're still loading.
 */
function CommandBrowser({
  sections,
  query,
  onQuery,
}: {
  sections: readonly CommandSection[] | undefined;
  query: string;
  onQuery: (query: string) => void;
}) {
  const { prefix } = useGuild();
  // Typing stays quick however long the list is.
  const deferred = useDeferredValue(query);
  const shown = useMemo(() => {
    const terms = termsOf(deferred, prefix);
    return (sections ?? [])
      .map((section) => ({ ...section, commands: section.commands.filter((c) => matches(c, terms)) }))
      .filter((section) => section.commands.length > 0);
  }, [sections, deferred, prefix]);

  const sidebar = (
    <>
      <InputGroup className="sm:max-w-md lg:max-w-none">
        <InputGroupAddon>
          <MagnifyingGlass />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Find a command"
          aria-label="Find a command"
          // A phone would open its keyboard over the list.
          autoFocus={FINE_POINTER}
        />
      </InputGroup>
      {shown.length > 0 && (
        <nav aria-label="Sections" className="hidden flex-col gap-0.5 lg:flex">
          {shown.map((section) => (
            <a
              key={section.title}
              href={"#" + sectionId(section.title)}
              className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
            >
              {section.title}
              <span className="tabular-nums">{section.commands.length}</span>
            </a>
          ))}
        </nav>
      )}
    </>
  );

  return (
    <WithSidebar header={<PageHeader title="Commands" />} sidebar={sidebar}>
      {sections === undefined ? (
        <Placeholder label="Loading the commands" className="flex flex-col gap-8">
          {[4, 3].map((rows, i) => (
            <div key={i} className="flex flex-col gap-3">
              <TextSkeleton className="h-7 w-36" />
              <ListCardSkeleton title={false} rows={rows} />
            </div>
          ))}
        </Placeholder>
      ) : shown.length === 0 ? (
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
      ) : (
        <div className="flex flex-col gap-8">
          {shown.map((section) => (
            <section key={section.title} id={sectionId(section.title)} className="flex scroll-mt-8 flex-col gap-3">
              <SectionTitle>{section.title}</SectionTitle>
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
      )}
    </WithSidebar>
  );
}

function CommandRow({ command }: { command: CommandInfo }) {
  const { prefix } = useGuild();
  return (
    <li className="flex flex-col gap-3 px-3 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-mono text-sm wrap-anywhere">
            <span className="font-semibold">
              {prefix}
              {command.name}
            </span>
            {command.usage && <span className="text-muted-foreground"> {command.usage}</span>}
          </p>
          {command.adminOnly ? (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title="Only the server owner and members with Administrator may run it."
            >
              <ShieldStar className="size-3.5" />
              Admins
            </span>
          ) : (
            command.permission && (
              <span className="font-mono text-xs text-muted-foreground" title="The permission it takes, which you have.">
                {command.permission}
              </span>
            )
          )}
        </div>
        <MessageText text={command.description} names={NO_NAMES} />
        {command.details && (
          <div className="text-muted-foreground">
            <MessageText text={command.details} names={NO_NAMES} />
          </div>
        )}
      </div>
      {command.options.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
          {command.options.map((option) => (
            <div key={option.name} className="contents">
              <dt className="font-mono">{option.usage}</dt>
              <dd className="text-muted-foreground">
                <MessageText text={option.description} names={NO_NAMES} />
              </dd>
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
    command.details ?? "",
    command.permission ?? "",
    ...command.options.flatMap((o) => [o.name, o.description]),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}
