import { useCallback, useEffect, useRef, useState } from "react";

type ImageViewerModalProps = {
  alt?: string | undefined;
  isOpen: boolean;
  onClose: () => void;
  src: string;
  title?: string | undefined;
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.25;

export function ImageViewerModal({ alt, isOpen, onClose, src, title }: ImageViewerModalProps) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; posX: number; posY: number }>({
    mouseX: 0,
    mouseY: 0,
    posX: 0,
    posY: 0
  });

  // Touch handling refs
  const touchDistanceRef = useRef<number | null>(null);
  const touchStartZoomRef = useRef<number>(1);
  const lastTapTimeRef = useRef<number>(0);

  const resetTransform = useCallback(() => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // Reset when opening a new image
  useEffect(() => {
    if (isOpen) {
      resetTransform();
    }
  }, [isOpen, resetTransform, src]);

  // Lock body scroll while modal is open
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const handleZoomIn = useCallback(() => {
    setZoom((current) => Math.min(MAX_ZOOM, Math.round(current * ZOOM_STEP * 100) / 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((current) => {
      const next = Math.max(MIN_ZOOM, Math.round((current / ZOOM_STEP) * 100) / 100);
      if (next <= 1) {
        setPosition({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const toggleDoubleZoom = useCallback(() => {
    setZoom((current) => {
      if (current > 1.2) {
        setPosition({ x: 0, y: 0 });
        return 1;
      }
      return 2.5;
    });
  }, []);

  // Wheel zoom
  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const zoomFactor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((current) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(current * zoomFactor * 100) / 100));
      if (next <= 1 && current > 1) {
        setPosition({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        handleZoomIn();
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        handleZoomOut();
        return;
      }

      if (event.key === "0" || event.key === "r" || event.key === "R") {
        event.preventDefault();
        resetTransform();
        return;
      }

      const panDelta = 60;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPosition((pos) => ({ ...pos, x: pos.x + panDelta }));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPosition((pos) => ({ ...pos, x: pos.x - panDelta }));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setPosition((pos) => ({ ...pos, y: pos.y + panDelta }));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setPosition((pos) => ({ ...pos, y: pos.y - panDelta }));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleZoomIn, handleZoomOut, isOpen, onClose, resetTransform]);

  // Mouse drag handlers
  const handleMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      posX: position.x,
      posY: position.y
    };
  };

  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!isDraggingRef.current) {
      return;
    }

    const deltaX = event.clientX - dragStartRef.current.mouseX;
    const deltaY = event.clientY - dragStartRef.current.mouseY;

    setPosition({
      x: dragStartRef.current.posX + deltaX,
      y: dragStartRef.current.posY + deltaY
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Touch handlers
  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      // Check double tap
      const now = Date.now();
      if (now - lastTapTimeRef.current < 300) {
        toggleDoubleZoom();
        lastTapTimeRef.current = 0;
        return;
      }
      lastTapTimeRef.current = now;

      isDraggingRef.current = true;
      setIsDragging(true);
      dragStartRef.current = {
        mouseX: touch.clientX,
        mouseY: touch.clientY,
        posX: position.x,
        posY: position.y
      };
    } else if (event.touches.length === 2) {
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      if (touch1 && touch2) {
        isDraggingRef.current = false;
        setIsDragging(false);
        const distance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
        touchDistanceRef.current = distance;
        touchStartZoomRef.current = zoom;
      }
    }
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (event.touches.length === 1 && isDraggingRef.current) {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - dragStartRef.current.mouseX;
      const deltaY = touch.clientY - dragStartRef.current.mouseY;

      setPosition({
        x: dragStartRef.current.posX + deltaX,
        y: dragStartRef.current.posY + deltaY
      });
    } else if (event.touches.length === 2 && touchDistanceRef.current !== null) {
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      if (touch1 && touch2) {
        const currentDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
        const scaleChange = currentDistance / touchDistanceRef.current;
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(touchStartZoomRef.current * scaleChange * 100) / 100));
        setZoom(nextZoom);
      }
    }
  };

  const handleTouchEnd = () => {
    isDraggingRef.current = false;
    setIsDragging(false);
    touchDistanceRef.current = null;
  };

  if (!isOpen || !src) {
    return null;
  }

  const captionText = (title || alt || "").trim();
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div
      aria-label="Visor de imagen a pantalla completa"
      aria-modal="true"
      className="image-viewer-backdrop"
      ref={containerRef}
      role="dialog"
    >
      {/* Top Header / Close Button */}
      <div className="image-viewer-header">
        <button
          aria-label="Cerrar visor de imagen (Escape)"
          className="image-viewer-close-btn"
          onClick={onClose}
          title="Cerrar (Esc)"
          type="button"
        >
          <svg fill="none" height="22" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" viewBox="0 0 24 24" width="22">
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
          </svg>
        </button>
      </div>

      {/* Main Interactive Stage */}
      <div
        className={`image-viewer-stage ${isDragging ? "is-dragging" : ""}`}
        onDoubleClick={toggleDoubleZoom}
        onMouseDown={handleMouseDown}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        onWheel={handleWheel}
      >
        <div
          className="image-viewer-canvas"
          style={{
            transform: `translate3d(${position.x}px, ${position.y}px, 0px) scale(${zoom})`,
            transition: isDragging ? "none" : "transform 0.15s cubic-bezier(0.2, 0, 0, 1)"
          }}
        >
          <img
            alt={captionText || "Imagen del libro ampliada"}
            className="image-viewer-img"
            draggable={false}
            src={src}
          />
        </div>
      </div>

      {/* Bottom Floating Caption if present */}
      {captionText ? (
        <div className="image-viewer-caption">
          <p>{captionText}</p>
        </div>
      ) : null}

      {/* Bottom Floating Zoom Controls Dock */}
      <div className="image-viewer-toolbar" role="toolbar" aria-label="Controles de zoom">
        <button
          aria-label="Reducir zoom (-)"
          className="image-viewer-toolbar-btn"
          disabled={zoom <= MIN_ZOOM}
          onClick={handleZoomOut}
          title="Reducir zoom (-)"
          type="button"
        >
          <svg fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" viewBox="0 0 24 24" width="18">
            <line x1="5" x2="19" y1="12" y2="12" />
          </svg>
        </button>

        <button
          aria-label={`Restablecer zoom actual (${zoomPercent}%)`}
          className="image-viewer-zoom-badge"
          onClick={resetTransform}
          title="Restablecer tamaño (0)"
          type="button"
        >
          {zoomPercent}%
        </button>

        <button
          aria-label="Aumentar zoom (+)"
          className="image-viewer-toolbar-btn"
          disabled={zoom >= MAX_ZOOM}
          onClick={handleZoomIn}
          title="Aumentar zoom (+)"
          type="button"
        >
          <svg fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" viewBox="0 0 24 24" width="18">
            <line x1="12" x2="12" y1="5" y2="19" />
            <line x1="5" x2="19" y1="12" y2="12" />
          </svg>
        </button>

        {zoom !== 1 || position.x !== 0 || position.y !== 0 ? (
          <button
            aria-label="Ajustar imagen"
            className="image-viewer-toolbar-btn image-viewer-toolbar-btn-reset"
            onClick={resetTransform}
            title="Ajustar imagen"
            type="button"
          >
            <svg fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="17">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}
