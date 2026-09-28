"use client";

import { useSyncExternalStore } from "react";

/**
 * Tracks `prefers-reduced-motion` live (P2 spec, "Accessibility/Motion").
 *
 * Built on `useSyncExternalStore` -- the React-recommended way to read a
 * browser-only external value that must also render correctly during SSR.
 * A prior revision used a `useState` lazy initializer that called
 * `window.matchMedia(...)` directly; that reads the REAL value on the
 * client's very first render, which does not match the server-rendered
 * HTML (server has no `window`, so it always renders the `false` default)
 * -- a genuine hydration mismatch, caught by browser regression testing
 * (P2 fix pass). `useSyncExternalStore`'s `getServerSnapshot` argument
 * exists specifically to solve this: React renders that value for both
 * the server pass and the client's first (hydrating) pass, then
 * synchronously swaps in the real `getSnapshot()` value immediately after
 * hydration -- no mismatch warning, and no visible flash either.
 */
function subscribe(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
