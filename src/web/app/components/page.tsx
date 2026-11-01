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
