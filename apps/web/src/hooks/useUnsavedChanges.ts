import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { confirmUnsavedChanges, type ConfirmUnsavedChangesOptions } from "../components/confirmUnsavedChanges";

const confirmNavigationEvent = "lector:confirm-navigation";
type NavigationRequest = CustomEvent<Promise<boolean>[]>;

export async function confirmPendingNavigation() {
  const event: NavigationRequest = new CustomEvent(confirmNavigationEvent, { detail: [] });
  window.dispatchEvent(event);
  return (await Promise.all(event.detail)).every(Boolean);
}

export function registerPendingNavigation(confirm: () => Promise<boolean>) {
  const listener = (event: Event) => {
    (event as NavigationRequest).detail.push(confirm());
  };
  window.addEventListener(confirmNavigationEvent, listener);
  return () => window.removeEventListener(confirmNavigationEvent, listener);
}

export function useUnsavedChanges(hasUnsavedChanges: boolean, options: ConfirmUnsavedChangesOptions) {
  const current = useRef({ hasUnsavedChanges, options });
  current.current = { hasUnsavedChanges, options };
  const alive = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => current.current.hasUnsavedChanges && (
    currentLocation.pathname !== nextLocation.pathname
    || currentLocation.search !== nextLocation.search
    || currentLocation.hash !== nextLocation.hash
  ));
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  async function confirmDiscardChanges() {
    return !current.current.hasUnsavedChanges || await confirmUnsavedChanges(current.current.options);
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // Saving re-renders the form; retain the pending destination until the decision resolves.
    void confirmDiscardChanges().then((allowed) => {
      const pending = blockerRef.current;
      if (!alive.current || pending.state !== "blocked") return;
      if (allowed) pending.proceed(); else pending.reset();
    });
  }, [blocker.state, blocker.location?.key]);

  useEffect(() => registerPendingNavigation(confirmDiscardChanges), []);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  return confirmDiscardChanges;
}
