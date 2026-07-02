import { useEffect, useRef, type RefObject } from "react";

type PageSwipeOptions = {
  allowSelector?: string;
  canGoNext: boolean;
  canGoPrevious: boolean;
  enabled?: boolean;
  ignoreSelector?: string;
  onNext: () => void | Promise<void>;
  onPrevious: () => void | Promise<void>;
  ref: RefObject<HTMLElement>;
};

type SwipeSession = {
  inputType: "pointer" | "touch";
  pointerId: number;
  startAt: number;
  startX: number;
  startY: number;
};

const MIN_SWIPE_DISTANCE_PX = 70;
const MAX_SWIPE_DURATION_MS = 800;
const HORIZONTAL_DOMINANCE_RATIO = 1.4;

const defaultIgnoreSelector = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']"
].join(",");

function hasActiveTextSelection() {
  if (typeof window === "undefined") {
    return false;
  }

  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function shouldIgnoreTarget(target: EventTarget | null, selector: string, allowSelector?: string) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (allowSelector && target.closest(allowSelector)) {
    return false;
  }

  return Boolean(target.closest(selector));
}

export function usePageSwipe({
  allowSelector,
  canGoNext,
  canGoPrevious,
  enabled = true,
  ignoreSelector,
  onNext,
  onPrevious,
  ref
}: PageSwipeOptions) {
  const sessionRef = useRef<SwipeSession | null>(null);
  const latestRef = useRef({ canGoNext, canGoPrevious, enabled, onNext, onPrevious });
  const lastSwipeAtRef = useRef(0);

  useEffect(() => {
    latestRef.current = { canGoNext, canGoPrevious, enabled, onNext, onPrevious };
  }, [canGoNext, canGoPrevious, enabled, onNext, onPrevious]);

  useEffect(() => {
    const surface = ref.current;
    if (!surface) {
      return;
    }
    const swipeSurface = surface;

    const combinedIgnoreSelector = ignoreSelector
      ? `${defaultIgnoreSelector},${ignoreSelector}`
      : defaultIgnoreSelector;

    function clearSession() {
      sessionRef.current = null;
    }

    function startSession(inputType: SwipeSession["inputType"], pointerId: number, clientX: number, clientY: number) {
      sessionRef.current = {
        inputType,
        pointerId,
        startAt: Date.now(),
        startX: clientX,
        startY: clientY
      };
    }

    function finishSession(inputType: SwipeSession["inputType"], pointerId: number, clientX: number, clientY: number) {
      const session = sessionRef.current;
      if (!session || session.inputType !== inputType || pointerId !== session.pointerId || hasActiveTextSelection()) {
        return;
      }

      clearSession();

      const deltaX = clientX - session.startX;
      const deltaY = clientY - session.startY;
      const elapsed = Date.now() - session.startAt;
      if (
        elapsed > MAX_SWIPE_DURATION_MS
        || Math.abs(deltaX) < MIN_SWIPE_DISTANCE_PX
        || Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO
      ) {
        return;
      }

      const latest = latestRef.current;
      if (!latest.enabled) {
        return;
      }

      const now = Date.now();
      if (now - lastSwipeAtRef.current < 350) {
        return;
      }
      lastSwipeAtRef.current = now;

      if (deltaX < 0 && latest.canGoNext) {
        void latest.onNext();
        return;
      }

      if (deltaX > 0 && latest.canGoPrevious) {
        void latest.onPrevious();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const latest = latestRef.current;
      if (!latest.enabled || !event.isPrimary || event.pointerType === "mouse" || shouldIgnoreTarget(event.target, combinedIgnoreSelector, allowSelector)) {
        clearSession();
        return;
      }

      startSession("pointer", event.pointerId, event.clientX, event.clientY);

      try {
        swipeSurface.setPointerCapture(event.pointerId);
      } catch {
        // Some browsers decline capture if the pointer is already released.
      }
    }

    function handlePointerUp(event: PointerEvent) {
      try {
        swipeSurface.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already be released by the browser.
      }

      finishSession("pointer", event.pointerId, event.clientX, event.clientY);
    }

    function handleTouchStart(event: TouchEvent) {
      const latest = latestRef.current;
      if (!latest.enabled || event.touches.length !== 1 || shouldIgnoreTarget(event.target, combinedIgnoreSelector, allowSelector)) {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      startSession("touch", touch.identifier, touch.clientX, touch.clientY);
    }

    function handleTouchEnd(event: TouchEvent) {
      const session = sessionRef.current;
      if (!session || session.inputType !== "touch") {
        return;
      }

      const touch = Array.from(event.changedTouches).find((entry) => entry.identifier === session.pointerId);
      if (!touch) {
        clearSession();
        return;
      }

      finishSession("touch", touch.identifier, touch.clientX, touch.clientY);
    }

    swipeSurface.addEventListener("pointerdown", handlePointerDown, { passive: true });
    swipeSurface.addEventListener("pointerup", handlePointerUp, { passive: true });
    swipeSurface.addEventListener("pointercancel", clearSession, { passive: true });
    swipeSurface.addEventListener("touchstart", handleTouchStart, { passive: true });
    swipeSurface.addEventListener("touchend", handleTouchEnd, { passive: true });
    swipeSurface.addEventListener("touchcancel", clearSession, { passive: true });

    return () => {
      swipeSurface.removeEventListener("pointerdown", handlePointerDown);
      swipeSurface.removeEventListener("pointerup", handlePointerUp);
      swipeSurface.removeEventListener("pointercancel", clearSession);
      swipeSurface.removeEventListener("touchstart", handleTouchStart);
      swipeSurface.removeEventListener("touchend", handleTouchEnd);
      swipeSurface.removeEventListener("touchcancel", clearSession);
    };
  }, [allowSelector, ignoreSelector, ref]);
}
