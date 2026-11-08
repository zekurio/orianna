// The Admin tab's paths, for the app to route by before AdminPage.tsx, which
// it loads only when an admin opens the tab.

export const TABS = ["general", "permissions", "proposals", "role-menus", "history"] as const;

export type Tab = (typeof TABS)[number];

export const pathOf = (tab: Tab) => (tab === "general" ? "/admin" : `/admin/${tab}`);

/** `/admin`, or `/admin/<tab>`. */
export function parseAdminPath(path: string): Tab | undefined {
  const match = /^\/admin(?:\/([a-z-]+))?\/?$/.exec(path);
  if (!match) return undefined;
  const tab = (match[1] ?? "general") as Tab;
  return TABS.includes(tab) ? tab : undefined;
}
