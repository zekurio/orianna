import { SignIn as SignInIcon } from "@phosphor-icons/react";
import portrait from "./orianna.png";
import { standalone } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function SignIn({ message }: { message?: string }) {
  return (
    <main className={standalone}>
      <img className="mb-2" src={portrait} alt="" width={160} height={160} />
      <h1 className="text-5xl text-foreground">Orianna</h1>
      {message && (
        <Alert className="max-w-sm">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <Button size="lg" asChild>
        <a href="/auth/login">
          <SignInIcon />
          Sign in with Fluxer
        </a>
      </Button>
    </main>
  );
}
