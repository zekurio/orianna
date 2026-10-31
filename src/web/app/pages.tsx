import { MagnifyingGlass, Wrench } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Lead, PageHeader, SectionTitle } from "@/components/page";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useSession } from "./App.tsx";
import { BoardOptOut } from "./BoardOptOut.tsx";
import { Link } from "./router.tsx";

// The pages behind the tabs and the user menu. Some only say what they're for so far.

function Unbuilt({ children }: { children?: ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Wrench />
        </EmptyMedia>
        <EmptyTitle>Not built yet</EmptyTitle>
        <EmptyDescription>{children ?? "This page is still to come."}</EmptyDescription>
      </EmptyHeader>
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
      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-16">
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <div className="grid justify-items-start gap-0.5">
            <strong className="font-heading text-[1.375rem] leading-tight">{user.name}</strong>
            {user.tag !== user.name && <span className="text-muted-foreground">{user.tag}</span>}
            {admin && <Badge className="mt-1">Server admin</Badge>}
          </div>
        </CardContent>
      </Card>
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
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MagnifyingGlass />
          </EmptyMedia>
          <EmptyTitle>No such page</EmptyTitle>
          <EmptyDescription>
            There's no page at <code>{path}</code>.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link to="/boards">Go to the boards</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
