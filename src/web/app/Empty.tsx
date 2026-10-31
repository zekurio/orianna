import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

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
    <div className="empty">
      <div className="empty-media">
        <EmptyIcon />
      </div>
      <h2 className="empty-title">{title}</h2>
      {children && <p className="empty-description">{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
