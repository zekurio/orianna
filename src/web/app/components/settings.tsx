import type { ReactNode } from "react";
import { Lead, SectionTitle } from "@/components/page";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

// Lists of settings, one row each, like the profile page's privacy settings.
// Each row says what it does on the left and has its control on the right,
// so a group takes another setting by adding a row.

/** A heading, what the settings in it are about, and their rows. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionTitle>{title}</SectionTitle>
        {description && <Lead>{description}</Lead>}
      </div>
      <Card className="gap-0 py-0">
        <ul className="divide-y">{children}</ul>
      </Card>
    </section>
  );
}

/**
 * One setting. `id` is its control's, which the title labels and the
 * description describes; `hint` is a smaller line under the description, like
 * the chat commands that do the same.
 */
export function SettingRow({
  id,
  title,
  description,
  hint,
  control,
}: {
  id: string;
  title: string;
  description: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1.5 px-5 py-4">
      <Label htmlFor={id} className="text-base leading-snug">
        {title}
      </Label>
      <div className="row-span-3 flex min-h-6 items-center">{control}</div>
      <p id={`${id}-description`} className="max-w-[72ch] text-sm text-muted-foreground">
        {description}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </li>
  );
}
