import { cn } from "cn";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

// Settings as lists, one row each, like the profile's privacy settings and
// the Admin tab. A group has a heading and its rows in one bordered list.
// Each row says what it is on the left and has its control on the right;
// on a phone a wide control, like a select, goes under it. What a
// row holds more of, like a list of channels, goes below it.

/** A heading, something to do with the group beside it, and its rows. */
export function SettingsGroup({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3 px-1">
        <h2 className="min-w-0 font-heading text-lg/6 font-semibold">{title}</h2>
        {action}
      </div>
      <div className="divide-y rounded-xl border bg-card">{children}</div>
    </section>
  );
}

/**
 * One setting. `id` is its control's, which the title labels and the
 * description and problem describe, as `<id>-description`.
 */
export function SettingRow({
  id,
  title,
  description,
  problem,
  control,
  wide = false,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  /** What's wrong with it, under the description. */
  problem?: string;
  control?: ReactNode;
  /** A control too wide to sit beside the title on a phone, like a select, goes under it there. */
  wide?: boolean;
  /** What goes below it, the row's whole width. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5 px-3 py-3 sm:gap-3 sm:px-5 sm:py-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1">
          {id ? (
            <Label htmlFor={id} className="text-base leading-snug">
              {title}
            </Label>
          ) : (
            <span className="text-base leading-snug font-medium">{title}</span>
          )}
          {(description || problem) && (
            <div id={id && `${id}-description`} className="flex flex-col gap-1 text-sm">
              {description && <p className="max-w-[72ch] text-muted-foreground">{description}</p>}
              {problem && (
                <p role="alert" className="whitespace-pre-line text-destructive">
                  {problem}
                </p>
              )}
            </div>
          )}
        </div>
        {control && (
          <div className={cn("flex max-w-full min-w-0 items-center justify-end gap-2", wide && "max-sm:basis-full")}>
            {control}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
