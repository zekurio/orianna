import { type ReactNode, useEffect } from "react";

// How a page is laid out. The primitives inside a page are in components/ui.

/** The width of every page, with its gutters. The header spans the whole window instead. */
export const container = "mx-auto w-full max-w-page px-4 sm:px-6 lg:px-10";

/** Pages without the header, like signing in, centred on the screen. */
export const standalone =
  "flex min-h-screen flex-col items-center justify-center gap-4 px-6 py-8 text-center text-muted-foreground";

/** A page's title, what it's for, and what can be done on it. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} – Orianna`;
  }, [title]);
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-3xl leading-tight sm:text-4xl">{title}</h1>
        {lead && <Lead>{lead}</Lead>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </header>
  );
}

/** Running text under a title, held to a readable length. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="max-w-[65ch] text-lg text-muted-foreground">{children}</p>;
}

/** A section's title within a page. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-2xl leading-tight">{children}</h2>;
}

/**
 * Content with a column beside it on wide screens, like the commands page's
 * search and section links, and above it on narrow ones. The column scrolls
 * with the page until it reaches the top, then stays there. It scrolls by
 * itself when it's taller than the window.
 */
export function WithSidebar({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-10">
      {/* Held inside the page's scroll box, which is the window less the 4rem
          header, with the page's 3rem padding above and below. The 0.25rem
          padding keeps focus rings from being clipped by the scrolling. */}
      <aside className="flex flex-col gap-4 lg:sticky lg:top-11 lg:-m-1 lg:max-h-[calc(100dvh-9.5rem)] lg:overflow-y-auto lg:p-1">
        {sidebar}
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
