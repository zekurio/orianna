import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cx, panel } from "./ui.tsx";

/** What a place shows with nothing in it yet: an icon, what's missing, and what to do about it. */
export function Empty({
  icon: EmptyIcon,
  title,
  children,
  action,
}: {
  icon: Icon;
  title: string;
  /** Why it's empty, or how it fills up. */
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cx(
        panel,
        "flex w-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center text-balance sm:py-16",
      )}
    >
      <div className="mb-2.5 grid size-12 place-items-center rounded-xl border border-line bg-charcoal text-xl">
        <EmptyIcon />
      </div>
      <h2 className="text-xl leading-snug">{title}</h2>
      {children && <p className="max-w-sm text-[0.9375rem] text-rose">{children}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-3">{action}</div>}
    </div>
  );
}
