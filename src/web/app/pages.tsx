import { MagnifyingGlass } from "@phosphor-icons/react";
import { PageHeader } from "@/components/page";
import { SettingsGroup } from "@/components/settings";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useSession } from "./App.tsx";
import { StarboardOptOut } from "./StarboardOptOut.tsx";
import { Link } from "./router.tsx";

// The profile page behind the user menu, and the page for paths that aren't one.

export function ProfilePage() {
  const { user, admin, guild } = useSession();
  return (
    <>
      <PageHeader title="Profile" />
      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-14">
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 gap-0.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <strong className="truncate font-heading text-[1.375rem] leading-tight">{user.name}</strong>
              {admin && <Badge>Server admin</Badge>}
            </div>
            <span className="text-muted-foreground">
              {user.tag !== user.name ? `${user.tag} · ` : ""}
              {guild.name}
            </span>
          </div>
        </CardContent>
      </Card>
      <SettingsGroup title="Privacy" description="What the bot may do with your messages. These only change things for you.">
        <StarboardOptOut />
      </SettingsGroup>
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
            <Link to="/starboard">Go to the starboard</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
