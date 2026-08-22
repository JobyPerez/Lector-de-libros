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

export function DocumentScannerModal({ files, onCancel, onComplete }: DocumentScannerModalProps) {
  const [fileIndex, setFileIndex] = useState(0);
  const [processedFiles, setProcessedFiles] = useState<File[]>([]);
  const [scan, setScan] = useState<PreparedDocumentScan | null>(null);
  const [corners, setCorners] = useState<ScanPoint[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [draggedCorner, setDraggedCorner] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
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

  function handleCancel() {
    if (processedFiles.length === 0) {
      onCancel();
      return;
    }
    const keepProcessed = window.confirm(`Ya has corregido ${processedFiles.length} ${processedFiles.length === 1 ? "imagen" : "imágenes"}. Pulsa Aceptar para conservarlas o Cancelar para descartar todo el lote.`);
    if (keepProcessed) onComplete(processedFiles);
    else onCancel();
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

  function updateDraggedCorner(event: ReactPointerEvent<SVGSVGElement>) {
    if (draggedCorner === null || !scan) return;
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

    const nextPoint = {
      x: Math.max(0, Math.min(scan.source.width, ((event.clientX - bounds.left) / bounds.width) * scan.source.width)),
      y: Math.max(0, Math.min(scan.source.height, ((event.clientY - bounds.top) / bounds.height) * scan.source.height))
    };
    setCorners((current) => current.map((point, index) => index === draggedCorner ? nextPoint : point));
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
                aria-label="Marco de la página. Arrastra sus cuatro esquinas para ajustarlo."
                className="document-scanner-overlay"
                onPointerCancel={() => setDraggedCorner(null)}
                onPointerMove={updateDraggedCorner}
                onPointerUp={() => setDraggedCorner(null)}
                ref={overlayRef}
                role="group"
                viewBox={`0 0 ${scan.source.width} ${scan.source.height}`}
              >
                <path
                  className="document-scanner-mask"
                  d={`M 0 0 H ${scan.source.width} V ${scan.source.height} H 0 Z M ${corners.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`}
                  fillRule="evenodd"
                />
                <polygon className="document-scanner-polygon" points={polygonPoints} />
                {corners.map((point, index) => (
                  <circle
                    aria-label={`Esquina ${index + 1}. Usa las flechas para ajustar; mantén Mayúsculas para mover más rápido.`}
                    className="document-scanner-handle"
                    cx={point.x}
                    cy={point.y}
                    key={index}
                    onKeyDown={(event) => moveCornerWithKeyboard(index, event)}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDraggedCorner(index);
                    }}
                    r={Math.max(scan.source.width, scan.source.height) * 0.018}
                    role="button"
                    tabIndex={0}
                  />
                ))}
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
