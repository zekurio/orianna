import { createContext, useContext } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GuildInfo } from "../rpc.ts";

// The bot serves every guild it's in, and the app shows one at a time. A
// guild's pages live under its ID, like `/123/starboard`, so links keep the
// guild; the profile is the member's own and lives outside, at `/profile`.

/** A path in a guild, like `/123/starboard`. */
export function guildPath(guildId: string, page = "/starboard"): string {
  return `/${guildId}${page}`;
}

/** The guild a path is in, and the page within it, like `/admin/history`. */
export function parseGuildPath(path: string): { guildId: string; page: string } | undefined {
  const match = /^\/(\d+)(\/.*)?$/.exec(path);
  return match ? { guildId: match[1]!, page: match[2] ?? "/" } : undefined;
}

export const GuildContext = createContext<GuildInfo | null>(null);

/** The guild the page is about. Only pages inside a guild use it. */
export function useGuild(): GuildInfo {
  const guild = useContext(GuildContext);
  if (!guild) throw new Error("useGuild is only for pages inside a guild");
  return guild;
}

/** The guild looked at last, to come back to; kept in the browser. */
export const useLastGuild = create<{ guildId: string | null; remember: (guildId: string) => void }>()(
  persist((set) => ({ guildId: null, remember: (guildId) => set({ guildId }) }), { name: "orianna:last-guild" }),
);

/** Where to go without a guild in the path: the last one looked at, or the first. */
export function homeGuild(guilds: readonly GuildInfo[], last: string | null): GuildInfo | undefined {
  return guilds.find((g) => g.id === last) ?? guilds[0];
}
