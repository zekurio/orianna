import { useAtomValue } from "@effect/atom-react";
import { CheckSquare, ClockCounterClockwise, GearSix, type Icon, Key, ListChecks } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { FormCardSkeleton, Placeholder } from "@/components/loading";
import { PageHeader } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { guildPath, useGuild } from "../guild.tsx";
import { navigate } from "../router.tsx";
import { GeneralSection } from "./General.tsx";
import { HistorySection } from "./History.tsx";
import { PermissionsSection } from "./Permissions.tsx";
import { ProposalsSection } from "./Proposals.tsx";
import { RoleMenusSection } from "./RoleMenus.tsx";
import { type SectionProps, type Settings, setupQuery } from "./shared.tsx";

// The Admin tab: the settings of the whole server, for the guild owner and
// members with Administrator, the same ones `!settings` exports and imports.
// The starboard's are on its own page.

type Tab = "general" | "permissions" | "proposals" | "role-menus" | "history";

const TABS: { tab: Tab; label: string; icon: Icon }[] = [
  { tab: "general", label: "General", icon: GearSix },
  { tab: "permissions", label: "Permissions", icon: Key },
  { tab: "proposals", label: "Proposals & polls", icon: CheckSquare },
  { tab: "role-menus", label: "Role menus", icon: ListChecks },
  { tab: "history", label: "History", icon: ClockCounterClockwise },
];

const pathOf = (tab: Tab) => (tab === "general" ? "/admin" : `/admin/${tab}`);

/** `/admin`, or `/admin/<tab>`. */
export function parseAdminPath(path: string): Tab | undefined {
  const match = /^\/admin(?:\/([a-z-]+))?\/?$/.exec(path);
  if (!match) return undefined;
  const tab = (match[1] ?? "general") as Tab;
  return TABS.some((t) => t.tab === tab) ? tab : undefined;
}

export function AdminPage({ tab }: { tab: Tab }) {
  const guild = useGuild();
  const { admin, prefix } = guild;
  if (!admin) {
    return (
      <PageHeader
        title="Admin"
        lead="Only the server owner and members with Administrator can change the bot settings."
      />
    );
  }
  return (
    <>
      <PageHeader
        title="Admin"
        lead={
          <>
            What the bot does in {guild.name}. Changes apply right away and show up in{" "}
            <code>{prefix}settings log</code>.
          </>
        }
      />
      <Tabs value={tab} onValueChange={(next) => navigate(guildPath(guild.id, pathOf(next as Tab)))} className="gap-6">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {TABS.map(({ tab: t, label, icon: TabIcon }) => (
            <TabsTrigger key={t} value={t}>
              <TabIcon />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab}>
          <Loaded>{(props) => <Section tab={tab} {...props} />}</Loaded>
        </TabsContent>
      </Tabs>
    </>
  );
}

/** The settings and what they can name, once they're in. */
function Loaded({ children }: { children: (props: SectionProps) => ReactNode }) {
  const setup = useAtomValue(setupQuery(useGuild().id));
  return AsyncResult.matchWithError(setup, {
    onInitial: () => (
      <Placeholder label="Loading the settings" className="flex flex-col gap-6">
        <FormCardSkeleton fields={2} />
        <FormCardSkeleton fields={4} />
      </Placeholder>
    ),
    onError: (error) => <Problem message={error._tag === "Refused" ? error.message : undefined} />,
    onDefect: () => <Problem />,
    onSuccess: ({ value }) => children({ setup: value, settings: value.settings as Settings }),
  });
}

/**
 * The tab's section. Each starts over from the saved settings when they
 * change, so a save, or a change from chat, shows up in the form.
 */
function Section({ tab, setup, settings }: { tab: Tab } & SectionProps) {
  const props = { setup, settings };
  switch (tab) {
    case "general":
      return <GeneralSection key={JSON.stringify(settings.prefix)} {...props} />;
    case "permissions":
      return <PermissionsSection key={JSON.stringify(settings.permissions)} {...props} />;
    case "proposals":
      return (
        <ProposalsSection
          key={JSON.stringify([settings.pollsChannelId, settings.emoji, settings.sticker, settings.polls])}
          {...props}
        />
      );
    case "role-menus":
      return <RoleMenusSection key={JSON.stringify(settings.roleMenus)} {...props} />;
    case "history":
      return <HistorySection {...props} />;
  }
}
