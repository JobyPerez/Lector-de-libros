import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fetchBookPage, fetchBookPageImage, saveVisualPageDocument, type BookGalleryPage, type BookPageResponse, type VisualPageDocument } from "../../app/api";
import { VisualPageEditor } from "../book-builder/VisualPageEditor";
import { validElementGeometry } from "../../components/PageElementOverlay";
import { confirmUnsavedChanges } from "../../components/confirmUnsavedChanges";
import { normalizeVisualDocument, pushVisualHistory, redoVisualHistory, undoVisualHistory, visualDocumentFromPage, visualDocumentSaveError, type VisualHistory } from "../book-builder/visual-page";
import "./gallery-page-editor.css";

export type GalleryPageEditorExit = {
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  unavailableReason: string;
  save: () => Promise<boolean>;
};

export type GalleryPageEditorProps = {
  accessToken: string;
  bookId: string;
  page: BookGalleryPage;
  initialBlockId?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onPendingChange: (pending: boolean) => void;
  onExitChange?: (exit: GalleryPageEditorExit | null) => void;
};

function GalleryDialog({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const parentDialog = document.querySelector("dialog[open]");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { scrollX, scrollY } = window;
    const root = document.documentElement;
    const { overflow, scrollbarGutter } = root.style;
    root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    dialog?.showModal();
    dialog?.focus({ preventScroll: true });
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    return () => {
      dialog?.close();
      root.style.overflow = overflow;
      root.style.scrollbarGutter = scrollbarGutter;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      // Nested inspectors also restore scroll locks during unmount; finish after their cleanup.
      if (!parentDialog) queueMicrotask(() => {
        if (document.querySelector("dialog[open]")) return;
        root.style.overflow = overflow;
        root.style.scrollbarGutter = scrollbarGutter;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      });
    };
  }, []);
  return createPortal(<dialog ref={ref} tabIndex={-1} className="visual-dialog gallery-page-editor" aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><div className="visual-actions">{actions}<button type="button" onClick={onClose}>Cerrar</button></div></header>
    {children}
  </dialog>, document.body);
}

export function GalleryPageEditor(props: GalleryPageEditorProps) {
  return <GalleryPageEditorSession key={`${props.bookId}:${props.page.pageId}:${props.accessToken}`} {...props} />;
}

