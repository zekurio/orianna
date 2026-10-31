import { SignIn as SignInIcon } from "@phosphor-icons/react";
import portrait from "./orianna.png";

export function SignIn({ message }: { message?: string }) {
  return (
    <main className="standalone sign-in">
      <img className="sign-in-portrait" src={portrait} alt="" width={160} height={160} />
      <h1>Orianna</h1>
      {message && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
      <a className="button" href="/auth/login">
        <SignInIcon />
        Sign in with Fluxer
      </a>
    </main>
  );
}
