import { WarningCircle } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const PROBLEM = "The bot ran into a problem. Its log says what happened.";

/** Something went wrong; `message` when the bot said what, its log otherwise. */
export function Problem({ message = PROBLEM }: { message?: string }) {
  return (
    <Alert variant="destructive">
      <WarningCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
