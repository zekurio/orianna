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
        <h1 className="text-3xl/9 sm:text-4xl/11">{title}</h1>
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
 * A page with a column of its own, like the commands page's search and
 * section links. On wide screens the column runs down the window's left
 * edge, 16rem wide, and stays put while the page scrolls; the page stays
 * centred like the others, moving right only as far as it takes to keep 2rem
 * clear of it. Its content starts at the centred page's edge,
 * (100vw - 72rem) / 2, plus its 2.5rem padding. On narrow screens the column
 * goes between the header and the content.
 */
export function WithSidebar({
  header,
  sidebar,
  children,
}: {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-6 lg:ml-[max(0px,calc(15.5rem_-_max(0px,50vw_-_36rem)))]">
      {header}
      {/* Below the header, which is 4rem tall on wide screens. */}
      {sidebar && (
        <aside className="flex flex-col gap-4 lg:fixed lg:top-16 lg:bottom-0 lg:left-0 lg:w-64 lg:overflow-y-auto lg:border-r lg:px-6 lg:pt-12 lg:pb-6">
          {sidebar}
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
