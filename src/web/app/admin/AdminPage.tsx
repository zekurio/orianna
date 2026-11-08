import { useAtomValue } from "@effect/atom-react";
import { CheckSquare, ClockCounterClockwise, GearSix, type Icon, Key, ListChecks } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useSyncExternalStore } from "react";
import { Placeholder, SettingsGroupSkeleton } from "@/components/loading";
import { PageHeader, WithSidebar } from "@/components/page";
import { Problem } from "@/components/Problem";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
// Karma's are on its own page.

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
  const wide = useWide();
  if (!guild.admin) return <PageHeader title="Admin" lead="Only the server owner and administrators can see this." />;
  const open = (next: string) => navigate(guildPath(guild.id, pathOf(next as Tab)));
  return (
    // The tabs run down the window's left edge on wide screens, like the
    // commands page's section links. Narrower ones have no room for them
    // all, and pick one from a menu beside the title instead.
    <Tabs value={tab} onValueChange={open} orientation="vertical" className="flex-1 flex-col gap-0">
      <WithSidebar
        header={
          <PageHeader
            title="Admin"
            actions={
              !wide && (
                <Select value={tab} onValueChange={open}>
                  <SelectTrigger aria-label="Settings">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" className="min-w-48">
                    {TABS.map(({ tab: t, label, icon: TabIcon }) => (
                      <SelectItem key={t} value={t}>
                        <TabIcon />
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          />
        }
        sidebar={
          wide && (
            <TabsList className="w-full items-stretch gap-0.5 bg-transparent p-0">
              {TABS.map(({ tab: t, label, icon: TabIcon }) => (
                <TabsTrigger
                  key={t}
                  value={t}
                  className="h-9 flex-none justify-start px-2.5 text-base data-active:bg-muted"
                >
                  <TabIcon />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          )
        }
      >
        <TabsContent value={tab} className="flex flex-col">
          <Loaded>{(props) => <Section tab={tab} {...props} />}</Loaded>
        </TabsContent>
      </WithSidebar>
    </Tabs>
  );
}

const WIDE = window.matchMedia("(width >= 64rem)");

/** Whether the window is wide enough for the tabs to run down its left edge, as WithSidebar's column does. */
function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      WIDE.addEventListener("change", onChange);
      return () => WIDE.removeEventListener("change", onChange);
    },
    () => WIDE.matches,
  );
}

/** The settings and what they can name, once they're in. */
function Loaded({ children }: { children: (props: SectionProps) => ReactNode }) {
  const setup = useAtomValue(setupQuery(useGuild().id));
  return AsyncResult.matchWithError(setup, {
    onInitial: () => (
      <Placeholder label="Loading the settings" className="flex flex-col gap-8">
        <SettingsGroupSkeleton rows={2} />
        <SettingsGroupSkeleton rows={4} />
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
      return <GeneralSection key={JSON.stringify([settings.prefix, settings.commandChannels])} {...props} />;
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
