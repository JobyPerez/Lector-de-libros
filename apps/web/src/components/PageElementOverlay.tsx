import { useRef, useState, type PointerEvent } from "react";
import type { PageElementGeometry } from "../app/api";
import "../features/book-builder/page-element-overlay.css";

export function validElementGeometry(geometry: PageElementGeometry | null | undefined): geometry is PageElementGeometry {
  if (!geometry?.bbox) return false;
  const { left, top, width, height } = geometry.bbox;
  return [left, top, width, height].every(Number.isFinite) && left >= 0 && top >= 0 && width > 0 && height > 0 && left + width <= 1 && top + height <= 1;
}

export function PageElementOverlay({ imageSrc, elements, selectedKey, selectedKeys, onSelect, onGeometryChange, onCreateGeometry, onDrawingChange, marking = false, disabled = false }: {
  imageSrc: string;
  elements: { key: string; text: string; number?: number; active?: boolean; geometry?: PageElementGeometry | null | undefined }[];
  selectedKey: string | null;
  selectedKeys?: readonly string[];
  onSelect: (key: string, modifiers?: { ctrlKey: boolean; metaKey: boolean }) => void;
  onGeometryChange?: (key: string, geometry: PageElementGeometry) => void;
  onCreateGeometry?: (geometry: PageElementGeometry) => void;
  onDrawingChange?: (drawing: boolean) => void;
  marking?: boolean;
  disabled?: boolean;
}) {
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [draft, setDraft] = useState<PageElementGeometry | null>(null);
  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function rectangle(event: PointerEvent<HTMLDivElement>) {
    const end = point(event);
    const origin = start.current!;
    return { bbox: { left: Math.min(origin.x, end.x), top: Math.min(origin.y, end.y), width: Math.abs(end.x - origin.x), height: Math.abs(end.y - origin.y) } };
  }
  function style(geometry: PageElementGeometry) {
    const { left, top, width, height } = geometry.bbox;
    return { left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` };
  }
  return <div className={`page-element-overlay${marking && !disabled ? " is-marking" : ""}`}
    onPointerDown={(event) => {
      if (!marking || disabled || (!onCreateGeometry && (!selectedKey || !onGeometryChange)) || event.button !== 0) return;
      event.preventDefault();
      start.current = { ...point(event), pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraft(null);
      onDrawingChange?.(true);
    }}
    onPointerMove={(event) => { if (start.current?.pointerId === event.pointerId) setDraft(rectangle(event)); }}
    onPointerUp={(event) => {
      if (start.current?.pointerId !== event.pointerId) return;
      const geometry = rectangle(event);
      start.current = null;
      setDraft(null);
      onDrawingChange?.(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (!disabled && marking && validElementGeometry(geometry)) {
        if (onCreateGeometry) onCreateGeometry(geometry);
        else if (selectedKey) onGeometryChange?.(selectedKey, geometry);
      }
    }}
    onPointerCancel={() => { start.current = null; setDraft(null); onDrawingChange?.(false); }}
    onLostPointerCapture={() => { start.current = null; setDraft(null); onDrawingChange?.(false); }}>
    <img src={imageSrc} alt="Original de la pagina con zonas de elementos" draggable={false} />
    {!disabled && elements.map((element, index) => validElementGeometry(element.geometry) ? <button type="button" key={element.key}
      className={`page-element-zone${selectedKey === element.key || selectedKeys?.includes(element.key) ? " is-selected" : ""}${element.active === false ? " is-inactive" : ""}`} style={style(element.geometry)}
      aria-label={`Seleccionar elemento ${element.number ?? index + 1}${element.active === false ? " anulado" : ""}: ${element.text.slice(0, 80)}`} aria-pressed={selectedKey === element.key || (selectedKeys?.includes(element.key) ?? false)}
      disabled={marking} onClick={(event) => onSelect(element.key, { ctrlKey: event.ctrlKey, metaKey: event.metaKey })}><span>{element.number ?? index + 1}</span></button> : null)}
    {!disabled && marking && draft ? <div className="page-element-zone is-selected" style={style(draft)} /> : null}
  </div>;
}
