import { MagnifyingGlass, UsersThree } from "@phosphor-icons/react";
import { PageHeader } from "@/components/page";
import { SettingsGroup } from "@/components/settings";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useSession } from "./App.tsx";
import { StarboardOptOut } from "./StarboardOptOut.tsx";
import { Link } from "./router.tsx";

// The profile page behind the user menu, the page for paths that aren't one,
// and the one for members who share no guild with the bot.

export function ProfilePage() {
  const { user, guilds } = useSession();
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
            <strong className="truncate font-heading text-[1.375rem] leading-tight">{user.name}</strong>
            <span className="text-muted-foreground">
              {user.tag !== user.name ? `${user.tag} · ` : ""}
              {guilds.length === 1 ? "1 server" : `${guilds.length} servers`} with Orianna
            </span>
          </div>
        </CardContent>
      </Card>
      <SettingsGroup title="Privacy" description="Applies in every server.">
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
            <Link to="/">Go back</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}

/** For someone who shares no guild with the bot. */
export function NoGuildsPage() {
  return (
    <>
      <PageHeader title="No servers yet" />
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersThree />
          </EmptyMedia>
          <EmptyTitle>Orianna isn't in any of your servers</EmptyTitle>
          <EmptyDescription>Servers show up here once it joins one you're in.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link to="/profile">Open your profile</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
