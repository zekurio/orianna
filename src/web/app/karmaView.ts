import { create } from "zustand";

// Whether the karma settings are open, for the button in the header and the
// one on a page where karma is off.

interface KarmaView {
  /** The guild it's for; another one starts over. */
  guildId: string | null;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Starts over when the page is for another guild than last time. */
  enter: (guildId: string) => void;
}

export const useKarmaView = create<KarmaView>()((set) => ({
  guildId: null,
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  enter: (guildId) => set((view) => (view.guildId === guildId ? view : { guildId, settingsOpen: false })),
}));
