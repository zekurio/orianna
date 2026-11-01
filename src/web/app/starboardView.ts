import { create } from "zustand";
import type { StarboardSort } from "../rpc.ts";

// How the starboard page is shown, kept while the member is on other pages
// of the same guild.

interface StarboardView {
  /** The guild it's for; another one starts over. */
  guildId: string | null;
  sort: StarboardSort;
  /** How many pages of entries are loaded; "Load more ..." adds one. */
  pages: number;
  /** The settings dialog is open. */
  settingsOpen: boolean;
  toggleSort: () => void;
  loadMore: () => void;
  /** Back to the first page, to load the entries again. */
  firstPage: () => void;
  setSettingsOpen: (open: boolean) => void;
  /** Starts over when the page is for another guild than last time. */
  enter: (guildId: string) => void;
}

export const useStarboardView = create<StarboardView>()((set) => ({
  guildId: null,
  sort: "latest",
  pages: 1,
  settingsOpen: false,
  toggleSort: () => set(({ sort }) => ({ sort: sort === "latest" ? "top" : "latest", pages: 1 })),
  loadMore: () => set(({ pages }) => ({ pages: pages + 1 })),
  firstPage: () => set({ pages: 1 }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  enter: (guildId) =>
    set((view) => (view.guildId === guildId ? view : { guildId, sort: "latest", pages: 1, settingsOpen: false })),
}));
