import { MagnifyingGlass, Wrench } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useSession } from "./App.tsx";
import { BoardOptOut } from "./BoardOptOut.tsx";
import { Empty } from "./Empty.tsx";
import { Link } from "./router.tsx";
import { Avatar, buttonClass, cx, Lead, PageHeader, panel, SectionTitle, Tag } from "./ui.tsx";

// The pages behind the tabs and the user menu. Some only say what they're for so far.

function Unbuilt({ children }: { children?: ReactNode }) {
  return (
    <Empty icon={Wrench} title="Not built yet">
      {children ?? "This page is still to come."}
    </Empty>
  );
}

export function CommandsPage() {
  const { prefix } = useSession();
  return (
    <>
      <PageHeader
        title="Commands"
        lead={
          <>
            The commands you can use, and how to use them. They all start with <code>{prefix}</code>.
          </>
        }
      />
      <Unbuilt />
    </>
  );
}

export function ProfilePage() {
  const { user, admin } = useSession();
  return (
    <>
      <PageHeader title="Profile" />
      <section className={cx(panel, "flex items-center gap-4 px-5 py-4.5")}>
        <Avatar url={user.avatarUrl} size={64} />
        <div className="grid justify-items-start gap-0.5">
          <strong className="font-display text-[1.375rem] leading-tight">{user.name}</strong>
          {user.tag !== user.name && <span className="text-rose">{user.tag}</span>}
          {admin && (
            <span className="mt-1">
              <Tag tone="brass">Server admin</Tag>
            </span>
          )}
        </div>
      </section>
      <div className="flex flex-col gap-2">
        <SectionTitle>Your settings</SectionTitle>
        <Lead>Settings that only change things for you.</Lead>
      </div>
      <BoardOptOut />
    </>
  );
}

/** Settings for the whole server, for the guild owner and members with Administrator. */
export function AdminPage() {
  const { admin, prefix } = useSession();
  if (!admin) {
    return (
      <PageHeader
        title="Admin"
        lead="Only the server owner and members with Administrator can change the bot settings."
      />
    );
  }
  return (
    <>
      <PageHeader title="Admin" lead="What the bot does in the server: the prefix, permissions and every feature." />
      <Unbuilt>
        Until it is, use <code>{prefix}settings export</code> and <code>{prefix}settings import</code> in chat.
      </Unbuilt>
    </>
  );
}

export function NotFoundPage({ path }: { path: string }) {
  return (
    <>
      <PageHeader title="Nothing here" />
      <Empty
        icon={MagnifyingGlass}
        title="No such page"
        action={
          <Link to="/boards" className={buttonClass("secondary")}>
            Go to the boards
          </Link>
        }
      >
        There's no page at <code>{path}</code>.
      </Empty>
    </>
  );
}
