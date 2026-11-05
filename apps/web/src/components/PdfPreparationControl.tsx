import { useEffect, useRef, useState } from "react";
import { preparePdfPage, type BookPageResponse } from "../app/api";

export function PdfPreparationControl({ accessToken, bookId, page, disabled, onPrepared, onBusyChange }: {
  accessToken: string; bookId: string; page: BookPageResponse["page"]; disabled: boolean;
  onPrepared: () => void | Promise<void>; onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [physical, setPhysical] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function prepare() {
    if (disabled || running.current) return;
    const number = physical.trim() ? Number(physical) : undefined;
    if (number !== undefined && (!Number.isInteger(number) || number < 1)) { setError("Indica un número físico de página válido."); return; }
    running.current = true;
    setBusy(true); setError(null); setMessage(null); onBusyChange?.(true);
    try {
      const result = await preparePdfPage(accessToken, bookId, page.pageNumber, page.pageId, page.updatedAt, number);
      if (!active.current) return;
      setMessage(`Hoja ${result.sourcePdfPageNumber} vinculada; ${result.preparedElements} bloques con zona. Texto y anotaciones conservados.`);
      await onPrepared();
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "No se pudo preparar el PDF.");
    } finally {
      running.current = false;
      onBusyChange?.(false);
      if (active.current) setBusy(false);
    }
  }
  return <section aria-label="Preparación de bloques PDF">
    <p className="helper-text">Original PDF intacto. La detección de zonas y tipos es automática y se puede corregir. Guarda tus cambios antes de preparar los bloques.</p>
    <div className="visual-actions">
      {!page.sourcePdfPageNumber ? <label>Hoja física del PDF (opcional)
        <input type="number" min="1" max="999999" value={physical} placeholder="Detección automática" disabled={busy || disabled} onChange={(event) => setPhysical(event.target.value)} />
      </label> : <span>Hoja original: {page.sourcePdfPageNumber}</span>}
      <button className="secondary-button" type="button" disabled={busy || disabled} onClick={() => void prepare()}>{busy ? "Preparando bloques PDF..." : "Preparar bloques del PDF"}</button>
    </div>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
