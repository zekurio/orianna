import { cn } from "cn";
import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// What stands in for content while it loads: skeletons in its shape, which
// fade in only once the wait is noticeable. Spinners are for buttons whose
// action is running, not for loading.

/** Announces the wait, and fades its skeletons in late. */
export function Placeholder({
  label = "Loading",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-label={label} className={cn("appear-late", className)}>
      {children}
    </div>
  );
}

/** A line of text, as wide as `className` says, like `w-40`. */
export function TextSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-4 w-full", className)} />;
}

/** A labelled input, with its hint. */
export function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <TextSkeleton className="w-24" />
      <Skeleton className="h-9 w-full rounded-lg" />
      <TextSkeleton className="h-3 w-3/4" />
    </div>
  );
}

/** A card with a title, a line of description, and `rows` rows of a list. */
export function ListCardSkeleton({ rows = 3, title = true }: { rows?: number; title?: boolean }) {
  return (
    <Card className="gap-0 py-0">
      {title && (
        <CardHeader className="gap-2 border-b py-5">
          <TextSkeleton className="h-5 w-40" />
          <TextSkeleton className="w-2/3" />
        </CardHeader>
      )}
      <ul className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex flex-col gap-2.5 px-3 py-3.5 sm:px-5 sm:py-4">
            <TextSkeleton className={i % 2 ? "w-56" : "w-72"} />
            <TextSkeleton className={i % 2 ? "w-1/2" : "w-2/3"} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A group of settings: its heading, and `rows` rows with a control on the right. */
export function SettingsGroupSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <TextSkeleton className="mx-1 my-2 h-5 w-32" />
      <div className="divide-y rounded-xl border bg-card">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-6 px-3 py-3.5 sm:px-5 sm:py-4">
            <TextSkeleton className={i % 2 ? "w-40" : "w-56"} />
            <Skeleton className="h-8 w-32 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
