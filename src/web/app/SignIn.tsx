import { SignIn as SignInIcon } from "@phosphor-icons/react";
import portrait from "./orianna.png";
import { buttonClass, standalone } from "./ui.tsx";

export function SignIn({ message }: { message?: string }) {
  return (
    <main className={standalone}>
      <img className="mb-2" src={portrait} alt="" width={160} height={160} />
      <h1 className="text-5xl text-porcelain">Orianna</h1>
      {message && (
        <p className="max-w-[38ch] rounded-xl border border-rose px-4 py-2.5 text-porcelain" role="alert">
          {message}
        </p>
      )}
      <a className={buttonClass()} href="/auth/login">
        <SignInIcon />
        Sign in with Fluxer
      </a>
    </main>
  );
}
