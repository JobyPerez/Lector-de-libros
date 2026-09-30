import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

const confirmNavigationEvent = "lector:confirm-navigation";
const unsavedChangesMessage = "Tienes cambios sin guardar en esta página. Si sales, se perderán. ¿Quieres salir sin guardar?";

export function confirmPendingNavigation() {
  return window.dispatchEvent(new Event(confirmNavigationEvent, { cancelable: true }));
}

export function useUnsavedChanges(hasUnsavedChanges: boolean) {
  const confirmedExitRef = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsavedChanges && !confirmedExitRef.current && (
    currentLocation.pathname !== nextLocation.pathname
    || currentLocation.search !== nextLocation.search
    || currentLocation.hash !== nextLocation.hash
  ));

  function confirmDiscardChanges() {
    return !hasUnsavedChanges || window.confirm(unsavedChangesMessage);
  }

  useEffect(() => {
    if (blocker.state !== "blocked") {
      return;
    }

    if (window.confirm(unsavedChangesMessage)) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    function handleConfirmNavigation(event: Event) {
      if (!window.confirm(unsavedChangesMessage)) {
        event.preventDefault();
      } else {
        confirmedExitRef.current = true;
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener(confirmNavigationEvent, handleConfirmNavigation);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener(confirmNavigationEvent, handleConfirmNavigation);
    };
  }, [hasUnsavedChanges]);

  return confirmDiscardChanges;
}
