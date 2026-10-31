import type { Icon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "./router.tsx";

// The pieces every page is built from. Widths, spacing and colours are set
// here, so pages line up with each other and with the header.

/** Joins class names, skipping the ones that are off. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The width of the header's contents and of every page, with the same gutters. */
export const container = "mx-auto w-full max-w-page px-4 sm:px-6 lg:px-10";

/** Pages without the header, like signing in, centred on the screen. */
export const standalone =
  "flex min-h-screen flex-col items-center justify-center gap-4 px-6 py-8 text-center text-rose";

/** A raised surface: posts, forms, settings, empty states. */
export const panel = "rounded-2xl border border-line bg-raised";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

/** For a `<button>`, a `<Link>` or an `<a>` that looks like a button. */
export function buttonClass(variant: ButtonVariant = "primary"): string {
  const shape =
    "inline-flex items-center justify-center gap-2 no-underline hover:no-underline transition-colors " +
    "disabled:cursor-not-allowed disabled:opacity-55";
  switch (variant) {
    case "primary":
      return cx(
        shape,
        "min-h-11 rounded-full px-6 font-display text-[1.0625rem] leading-none font-semibold",
        "bg-brass text-charcoal hover:bg-brass-light disabled:hover:bg-brass",
      );
    case "secondary":
      return cx(
        shape,
        "min-h-11 rounded-full border border-line px-6 font-display text-[1.0625rem] leading-none font-semibold",
        "text-porcelain hover:border-brass hover:text-brass disabled:hover:border-line disabled:hover:text-porcelain",
      );
    case "text":
      return cx(shape, "p-0 text-eye hover:underline");
    case "danger":
      return cx(shape, "p-0 text-danger hover:underline");
  }
}

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
  return <p className="max-w-[65ch] text-lg text-rose">{children}</p>;
}

/** A section's title within a page. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-2xl leading-tight">{children}</h2>;
}

export function Hint({ id, problem, children }: { id?: string; problem?: boolean; children: ReactNode }) {
  return (
    <p id={id} className={cx("text-sm", problem ? "text-danger" : "text-rose")}>
      {children}
    </p>
  );
}

/** Something went wrong, for the member to read. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-danger/60 px-4 py-2.5 text-porcelain" role="alert">
      {children}
    </p>
  );
}

/** Something worked. */
export function Saved({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-eye/40 bg-eye/8 px-4 py-2.5" role="status">
      {children}
    </p>
  );
}

/** Waiting for something to load. */
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return <p className="text-rose">{children}</p>;
}

export function Tag({ tone = "danger", children }: { tone?: "danger" | "brass"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "rounded-md px-1.5 text-xs font-semibold",
        tone === "danger" ? "bg-danger/16 text-danger" : "bg-brass/14 text-brass",
      )}
    >
      {children}
    </span>
  );
}

export interface TabItem {
  to: string;
  label: string;
  icon: Icon;
  current: boolean;
}

/** Pill tabs that switch between views of one page. */
export function Tabs({ label, items }: { label: string; items: readonly TabItem[] }) {
  return (
    <nav className="flex w-fit flex-wrap gap-1 rounded-full border border-line p-1" aria-label={label}>
      {items.map(({ to, label, icon: TabIcon, current }) => (
        <Link
          key={to}
          to={to}
          aria-current={current ? "page" : undefined}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full px-4.5 py-1.5 font-display font-medium no-underline hover:no-underline",
            current ? "bg-brass text-charcoal" : "text-rose hover:text-porcelain",
          )}
        >
          <TabIcon />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A rounded chip, like a board in the board picker. A dashed one adds
 * something rather than going somewhere.
 */
export function chipClass(current: boolean, dashed = false): string {
  return cx(
    "inline-flex flex-none items-center gap-2 rounded-full border px-4 py-2 font-display text-[1.0625rem] leading-tight font-medium no-underline hover:no-underline",
    current && "border-brass bg-brass/12 text-brass",
    !current && dashed && "border-dashed border-line text-rose hover:border-rose hover:text-porcelain",
    !current && !dashed && "border-line text-porcelain hover:border-rose",
  );
}

/** Asks once more before doing something that can't be undone. */
export function Confirm({
  children,
  confirm,
  cancel = "Cancel",
  busy,
  onConfirm,
  onCancel,
}: {
  children: ReactNode;
  confirm: string;
  cancel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-2">
      <span>{children}</span>
      <button type="button" className={buttonClass("danger")} disabled={busy} onClick={onConfirm}>
        {confirm}
      </button>
      <button type="button" className={buttonClass("text")} disabled={busy} onClick={onCancel}>
        {cancel}
      </button>
    </span>
  );
}

/** A member's avatar, or a blank circle when there's none or it doesn't load. */
export function Avatar({ url, size }: { url: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <span className="block flex-none rounded-full bg-line" style={{ width: size, height: size }} />;
  }
  return (
    <img
      className="flex-none rounded-full"
      src={url}
      alt=""
      width={size}
      height={size}
      onError={() => setBroken(true)}
    />
  );
}

// Forms

/** Text inputs and selects. */
export const inputClass =
  "min-h-11 w-full rounded-[10px] border border-line bg-charcoal px-3.5 text-porcelain " +
  "placeholder:text-rose/70 hover:border-rose aria-invalid:border-danger";

/** Checkboxes, which take the brass of the rest of the app. */
export const checkboxClass = "size-4.5 flex-none accent-brass";

/** A labelled control with a hint under it. */
export function Field({
  label,
  htmlFor,
  hint,
  hintId,
  problem,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  hintId?: string;
  problem?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={htmlFor} className="font-display font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <Hint id={hintId} problem={problem}>
          {hint}
        </Hint>
      )}
    </div>
  );
}

/** Like {@link Field}, for a group of controls. */
export function FieldSet({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 font-display font-medium">{legend}</legend>
      {hint && <Hint>{hint}</Hint>}
      {children}
    </fieldset>
  );
}
