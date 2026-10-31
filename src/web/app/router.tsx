import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

// The app routes in the browser with the history API; the server answers
// every page with the app.

const NAVIGATE = "orianna:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

/** The path of the page, which changes as the member moves around. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, { replace = false } = {}) {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
}

/** A link that moves within the app without loading the page again. */
export function Link({ to, onClick, ...props }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    // Leave new tabs and windows to the browser.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={follow} {...props} />;
}
