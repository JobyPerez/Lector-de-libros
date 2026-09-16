import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import {
  analyzeDocumentCanvas,
  prepareDocumentScan,
  renderDocumentScan,
  rotateDocumentCanvas,
  type PreparedDocumentScan,
  type ScanPoint,
  type ScanQualityIssue
} from "./document-scanner";

type DocumentScannerModalProps = {
  files: File[];
  onCancel: () => void;
  onComplete: (files: File[]) => void;
};

const qualityIssueLabels: Record<ScanQualityIssue, string> = {
  blur: "La foto parece desenfocada. Si el texto no se ve nítido, repite la captura.",
  dark: "La imagen está oscura. Procura iluminar la página de forma uniforme.",
  "low-resolution": "La resolución es baja y puede reducir la precisión del OCR.",
  overexposed: "Hay demasiada luz. Revisa que no existan reflejos sobre el papel."
};

function scanPreviewUrl(scan: PreparedDocumentScan) {
  return scan.source.toDataURL("image/jpeg", 0.84);
}

type ScannerDragTarget =
  | { cornerIndex: number; type: "corner" }
  | { cornerA: number; cornerB: number; edgeIndex: number; type: "edge" }
  | { type: "polygon" };

type ScannerDragSession = {
  boundsHeight: number;
  boundsWidth: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCorners: ScanPoint[];
  target: ScannerDragTarget;
};

