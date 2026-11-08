import { IconContext, type IconProps } from "@phosphor-icons/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./App.tsx";

// Icons are bold, sized to the text next to them, and only ever decorate a label.
const icons: IconProps = { weight: "bold", size: "1.25em", "aria-hidden": true };

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <IconContext value={icons}>
      <App />
      {/* Clear of the tab bar along the bottom of narrow screens; see styles.css. */}
      <Toaster position="bottom-right" offset={{ bottom: "var(--toast-bottom)" }} mobileOffset={{ bottom: "var(--toast-bottom)" }} />
    </IconContext>
  </StrictMode>,
);
