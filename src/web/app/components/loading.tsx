import { cn } from "cn";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
          <li key={i} className="flex flex-col gap-2.5 px-5 py-4">
            <TextSkeleton className={i % 2 ? "w-56" : "w-72"} />
            <TextSkeleton className={i % 2 ? "w-1/2" : "w-2/3"} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A form card: a title, a description, and `fields` fields. */
export function FormCardSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <TextSkeleton className="h-5 w-40" />
        <TextSkeleton className="w-2/3" />
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <FieldSkeleton key={i} />
        ))}
      </CardContent>
    </Card>
  );
}