function GalleryPageEditorSession({ accessToken, bookId, page, initialBlockId, onClose, onSaved, onPendingChange, onExitChange }: GalleryPageEditorProps) {
  const [loadedPage, setLoadedPage] = useState<BookPageResponse["page"] | null>(null);
  const [savedDocument, setSavedDocument] = useState<VisualPageDocument | null>(null);
  const [history, setHistory] = useState<VisualHistory | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [reload, setReload] = useState(0);
  const [amplified, setAmplified] = useState<{ src: string; alt: string } | null>(null);
  const alive = useRef(false);
  const savingRef = useRef(false);
  const confirmingRef = useRef(false);
  const initialPageNumber = useRef(page.pageNumber);
  const dirty = Boolean(history && savedDocument && JSON.stringify(history.present) !== JSON.stringify(savedDocument));
  // Share the gallery's navigation blocker; React Router supports only one blocker.
  const pending = dirty || interacting || saving || loading;
  useEffect(() => { onPendingChange(pending); return () => onPendingChange(false); }, [pending, onPendingChange]);
  const exit: GalleryPageEditorExit = {
    dirty,
    get busy() { return interacting || savingRef.current || loading; },
    canSave: dirty && !!history && !!loadedPage && !interacting && !saving && !loading && !conflict,
    unavailableReason: conflict ? "La pagina ha cambiado en el servidor. Recarga antes de guardar." : "Termina la operacion en curso antes de salir.",
    save
  };
  const exitRef = useRef(exit);
  exitRef.current = exit;
  useEffect(() => { onExitChange?.(exit); });
  useEffect(() => () => onExitChange?.(null), [onExitChange]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setMessage(null);
    setImageError(null);
    setSourceImage(null);
    setConflict(false);
    void (async () => {
      try {
        const response = await fetchBookPage(accessToken, bookId, initialPageNumber.current, { includeInactive: true, pageId: page.pageId });
        if (!active) return;
        if (response.page.pageId !== page.pageId) throw new Error("La identidad de la pagina recibida no coincide.");
        const doc = normalizeVisualDocument(visualDocumentFromPage(response.page));
        if (response.page.hasSourceImage) {
          try {
            const blob = await fetchBookPageImage(accessToken, bookId, response.page.pageNumber, response.page.updatedAt, false, page.pageId);
            if (!active) return;
            objectUrl = URL.createObjectURL(blob);
            setSourceImage(objectUrl);
          } catch (cause) {
            if (!active) return;
            setImageError(cause instanceof Error ? cause.message : "No se pudo cargar la imagen original.");
          }
        }
        if (!active) return;
        setLoadedPage(response.page);
        setSavedDocument(doc);
        setHistory({ past: [], present: doc, future: [] });
        setSelectedId(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "No se pudo cargar la pagina.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [accessToken, bookId, page.pageId, reload]);

  async function confirmExit() {
    if (savingRef.current || exitRef.current.busy || confirmingRef.current) return false;
    if (!exitRef.current.dirty) return true;
    confirmingRef.current = true;
    try {
      const allowed = await confirmUnsavedChanges({
        save: () => exitRef.current.save(),
        canSave: exitRef.current.canSave,
        message: "Tienes cambios sin guardar en esta pagina.",
        unavailableReason: exitRef.current.unavailableReason
      });
      return allowed && alive.current && !savingRef.current && !exitRef.current.busy;
    } finally { confirmingRef.current = false; }
  }
  async function close() {
    if (await confirmExit()) onClose();
  }
  async function reloadPage() {
    if (!await confirmExit()) return;
    setHistory(null);
    setSavedDocument(null);
    setLoadedPage(null);
    setReload((value) => value + 1);
  }
  async function save(): Promise<boolean> {
    if (!history || !loadedPage || !dirty || interacting || conflict || savingRef.current) return false;
    const validationError = visualDocumentSaveError(history.present);
    if (validationError) { setError(validationError); return false; }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveVisualPageDocument(accessToken, bookId, loadedPage.pageNumber, {
        expectedUpdatedAt: loadedPage.updatedAt, document: history.present
      }, loadedPage.pageId);
      if (!alive.current) return true;
      setSavedDocument(result.document);
      setHistory({ past: [], present: result.document, future: [] });
      setLoadedPage({ ...loadedPage, updatedAt: result.updatedAt, visualDocument: result.document });
      setMessage("Los cambios se guardaron correctamente.");
      try { await onSaved(); } catch (cause) {
        if (alive.current) setError(`Los cambios se guardaron, pero no se pudo actualizar la galeria: ${cause instanceof Error ? cause.message : "Error inesperado."}`);
      }
      return true;
    } catch (cause) {
      if (!alive.current) return false;
      if (cause instanceof Error && "statusCode" in cause && cause.statusCode === 409) {
        setConflict(true);
        setError("La pagina ha cambiado en el servidor. Tu borrador se conserva. Recarga la pagina para editar la version actual; se pedira confirmacion antes de descartar los cambios.");
      } else setError(cause instanceof Error ? cause.message : "No se pudieron guardar los cambios.");
      return false;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }
  return <GalleryDialog title={`Editar pagina ${page.pageLabel ?? page.pageNumber}`} onClose={close} actions={<>
    <button type="button" disabled={saving || loading || interacting} onClick={reloadPage}>Recargar pagina</button>
    <button type="button" disabled={saving || loading || interacting || conflict || !dirty} onClick={() => void save()}>{saving ? "Guardando..." : "Guardar cambios"}</button>
  </>}>
    {loading ? <p role="status">Cargando pagina...</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {imageError ? <p role="alert" className="error-text">{imageError} La edicion de zonas no esta disponible.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading && sourceImage && history && !history.present.blocks.some((block) => validElementGeometry(block.geometry)) ? <p className="helper-text">Esta pagina no tiene zonas detectadas. Puedes editar los bloques en la previsualizacion o marcar una zona en el original.</p> : null}
    {!loading && loadedPage && history && savedDocument ? <VisualPageEditor key={reload}
      doc={history.present} page={loadedPage} savedDocument={savedDocument} selectedId={selectedId} onSelect={setSelectedId}
      {...(initialBlockId ? { initialEditId: initialBlockId } : {})} simpleTypography accessToken={accessToken} bookId={bookId}
      sourceImage={sourceImage} source={(overlay) => overlay}
      disabled={saving || conflict} geometryDisabled={!sourceImage || saving || conflict}
      onChange={(doc) => { setHistory((current) => current ? pushVisualHistory(current, doc) : current); setMessage(null); setError(null); }}
      canUndo={history.past.length > 0 && !interacting} canRedo={history.future.length > 0 && !interacting}
      onUndo={() => { if (!interacting) setHistory((current) => current ? undoVisualHistory(current) : current); }}
      onRedo={() => { if (!interacting) setHistory((current) => current ? redoVisualHistory(current) : current); }}
      onInteractionChange={setInteracting} onAmplify={setAmplified} /> : null}
    <footer className="gallery-page-editor-footer">
      <span role="status">{dirty ? "Cambios sin guardar" : "Sin cambios pendientes"}</span>
    </footer>
    {amplified ? <GalleryDialog title="Imagen ampliada" onClose={() => setAmplified(null)}><img className="gallery-page-editor-image" src={amplified.src} alt={amplified.alt} /></GalleryDialog> : null}
  </GalleryDialog>;
}