export function DocumentScannerModal({ files, onCancel, onComplete }: DocumentScannerModalProps) {
  const [fileIndex, setFileIndex] = useState(0);
  const [processedFiles, setProcessedFiles] = useState<File[]>([]);
  const [scan, setScan] = useState<PreparedDocumentScan | null>(null);
  const [corners, setCorners] = useState<ScanPoint[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [activeDragTarget, setActiveDragTarget] = useState<ScannerDragTarget | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const dragSessionRef = useRef<ScannerDragSession | null>(null);
  const currentFile = files[fileIndex] ?? null;

  useEffect(() => {
    if (!currentFile) return;
    let cancelled = false;
    setScan(null);
    setCorners([]);
    setPreviewUrl("");
    setError(null);
    setIsProcessing(true);

    void prepareDocumentScan(currentFile)
      .then((prepared) => {
        if (cancelled) return;
        setScan(prepared);
        setCorners(prepared.corners);
        setPreviewUrl(scanPreviewUrl(prepared));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo analizar la imagen.");
      })
      .finally(() => {
        if (!cancelled) setIsProcessing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isProcessing) {
        event.preventDefault();
        handleCancel();
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']"));
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProcessing, processedFiles]);

  useEffect(() => {
    if (!activeDragTarget) return;

    function handlePointerMove(event: PointerEvent) {
      const session = dragSessionRef.current;
      if (!session || event.pointerId !== session.pointerId || !scan) return;

      event.preventDefault();

      const deltaX = session.boundsWidth > 0
        ? ((event.clientX - session.startClientX) / session.boundsWidth) * scan.source.width
        : 0;
      const deltaY = session.boundsHeight > 0
        ? ((event.clientY - session.startClientY) / session.boundsHeight) * scan.source.height
        : 0;

      if (session.target.type === "corner") {
        const cornerIndex = session.target.cornerIndex;
        const startPoint = session.startCorners[cornerIndex];
        if (!startPoint) return;
        const nextX = Math.max(0, Math.min(scan.source.width, startPoint.x + deltaX));
        const nextY = Math.max(0, Math.min(scan.source.height, startPoint.y + deltaY));
        setCorners(session.startCorners.map((point, index) =>
          index === cornerIndex ? { x: nextX, y: nextY } : point
        ));
      } else if (session.target.type === "edge") {
        const cornerA = session.target.cornerA;
        const cornerB = session.target.cornerB;
        const pA = session.startCorners[cornerA];
        const pB = session.startCorners[cornerB];
        if (!pA || !pB) return;

        const minDeltaX = Math.max(-pA.x, -pB.x);
        const maxDeltaX = Math.min(scan.source.width - pA.x, scan.source.width - pB.x);
        const clampedDeltaX = Math.max(minDeltaX, Math.min(maxDeltaX, deltaX));

        const minDeltaY = Math.max(-pA.y, -pB.y);
        const maxDeltaY = Math.min(scan.source.height - pA.y, scan.source.height - pB.y);
        const clampedDeltaY = Math.max(minDeltaY, Math.min(maxDeltaY, deltaY));

        setCorners(session.startCorners.map((point, index) =>
          index === cornerA || index === cornerB
            ? { x: point.x + clampedDeltaX, y: point.y + clampedDeltaY }
            : point
        ));
      } else if (session.target.type === "polygon") {
        const minDeltaX = Math.max(...session.startCorners.map((p) => -p.x));
        const maxDeltaX = Math.min(...session.startCorners.map((p) => scan.source.width - p.x));
        const clampedDeltaX = Math.max(minDeltaX, Math.min(maxDeltaX, deltaX));

        const minDeltaY = Math.max(...session.startCorners.map((p) => -p.y));
        const maxDeltaY = Math.min(...session.startCorners.map((p) => scan.source.height - p.y));
        const clampedDeltaY = Math.max(minDeltaY, Math.min(maxDeltaY, deltaY));

        setCorners(session.startCorners.map((point) => ({
          x: point.x + clampedDeltaX,
          y: point.y + clampedDeltaY
        })));
      }
    }

    function handlePointerEnd(event: PointerEvent) {
      const session = dragSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      dragSessionRef.current = null;
      setActiveDragTarget(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [activeDragTarget, scan]);

  function handleCancel() {
    if (processedFiles.length === 0) {
      onCancel();
      return;
    }
    const keepProcessed = window.confirm(`Ya has corregido ${processedFiles.length} ${processedFiles.length === 1 ? "imagen" : "imágenes"}. Pulsa Aceptar para conservarlas o Cancelar para descartar todo el lote.`);
    if (keepProcessed) onComplete(processedFiles);
    else onCancel();
  }

  function startDrag(target: ScannerDragTarget, event: ReactPointerEvent) {
    if (!scan || isProcessing) return;
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    dragSessionRef.current = {
      boundsHeight: bounds.height,
      boundsWidth: bounds.width,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCorners: corners,
      target
    };
    setActiveDragTarget(target);
  }

  function moveCornerWithKeyboard(index: number, event: ReactKeyboardEvent<SVGCircleElement>) {
    if (!scan || !["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = (event.shiftKey ? 0.02 : 0.005) * Math.max(scan.source.width, scan.source.height);
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    setCorners((current) => current.map((point, pointIndex) => pointIndex === index ? {
      x: Math.max(0, Math.min(scan.source.width, point.x + deltaX)),
      y: Math.max(0, Math.min(scan.source.height, point.y + deltaY))
    } : point));
  }

  function moveEdgeWithKeyboard(edgeIndex: number, event: ReactKeyboardEvent<SVGGElement>) {
    if (!scan || !["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = (event.shiftKey ? 0.02 : 0.005) * Math.max(scan.source.width, scan.source.height);
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const cornerA = edgeIndex;
    const cornerB = (edgeIndex + 1) % 4;

    setCorners((current) => {
      const pA = current[cornerA];
      const pB = current[cornerB];
      if (!pA || !pB) return current;

      const minDeltaX = Math.max(-pA.x, -pB.x);
      const maxDeltaX = Math.min(scan.source.width - pA.x, scan.source.width - pB.x);
      const clampedDeltaX = Math.max(minDeltaX, Math.min(maxDeltaX, deltaX));

      const minDeltaY = Math.max(-pA.y, -pB.y);
      const maxDeltaY = Math.min(scan.source.height - pA.y, scan.source.height - pB.y);
      const clampedDeltaY = Math.max(minDeltaY, Math.min(maxDeltaY, deltaY));

      return current.map((point, index) =>
        index === cornerA || index === cornerB
          ? { x: point.x + clampedDeltaX, y: point.y + clampedDeltaY }
          : point
      );
    });
  }

  function finishFile(file: File) {
    const nextFiles = [...processedFiles, file];
    if (fileIndex >= files.length - 1) {
      onComplete(nextFiles);
      return;
    }
    setProcessedFiles(nextFiles);
    setFileIndex((current) => current + 1);
  }

  async function applyScan() {
    if (!scan || !currentFile || corners.length !== 4) return;
    setIsProcessing(true);
    setError(null);
    try {
      finishFile(await renderDocumentScan(scan.source, corners, currentFile.name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo corregir la imagen.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function rotate(direction: -1 | 1) {
    if (!scan) return;
    setIsProcessing(true);
    setError(null);
    try {
      const rotated = await rotateDocumentCanvas(scan.source, direction);
      setScan(rotated);
      setCorners(rotated.corners);
      setPreviewUrl(scanPreviewUrl(rotated));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo girar la imagen.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function resetCorners() {
    if (!scan) return;
    setIsProcessing(true);
    setError(null);
    try {
      const analyzed = await analyzeDocumentCanvas(scan.source);
      setScan(analyzed);
      setCorners(analyzed.corners);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo volver a detectar la página.");
    } finally {
      setIsProcessing(false);
    }
  }

  const polygonPoints = corners.map((point) => `${point.x},${point.y}`).join(" ");
  const baseDimension = scan ? Math.max(scan.source.width, scan.source.height) : 1000;
  const cornerRadius = baseDimension * 0.018;
  const edgeHitboxWidth = Math.max(28, baseDimension * 0.055);
  const edgePillWidth = Math.max(36, baseDimension * 0.046);
  const edgePillHeight = Math.max(14, baseDimension * 0.018);
  const edgePillRadius = edgePillHeight / 2;

  const edges = corners.length === 4 ? [
    { cornerA: 0, cornerB: 1, edgeIndex: 0, label: "Borde superior" },
    { cornerA: 1, cornerB: 2, edgeIndex: 1, label: "Borde derecho" },
    { cornerA: 2, cornerB: 3, edgeIndex: 2, label: "Borde inferior" },
    { cornerA: 3, cornerB: 0, edgeIndex: 3, label: "Borde izquierdo" }
  ] : [];

  return createPortal(
    <div className="camera-capture-backdrop document-scanner-backdrop" role="presentation">
      <div aria-label="Corregir imagen antes del OCR" aria-modal="true" className="document-scanner-modal" ref={modalRef} role="dialog" tabIndex={-1}>
        <header className="document-scanner-header">
          <div>
            <p className="eyebrow">Escáner automático</p>
            <h3>Ajusta los bordes de la página</h3>
            <p className="helper-text">Imagen {fileIndex + 1} de {files.length}: {currentFile?.name}</p>
          </div>
          <button aria-label="Cancelar escaneo" className="secondary-button document-scanner-close" disabled={isProcessing} onClick={handleCancel} type="button">
            Cerrar
          </button>
        </header>

        <div className="document-scanner-workspace">
          {previewUrl && scan ? (
            <div className="document-scanner-stage">
              <img alt="Página pendiente de corregir" draggable={false} src={previewUrl} />
              <svg
                aria-label="Marco de la página. Arrastra las esquinas, los bordes o el interior para ajustarlo."
                className="document-scanner-overlay"
                ref={overlayRef}
                role="group"
                viewBox={`0 0 ${scan.source.width} ${scan.source.height}`}
              >
                <path
                  className="document-scanner-mask"
                  d={`M 0 0 H ${scan.source.width} V ${scan.source.height} H 0 Z M ${corners.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`}
                  fillRule="evenodd"
                />
                <polygon
                  aria-label="Marco completo. Arrastra con el dedo o ratón para mover toda la selección."
                  className={`document-scanner-polygon${activeDragTarget?.type === "polygon" ? " is-active" : ""}`}
                  onPointerDown={(event) => startDrag({ type: "polygon" }, event)}
                  points={polygonPoints}
                  role="button"
                  tabIndex={-1}
                />
                {edges.map((edge) => {
                  const pA = corners[edge.cornerA];
                  const pB = corners[edge.cornerB];
                  if (!pA || !pB) return null;
                  const midX = (pA.x + pB.x) / 2;
                  const midY = (pA.y + pB.y) / 2;
                  const angle = Math.atan2(pB.y - pA.y, pB.x - pA.x) * (180 / Math.PI);
                  const isEdgeActive = activeDragTarget?.type === "edge" && activeDragTarget.edgeIndex === edge.edgeIndex;

                  return (
                    <g key={edge.edgeIndex}>
                      <line
                        aria-hidden="true"
                        className="document-scanner-edge-hitbox"
                        onPointerDown={(event) => startDrag({ cornerA: edge.cornerA, cornerB: edge.cornerB, edgeIndex: edge.edgeIndex, type: "edge" }, event)}
                        strokeWidth={edgeHitboxWidth}
                        x1={pA.x}
                        x2={pB.x}
                        y1={pA.y}
                        y2={pB.y}
                      />
                      <g
                        aria-label={`${edge.label}. Usa las flechas para ajustar; mantén Mayúsculas para mover más rápido.`}
                        className={`document-scanner-edge-handle${isEdgeActive ? " is-active" : ""}`}
                        onKeyDown={(event) => moveEdgeWithKeyboard(edge.edgeIndex, event)}
                        onPointerDown={(event) => startDrag({ cornerA: edge.cornerA, cornerB: edge.cornerB, edgeIndex: edge.edgeIndex, type: "edge" }, event)}
                        role="button"
                        tabIndex={0}
                        transform={`translate(${midX} ${midY}) rotate(${angle})`}
                      >
                        <rect
                          className="document-scanner-edge-pill"
                          height={edgePillHeight}
                          rx={edgePillRadius}
                          ry={edgePillRadius}
                          width={edgePillWidth}
                          x={-edgePillWidth / 2}
                          y={-edgePillHeight / 2}
                        />
                        <line
                          className="document-scanner-edge-pill-line"
                          x1={-edgePillWidth * 0.18}
                          x2={edgePillWidth * 0.18}
                          y1={0}
                          y2={0}
                        />
                      </g>
                    </g>
                  );
                })}
                {corners.map((point, index) => {
                  const isCornerActive = activeDragTarget?.type === "corner" && activeDragTarget.cornerIndex === index;
                  return (
                    <circle
                      aria-label={`Esquina ${index + 1}. Usa las flechas para ajustar; mantén Mayúsculas para mover más rápido.`}
                      className={`document-scanner-handle${isCornerActive ? " is-active" : ""}`}
                      cx={point.x}
                      cy={point.y}
                      key={index}
                      onKeyDown={(event) => moveCornerWithKeyboard(index, event)}
                      onPointerDown={(event) => startDrag({ cornerIndex: index, type: "corner" }, event)}
                      r={cornerRadius}
                      role="button"
                      tabIndex={0}
                    />
                  );
                })}
              </svg>
            </div>
          ) : (
            <div aria-live="polite" className="document-scanner-loading">
              <span className="review-processing-spinner" />
              <strong>{error ? "No se pudo preparar el escáner" : "Detectando la página..."}</strong>
            </div>
          )}
        </div>

        {scan ? (
          <div className="document-scanner-status" aria-live="polite">
            <p className={scan.detected ? "document-scanner-detection success" : "document-scanner-detection warning"}>
              {scan.detected
                ? "Página detectada. Revisa las cuatro esquinas antes de continuar."
                : "No se encontró un borde claro. Ajusta manualmente las cuatro esquinas."}
            </p>
            {scan.issues.map((issue) => <p className="document-scanner-quality-warning" key={issue}>{qualityIssueLabels[issue]}</p>)}
          </div>
        ) : null}
        {error ? <p className="error-text">{error}</p> : null}

        <footer className="document-scanner-actions">
          <button className="secondary-button" disabled={!currentFile || isProcessing} onClick={() => currentFile && finishFile(currentFile)} type="button">
            Usar original
          </button>
          <button className="primary-button" disabled={!scan || corners.length !== 4 || isProcessing} onClick={() => void applyScan()} type="button">
            {isProcessing ? "Procesando..." : fileIndex < files.length - 1 ? "Corregir y revisar siguiente" : "Corregir y usar imagen"}
          </button>
        </footer>

        <div className="document-scanner-toolbar" role="toolbar" aria-label="Controles del escáner">
          <button className="secondary-button" disabled={!scan || isProcessing} onClick={() => void rotate(-1)} type="button">Girar izquierda</button>
          <button className="secondary-button" disabled={!scan || isProcessing} onClick={() => void rotate(1)} type="button">Girar derecha</button>
          <button className="secondary-button" disabled={!scan || isProcessing} onClick={() => void resetCorners()} type="button">Restablecer marco</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
