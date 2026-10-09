import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useBlocker, useParams, useSearchParams } from "react-router-dom";
import { deleteBookPage, fetchBook, fetchBookOutline, fetchBookPage, fetchBookPageImage, fetchBookPages, fetchBookPagesOcrJob, isBookEditor, reorderBookPages, startBookPagesOcrJob, updateBookPagesOcrJob, type BookGalleryPage, type BookOutlineEntry, type BookPagesResponse, type ImageOcrMode } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { confirmUnsavedChanges } from "../../components/confirmUnsavedChanges";
import { registerPendingNavigation } from "../../hooks/useUnsavedChanges";
import { AdvancedLayoutCheckbox, OcrModelSelect, OcrPromptEditor, defaultOcrMode, normalizeOcrOptions, useOcrModelSelection, usesOcrModel } from "../../components/OcrConfig";
import { movePages, selectPageRange } from "./page-order";
import { groupPagesByOutline, type GalleryOutlineNode } from "./outline-groups";
import { filterTocByMaxLevel, useTocMaxLevel } from "../../app/toc-level";
import { TocLevelSelector } from "../../components/TocLevelSelector";
import { GalleryPageEditor, type GalleryPageEditorExit } from "./GalleryPageEditor";
import "./book-pages.css";

// Keep immutable identity across the redirect, even if order changes after this listing.
export function GalleryPageDestination() {
  const { bookId = "", pageId = "", action } = useParams();
  const [searchParams] = useSearchParams();
  const galleryHref = `/books/${bookId}/pages${searchParams.size ? `?${searchParams}` : ""}`;
  const accessToken = useAuthStore((state) => state.accessToken) ?? "";
  const query = useQuery({ queryKey: ["book-pages", bookId], queryFn: () => fetchBookPages(accessToken, bookId), enabled: !!accessToken, refetchOnMount: "always" });
  if (query.isFetching || query.isPending) return <section className="panel" role="status">Abriendo página...</section>;
  const page = query.data?.pages.find((entry) => entry.pageId === pageId);
  if (query.isError || !page || (action === "edit" && !page.capabilities.edit)) return <section className="panel"><p className="error-text" role="alert">{query.error?.message ?? "Esta página ya no está disponible o no tienes permiso para editarla."}</p><Link className="secondary-button" to={galleryHref}>Volver a la galería</Link></section>;
  const to = action === "edit"
    ? `/builder?reviewBookId=${encodeURIComponent(bookId)}&reviewPage=${page.pageNumber}&reviewPageId=${encodeURIComponent(page.pageId)}#review-ocr`
    : `/books/${bookId}?page=${page.pageNumber}&pageId=${encodeURIComponent(page.pageId)}`;
  return <Navigate replace to={to} state={{ returnTo: galleryHref }} />;
}

function PagePreview({ page, bookId, accessToken, image }: { page: BookGalleryPage; bookId: string; accessToken: string; image: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");
  useEffect(() => {
    if ((!image || page.preview.kind !== "IMAGE") && page.preview.text.trim()) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [image, page.preview.kind, page.preview.text]);
  const imageQuery = useQuery({
    queryKey: ["book-page-image", bookId, page.pageId, page.updatedAt, "thumbnail"],
    queryFn: () => fetchBookPageImage(accessToken, bookId, page.pageNumber, page.updatedAt, false, page.pageId, true),
    enabled: visible && image && page.preview.kind === "IMAGE",
    staleTime: 60_000
  });
  const contentQuery = useQuery({
    queryKey: ["book-page", bookId, page.pageNumber, "gallery", page.pageId, page.updatedAt],
    queryFn: () => fetchBookPage(accessToken, bookId, page.pageNumber, { pageId: page.pageId }),
    enabled: visible && !(image && page.preview.kind === "IMAGE") && !page.preview.text.trim(),
    staleTime: 60_000
  });
  const content = contentQuery.data?.page;
  const text = page.preview.text || content?.paragraphs.map((paragraph) => paragraph.paragraphText).join("\n\n") || content?.editedText || content?.rawText;
  useEffect(() => {
    if (!imageQuery.data) { setUrl(""); return; }
    const next = URL.createObjectURL(imageQuery.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [imageQuery.data]);
  return <div className="gallery-preview" ref={ref}>
    {image && page.preview.kind === "IMAGE" ? url ? <img src={url} alt={`Vista previa de página ${page.pageNumber}`} loading="lazy" />
      : imageQuery.isError ? <button className="secondary-button" onClick={() => void imageQuery.refetch()}>Reintentar imagen</button>
      : <span className="subdued">Cargando imagen...</span>
      : contentQuery.isError ? <button className="secondary-button" onClick={() => void contentQuery.refetch()}>Reintentar contenido</button>
      : <p>{text || (contentQuery.isFetching ? "Cargando contenido..." : "Sin texto disponible")}</p>}
  </div>;
}

export function BookPagesGallery() {
  const { bookId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const originPageId = searchParams.get("pageId") ?? "";
  const originPageNumber = Number(searchParams.get("page"));
  const galleryPath = `/books/${bookId}/pages`;
  const gallerySearch = searchParams.size ? `?${searchParams}` : "";
  const galleryHref = `${galleryPath}${gallerySearch}`;
  const originCardRef = useRef<HTMLElement | null>(null);
  const scrolledOriginRef = useRef("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const update = () => setShowScrollTop(window.scrollY > 320);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  const [previewSize, setPreviewSize] = useState("normal");
  const [showOutline, setShowOutline] = useState(false);
  const [tocMaxLevel, setTocMaxLevel] = useTocMaxLevel(bookId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ page: BookGalleryPage; blockId?: string } | null>(null);
  const [editingDirty, setEditingDirty] = useState(false);
  const editorExitRef = useRef<GalleryPageEditorExit | null>(null);
  const [editorExit, setEditorExit] = useState<GalleryPageEditorExit | null>(null);
  const [registerEditorExit] = useState(() => (exit: GalleryPageEditorExit | null) => {
    editorExitRef.current = exit;
    setEditorExit((current) => current?.dirty === exit?.dirty && current?.busy === exit?.busy && current?.canSave === exit?.canSave && current?.unavailableReason === exit?.unavailableReason ? current : exit);
  });
  const accessToken = useAuthStore((state) => state.accessToken) ?? "";
  const client = useQueryClient();
  const userId = useAuthStore((state) => state.user?.userId) ?? "";
  const jobStorageKey = `lector:gallery-ocr:${userId}:${bookId}`;
  const [jobId, setJobId] = useState(() => { try { return localStorage.getItem(jobStorageKey) ?? ""; } catch { return ""; } });
  useEffect(() => { try { setJobId(localStorage.getItem(jobStorageKey) ?? ""); } catch { setJobId(""); } }, [jobStorageKey]);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [baseline, setBaseline] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [position, setPosition] = useState<"before" | "after">("before");
  const [dragIds, setDragIds] = useState<Set<string> | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const confirmingRef = useRef(false);
  const [orderConflict, setOrderConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ocrMode, setOcrMode] = useState<ImageOcrMode>(defaultOcrMode);
  const [advancedLayout, setAdvancedLayout] = useState(false);
  const [promptOverride, setPromptOverride] = useState("");
  const { models, selectedModelId, selectedModel, setSelectedModelId, canRunOcr, compatibilityMessage } = useOcrModelSelection(`gallery:${bookId}`);
  const pagesQuery = useQuery({ queryKey: ["book-pages", bookId], queryFn: () => fetchBookPages(accessToken, bookId), enabled: !!accessToken });
  const bookQuery = useQuery({ queryKey: ["book", bookId], queryFn: () => fetchBook(accessToken, bookId), enabled: !!accessToken });
  const outlineQuery = useQuery({ queryKey: ["book-outline", bookId], queryFn: () => fetchBookOutline(accessToken, bookId), enabled: !!accessToken && showOutline });
  const data = pagesQuery.data;
  const book = bookQuery.data?.book;
  const persisted = data?.pages.map((page) => page.pageId) ?? [];
  const order = draft ?? persisted;
  const dirty = draft !== null && draft.join(",") !== baseline.join(",");
  const canEdit = isBookEditor(book?.currentUserRole);
  const isImages = book?.sourceType === "IMAGES";
  const jobsQuery = useQuery({
    queryKey: ["book-pages-ocr-job", bookId, jobId], queryFn: () => fetchBookPagesOcrJob(accessToken, bookId, jobId),
    enabled: !!accessToken && canEdit && isImages && !!jobId,
    refetchInterval: (query) => !query.state.data || query.state.data.status === "PENDING" || query.state.data.status === "RUNNING" ? 2000 : false
  });
  const jobs = jobId && jobsQuery.data ? [jobsQuery.data] : [];
  const activeJob = canEdit && isImages && !!jobId && (!jobsQuery.data || jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING"));
  const orderChanged = dirty && persisted.join(",") !== baseline.join(",");
  const exitOptions = {
    save: saveBeforeExit,
    canSave: !busy && !editorExit?.busy && (!dirty || canEdit && !!data?.capabilities.reorder && !activeJob && !orderConflict && !orderChanged) && (!editingDirty || !!editorExit?.canSave),
    message: "Tienes cambios sin guardar en la galeria.",
    unavailableReason: orderConflict || orderChanged ? "El orden ha cambiado en el servidor. Cancela el borrador antes de reorganizar." : editorExit?.unavailableReason ?? "No se pueden guardar los cambios durante la operacion actual."
  };
  const navigationRef = useRef({ dirty, editingDirty, exitOptions, saveOrder });
  navigationRef.current = { dirty, editingDirty, exitOptions, saveOrder };
  // Own the only router blocker so busy operations cannot be discarded via the dialog.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || busy || editingDirty) && (
    currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash
  ));
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const galleryAlive = useRef(false);
  useEffect(() => {
    galleryAlive.current = true;
    return () => { galleryAlive.current = false; };
  }, []);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirmExit().then((allowed) => {
      const pending = blockerRef.current;
      if (!galleryAlive.current || pending.state !== "blocked") return;
      if (allowed) pending.proceed(); else pending.reset();
    });
  }, [blocker.state, blocker.location?.key]);
  useEffect(() => registerPendingNavigation(() => confirmExit()), []);
  useEffect(() => {
    if (!dirty && !busy && !editingDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy, editingDirty]);
  const jobPageStatuses = new Map(jobs.flatMap((job) => job.pages.map((page) => [page.pageId, page.status] as const)));
  const pendingOcrPageIds = data?.pages.filter((page) => page.capabilities.ocr && (jobPageStatuses.get(page.pageId) ?? page.ocrStatus) === "PENDING").map((page) => page.pageId) ?? [];
  const failedOcrPageIds = data?.pages.filter((page) => page.capabilities.ocr && (jobPageStatuses.get(page.pageId) ?? page.ocrStatus) === "FAILED").map((page) => page.pageId) ?? [];
  const terminalJobs = jobs.filter((job) => job.status === "READY" || job.status === "FAILED" || job.status === "CANCELLED").map((job) => `${job.jobId}:${job.attemptCount}:${job.status}`).join(",");
  useEffect(() => {
    if (terminalJobs) void invalidate();
  }, [terminalJobs]);
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.pages.map((page) => page.pageId));
    setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
  }, [data]);
  async function invalidate() {
    await Promise.all(["book-outline", "book-pages", "book", "books", "builder-books", "book-page", "book-page-image", "reader-annotations", "reader-navigation", "reader-readable-neighbors", "progress", "builder-page-visual", "builder-page-annotations", "builder-navigation", "ai-requests", "section-summary"].map((key) =>
      client.invalidateQueries({ predicate: (query) => query.queryKey[0] === key && (query.queryKey[1] === bookId || key === "books" || key === "builder-books") })));
  }
  function changeOrder(next: string[]) {
    if (!canEdit || !data?.capabilities.reorder || busy || activeJob || next.join(",") === order.join(",")) return;
    if (draft === null) setBaseline(persisted);
    setDraft(next);
    setNotice("Orden modificado. Guarda o cancela los cambios.");
  }
  async function confirmExit(orderOnly = false): Promise<boolean> {
    if (busyRef.current || editorExitRef.current?.busy || confirmingRef.current) return false;
    const current = navigationRef.current;
    if (!current.dirty && (orderOnly || !current.editingDirty)) return true;
    confirmingRef.current = true;
    try {
      const allowed = await confirmUnsavedChanges({ ...current.exitOptions, ...(orderOnly ? { save: () => navigationRef.current.saveOrder(), message: "Tienes cambios sin guardar en el orden de las paginas." } : {}) });
      return allowed && !busyRef.current && !editorExitRef.current?.busy;
    } finally { confirmingRef.current = false; }
  }
  async function saveBeforeExit(): Promise<boolean> {
    if (busyRef.current || editorExitRef.current?.busy) return false;
    if (navigationRef.current.editingDirty && !editorExitRef.current) return false;
    if (editorExitRef.current?.dirty && !await editorExitRef.current.save()) return false;
    return !navigationRef.current.dirty || await navigationRef.current.saveOrder();
  }
  async function saveOrder(): Promise<boolean> {
    if (busyRef.current || !dirty || !canEdit || !data?.capabilities.reorder || activeJob || orderConflict || orderChanged) return false;
    return perform(() => reorderBookPages(accessToken, bookId, { pageIds: order, expectedPageIds: baseline }));
  }
  async function cancelOrder() {
    if (!await confirmExit(true)) return;
    setDraft(null); setOrderConflict(false); setError(""); setNotice("Sin cambios pendientes en el orden.");
  }
  async function perform(action: () => Promise<BookPagesResponse | void>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if (result) { client.setQueryData(["book-pages", bookId], result); setDraft(null); setOrderConflict(false); }
      setNotice("Cambios guardados.");
      try { await invalidate(); } catch (cause) {
        setError(`Los cambios se guardaron, pero no se pudo actualizar la galeria: ${cause instanceof Error ? cause.message : "Error inesperado."}`);
      }
      return true;
    } catch (cause) {
      if (dirty && cause instanceof Error && "statusCode" in cause && cause.statusCode === 409) setOrderConflict(true);
      setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
      try { await invalidate(); } catch { /* Preserve the operation error and draft. */ }
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  function remove(ids: string[]) {
    if (!canEdit || busy || dirty || activeJob || !ids.length || ids.some((id) => !data?.pages.find((page) => page.pageId === id)?.capabilities.delete)) return;
    if (!window.confirm(`¿Eliminar ${ids.length} página(s) y su contenido? Esta acción no se puede deshacer.`)) return;
    void perform(async () => {
      let deleted = 0;
      try {
        for (const id of ids) {
          const page = data?.pages.find((entry) => entry.pageId === id);
          if (!page) throw new Error("La página seleccionada ya no está disponible.");
          await deleteBookPage(accessToken, bookId, page.pageNumber, id);
          deleted++;
        }
      } catch (cause) {
        throw new Error(`${deleted} de ${ids.length} páginas eliminadas. ${cause instanceof Error ? cause.message : "No se pudo completar la eliminación."}`);
      }
    });
  }
  const byId = new Map(data?.pages.map((page) => [page.pageId, page]));
  const fullOutline = outlineQuery.data?.outline ?? [];
  const visibleOutline = filterTocByMaxLevel(fullOutline, tocMaxLevel);
  const grouped = showOutline && !dirty && !!visibleOutline.length;
  const roots = grouped ? groupPagesByOutline(data?.pages ?? [], visibleOutline) : [];
  const subtreePageIds = new Map<string, Set<string>>();
  function indexNode(node: GalleryOutlineNode): Set<string> {
    const ids = new Set<string>();
    for (const group of node.groups) for (const id of group.pageIds) {
      ids.add(id);
    }
    for (const child of node.children) for (const id of indexNode(child)) ids.add(id);
    subtreePageIds.set(node.id, ids);
    return ids;
  }
  for (const root of roots) indexNode(root);
  const originPage = originPageId ? byId.get(originPageId) : data?.pages.find((page) => page.pageNumber === originPageNumber);
  const highlightedPageId = originPageId || originPage?.pageId || "";
  const readerPageNumber = originPage?.pageNumber ?? (Number.isInteger(originPageNumber) && originPageNumber > 0 ? originPageNumber : 1);
  const readerHref = highlightedPageId || originPageNumber > 0
    ? `/books/${bookId}?page=${readerPageNumber}${highlightedPageId ? `&pageId=${encodeURIComponent(highlightedPageId)}` : ""}`
    : `/books/${bookId}`;
  // Añadir páginas solo existe para libros de imágenes, como en la pantalla de edición.
  const canAddPages = canEdit && isImages;
  const insertBlocked = busy || dirty || activeJob;
  const lastOrderPage = order.length ? byId.get(order[order.length - 1]!) : undefined;
  function appendPagesLink(pageNumber: number, side: "before" | "after") {
    return {
      hash: "#append-pages",
      pathname: "/builder",
      search: `?appendBookId=${encodeURIComponent(bookId)}&insertAfterPage=${encodeURIComponent(String(pageNumber))}&insertSide=${side}`
    };
  }
  useEffect(() => {
    const key = `${bookId}:${highlightedPageId}`;
    if (!book || !originCardRef.current || scrolledOriginRef.current === key) return;
    scrolledOriginRef.current = key;
    originCardRef.current.scrollIntoView?.({ block: "center", behavior: "auto" });
  }, [bookId, book, highlightedPageId, data]);
  if (!data || !book) return <section className="panel"><h2>Galería de páginas</h2>{pagesQuery.isError || bookQuery.isError ? <><p className="error-text" role="alert">{pagesQuery.error?.message ?? bookQuery.error?.message}</p><button className="secondary-button" onClick={() => { void pagesQuery.refetch(); void bookQuery.refetch(); }}>Reintentar</button></> : <p role="status">Cargando páginas...</p>}</section>;
  return <section className="panel book-gallery" aria-labelledby="gallery-title" data-preview-size={previewSize}>
    <div className="panel-header"><div><p className="eyebrow">Galería de páginas · {book.sourceType}</p><h2 id="gallery-title" ref={headingRef} tabIndex={-1}>{book.title}</h2></div><Link className="secondary-button gallery-icon-button" aria-label="Volver al lector" title="Volver al lector" to={readerHref} state={{ returnTo: galleryHref }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg></Link></div>
    {originPageId && !originPage && <p className="helper-text">La página de origen ya no está disponible. No se abrirá otra página en su lugar.</p>}
    <div className="gallery-toolbar">
      <span role="status">{selected.size} de {data.pages.length} seleccionadas</span>
      <button className="secondary-button" onClick={() => setSelected(new Set(order))}>Seleccionar todas</button>
      <button className="secondary-button" onClick={() => { setSelected(new Set()); setAnchor(null); }}>Limpiar selección</button>
      {canEdit && isImages && <><button className="secondary-button" disabled={!pendingOcrPageIds.length} onClick={() => { setSelected(new Set(pendingOcrPageIds)); setAnchor(null); }}>Seleccionar OCR pendiente</button><button className="secondary-button" disabled={!failedOcrPageIds.length} onClick={() => { setSelected(new Set(failedOcrPageIds)); setAnchor(null); }}>Seleccionar OCR fallido</button></>}
      {canEdit && <button className="danger-button" disabled={!selected.size || dirty || busy || activeJob || [...selected].some((id) => !byId.get(id)?.capabilities.delete)} onClick={() => remove([...selected])}>Eliminar selección</button>}
      {canAddPages && (insertBlocked
        ? <button className="secondary-button" disabled title="Guarda o cancela el orden antes de añadir páginas.">Añadir páginas</button>
        : <Link className="secondary-button" to={lastOrderPage ? appendPagesLink(lastOrderPage.pageNumber, "after") : appendPagesLink(1, "before")} state={{ returnTo: galleryHref }} title={lastOrderPage ? `Añadir páginas después de la página ${order.length}` : "Añadir páginas"}>Añadir páginas</Link>)}
      <label>Tamaño de vista previa <select value={previewSize} onChange={(event) => setPreviewSize(event.target.value)}><option value="compact">Compacto</option><option value="normal">Normal</option><option value="large">Grande</option></select></label>
      <label><input type="checkbox" checked={showOutline} onChange={(event) => setShowOutline(event.target.checked)} />Mostrar índice</label>
      {showOutline ? <TocLevelSelector onChange={setTocMaxLevel} value={tocMaxLevel} /> : null}
    </div>
    <p className="helper-text">Selecciona varias páginas; Mayús + selección añade un rango. También puedes usar los controles de rango.</p>
    <div className="gallery-toolbar">
      <label>Desde <select value={anchor ?? ""} onChange={(event) => setAnchor(event.target.value || null)}><option value="">Elegir página</option>{order.map((id, index) => <option key={id} value={id}>{index + 1}</option>)}</select></label>
      <label>Hasta <select value="" onChange={(event) => { setSelected(selectPageRange(order, selected, anchor, event.target.value)); }}><option value="">Añadir rango</option>{order.map((id, index) => <option key={id} value={id}>{index + 1}</option>)}</select></label>
    </div>
    {canEdit && <>
      <fieldset className="gallery-toolbar" disabled={busy || activeJob || !data.capabilities.reorder}><legend>Organizar páginas</legend>
        <label>Mover selección <select value={position} onChange={(event) => setPosition(event.target.value as "before" | "after")}><option value="before">antes de</option><option value="after">después de</option></select></label>
        <label>Página destino <select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Elegir destino</option>{order.filter((id) => !selected.has(id)).map((id) => <option key={id} value={id}>{order.indexOf(id) + 1}</option>)}</select></label>
        <button className="secondary-button" disabled={!selected.size || !target || selected.has(target)} onClick={() => changeOrder(movePages(order, selected, target, position))}>Mover al destino</button>
        <button className="primary-button" disabled={!dirty || orderConflict || orderChanged} onClick={() => void saveOrder()}>Guardar orden</button>
        <button className="secondary-button" disabled={draft === null} onClick={() => void cancelOrder()}>Cancelar</button>
      </fieldset>
      {isImages && <fieldset className="gallery-toolbar" disabled={busy || dirty || activeJob}><legend>OCR de la selección</legend>
        <label>Motor <select value={ocrMode} onChange={(event) => { const mode = event.target.value as ImageOcrMode; setOcrMode(mode); if (mode === "LOCAL") setAdvancedLayout(false); }}><option value="TEXTRACT">AWS Textract</option><option value="VISION">Visión IA</option><option value="LOCAL">Local</option></select></label>
        <AdvancedLayoutCheckbox value={advancedLayout} onChange={setAdvancedLayout} mode={ocrMode} disabled={busy || dirty || activeJob} modelLabel={selectedModel.name} />
        {usesOcrModel(ocrMode, advancedLayout) && <>
          <OcrModelSelect models={models} value={selectedModelId} onChange={setSelectedModelId} compatibilityMessage={compatibilityMessage} />
          <OcrPromptEditor value={promptOverride} onChange={setPromptOverride} onReset={() => setPromptOverride("")} helperText="El mensaje system es fijo. Este campo opcional modifica el mensaje user para el OCR de la seleccion." />
        </>}
        <button className="secondary-button" disabled={!canRunOcr(ocrMode, advancedLayout) || !selected.size || [...selected].some((id) => !byId.get(id)?.capabilities.ocr)} onClick={() => {
          if (!canRunOcr(ocrMode, advancedLayout)) { setError(compatibilityMessage ?? "Modelo OCR no compatible."); return; }
          if (!window.confirm(`¿Repetir OCR en ${selected.size} página(s)? Se reemplazará el contenido editado y la maquetación.`)) return;
          void perform(async () => {
            const job = await startBookPagesOcrJob(accessToken, bookId, { pageIds: [...selected], ...normalizeOcrOptions(ocrMode, advancedLayout, selectedModelId, promptOverride) });
            client.setQueryData(["book-pages-ocr-job", bookId, job.jobId], job);
            setJobId(job.jobId);
            try { localStorage.setItem(jobStorageKey, job.jobId); } catch { setError("OCR iniciado, pero no se pudo guardar el seguimiento para la próxima visita."); }
          });
        }}>Ejecutar OCR</button>
      </fieldset>}
    </>}
    {dirty && <p className="helper-text" role="status">Orden sin guardar. Guarda o cancela antes de editar, añadir o eliminar páginas o ejecutar OCR. Leer usa la numeración guardada.</p>}
    {error && <p className="error-text" role="alert">{error} Si el libro ha cambiado, cancela el orden y vuelve a intentarlo.</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {jobId && jobsQuery.isError && <div className="gallery-job" role="alert"><p className="error-text">No se pudo consultar el OCR: {jobsQuery.error.message}</p><p className="helper-text">Cerrar el seguimiento no cancela el trabajo OCR del servidor.</p><button className="secondary-button" onClick={() => void jobsQuery.refetch()}>Reintentar</button><button className="secondary-button" disabled={busy} onClick={() => { setJobId(""); try { localStorage.removeItem(jobStorageKey); } catch { /* Storage may be unavailable. */ } setNotice("Seguimiento cerrado. El OCR del servidor no se ha cancelado."); }}>Cerrar seguimiento</button></div>}
    {jobs.map((job) => <div className="gallery-job" key={job.jobId} role="status"><strong>OCR: {job.status} ({job.processed}/{job.total}; {job.failed} fallidas)</strong><progress max={Math.max(1, job.total)} value={job.processed} aria-label="Progreso OCR" />{job.error && <p className="error-text">{job.error}</p>}{job.pages.filter((page) => page.error).map((failure) => <p className="error-text" key={failure.pageId}>Página {byId.get(failure.pageId)?.pageNumber ?? failure.pageId}: {failure.error}</p>)}
      {(job.status === "PENDING" || job.status === "RUNNING") && <button className="secondary-button" disabled={busy || job.cancelRequested} onClick={() => void perform(async () => { const next = await updateBookPagesOcrJob(accessToken, bookId, job.jobId, "cancel"); client.setQueryData(["book-pages-ocr-job", bookId, job.jobId], next); })}>{job.cancelRequested ? "Cancelando OCR..." : "Cancelar OCR"}</button>}
      {(job.status === "FAILED" || job.status === "CANCELLED") && <button className="secondary-button" disabled={busy || dirty} onClick={() => void perform(async () => { const next = await updateBookPagesOcrJob(accessToken, bookId, job.jobId, "retry"); client.setQueryData(["book-pages-ocr-job", bookId, job.jobId], next); })}>Reintentar páginas pendientes</button>}
    </div>)}
    {!order.length && <p>Este libro todavía no tiene páginas.{canAddPages && !insertBlocked ? " Usa Añadir páginas para crear la primera." : ""}</p>}
    {showOutline && outlineQuery.isPending && <p role="status">Cargando índice...</p>}
    {showOutline && outlineQuery.isError && <p role="alert" className="error-text">No se pudo cargar el índice. <button className="secondary-button" onClick={() => void outlineQuery.refetch()}>Reintentar índice</button></p>}
    {showOutline && outlineQuery.data && !fullOutline.length && <p className="helper-text">No hay títulos incluidos en el índice.{canEdit ? " Abre una página para convertir un bloque en título e incluirlo." : ""}</p>}
    {showOutline && outlineQuery.data && !!fullOutline.length && !visibleOutline.length && <p className="helper-text" role="status">No hay apartados hasta T{tocMaxLevel} en este libro. Elige T3 para ver más niveles.</p>}
    {showOutline && dirty && <p className="helper-text">La agrupación por índice se reanudará al guardar o cancelar el orden.</p>}
    {grouped ? roots.map(renderNode) : renderPages(order)}
    {editing && <GalleryPageEditor accessToken={accessToken} bookId={bookId} page={editing.page} {...(editing.blockId ? { initialBlockId: editing.blockId } : {})} onClose={() => { setEditing(null); setEditingDirty(false); registerEditorExit(null); }} onSaved={invalidate} onPendingChange={setEditingDirty} onExitChange={registerEditorExit} />}
    {showScrollTop && createPortal(<button type="button" className="primary-button gallery-scroll-top" aria-label="Volver arriba" title="Volver arriba" onClick={() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12 6-6 6 6M12 6v12" /></svg></button>, document.body)}
  </section>;

  function renderPages(pageIds: string[]) {
    if (!data) return null;
    return <div className="gallery-grid">
      {pageIds.map((id) => {
        const index = order.indexOf(id);
        const page = byId.get(id);
        if (!page) return null;
        return <article className="gallery-card" data-gallery-page-id={id} data-selected={selected.has(id)} data-origin={id === highlightedPageId} data-dragging={dragIds?.has(id) ?? false} data-drop-position={dropTarget?.id === id ? dropTarget.position : undefined} aria-current={id === highlightedPageId ? "page" : undefined} ref={id === highlightedPageId ? originCardRef : undefined} key={id}
          onDragOver={(event) => {
            if (!canEdit || !data.capabilities.reorder || !dragIds || busy || activeJob) return;
            if (dragIds.has(id)) { setDropTarget(null); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const nextPosition = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
            setDropTarget((current) => current?.id === id && current.position === nextPosition ? current : { id, position: nextPosition });
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => current?.id === id ? null : current); }}
          onDrop={(event) => { event.preventDefault(); if (dragIds && dropTarget?.id === id) changeOrder(movePages(order, dragIds, id, dropTarget.position)); setDragIds(null); setDropTarget(null); }}>
          {dropTarget?.id === id && <span className="gallery-drop-label" role="status">{dropTarget.position === "before" ? "Insertar antes" : "Insertar después"}</span>}
          {canAddPages && !insertBlocked && <>
            <Link className="gallery-insert gallery-insert-before" to={appendPagesLink(page.pageNumber, "before")} state={{ returnTo: galleryHref }} aria-label={`Añadir páginas antes de la página ${index + 1}`} title={`Añadir páginas antes de la página ${index + 1}`}><span aria-hidden="true">+</span></Link>
            <Link className="gallery-insert gallery-insert-after" to={appendPagesLink(page.pageNumber, "after")} state={{ returnTo: galleryHref }} aria-label={`Añadir páginas después de la página ${index + 1}`} title={`Añadir páginas después de la página ${index + 1}`}><span aria-hidden="true">+</span></Link>
          </>}
          <div className="gallery-card-heading"><label><input type="checkbox" checked={selected.has(id)} onChange={() => {}} onClick={(event) => {
            setSelected((current) => { if (event.shiftKey) return selectPageRange(order, current, anchor, id); const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
            if (!event.shiftKey) setAnchor(id);
          }} /> Página {index + 1}{page.pageLabel ? ` · ${page.pageLabel}` : ""}</label>{id === highlightedPageId && <span className="gallery-origin-label">Página de origen</span>}
          {canEdit && <button className="secondary-button gallery-icon-button gallery-drag" draggable={!busy && !activeJob && data.capabilities.reorder} disabled={busy || activeJob || !data.capabilities.reorder} aria-label={`Arrastrar página ${index + 1}`} title="Mover página" onDragStart={(event) => { const ids = selected.has(id) ? selected : new Set([id]); setDragIds(ids); setDropTarget(null); event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDragIds(null); setDropTarget(null); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3" /></svg></button>}</div>
          <div className="gallery-open-preview" role={canEdit && page.capabilities.edit ? "button" : undefined} tabIndex={canEdit && page.capabilities.edit ? 0 : undefined} aria-label={canEdit && page.capabilities.edit ? `Editar bloques de página ${page.pageNumber}` : undefined}
            onClick={(event) => { if (!(event.target as Element).closest("button") && canEdit && page.capabilities.edit && !busy && !activeJob && !dirty) setEditing({ page }); }}
            onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ") && canEdit && page.capabilities.edit && !busy && !activeJob && !dirty) { event.preventDefault(); setEditing({ page }); } }}>
            <PagePreview page={page} bookId={bookId} accessToken={accessToken} image={isImages} />
          </div>
          <p className="helper-text">Página guardada {page.pageNumber}{isImages ? ` · OCR: ${page.ocrStatus}` : ""}</p>
          <div className="gallery-card-actions"><Link className="secondary-button gallery-icon-button" aria-label="Leer" title="Leer página" to={`${galleryPath}/${id}/read${gallerySearch}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v16m0-16C9 3 5 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z" /></svg></Link>
            {canEdit && <>{page.capabilities.edit && <button className="secondary-button gallery-icon-button" aria-label="Editar" title="Editar página" disabled={dirty || busy || activeJob} onClick={() => setEditing({ page })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5L8 21H3v-5L16 3Zm-3 3 5 5" /></svg></button>}{page.capabilities.delete && <button className="danger-button gallery-icon-button" aria-label="Eliminar" title="Eliminar página" disabled={dirty || busy || activeJob} onClick={() => remove([id])}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg></button>}</>}
          </div>
        </article>;
      })}
    </div>;
  }

  function renderHeading(heading: BookOutlineEntry | null, id: string, baseLevel: number, pageCount: number): ReactNode {
    const titlePage = heading ? data?.pages.find((page) => page.pageNumber === heading.pageNumber) : null;
    return <div className="gallery-outline-row" style={{ paddingInlineStart: `${Math.max(0, (heading?.level ?? baseLevel) - baseLevel) * 0.75}rem` }} key={heading?.chapterId ?? `${heading?.pageNumber}:${heading?.paragraphNumber}`}>
          <button className="secondary-button gallery-outline-toggle" aria-expanded={!collapsed.has(id)} aria-controls={`gallery-node-${id}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}>
            <span aria-hidden="true">{collapsed.has(id) ? "▸" : "▾"}</span><span><span className="gallery-outline-title-text">{heading ? `T${heading.level} · ${heading.title}` : "Antes del primer apartado"}</span> <span className="gallery-outline-count">({pageCount} {pageCount === 1 ? "página" : "páginas"})</span></span>
          </button>
          {canEdit && titlePage?.capabilities.edit && heading?.chapterId && <button className="secondary-button" aria-label={`Editar título: ${heading.title}`} disabled={busy || activeJob} onClick={() => setEditing({ page: titlePage, blockId: heading.chapterId! })}>Editar título</button>}
        </div>;
  }

  function renderNode(node: GalleryOutlineNode): ReactNode {
    const headings = !node.children.length && node.groups.length === 1
      ? [...new Set([...node.groups[0]!.sharedHeadings, ...node.headings])].sort((a, b) => a.pageNumber - b.pageNumber || a.paragraphNumber - b.paragraphNumber)
      : node.headings;
    const baseLevel = Math.min(...headings.map((heading) => heading.level), 6);
    return <section className="gallery-outline-group" key={node.id} data-gallery-outline-id={node.id}>
      <header className="gallery-outline-heading">
        {headings.length ? headings.map((heading) => renderHeading(heading, node.id, baseLevel, subtreePageIds.get(node.id)?.size ?? 0)) : renderHeading(null, node.id, 1, subtreePageIds.get(node.id)?.size ?? 0)}
      </header>
      <div className="gallery-outline-content" id={`gallery-node-${node.id}`} hidden={collapsed.has(node.id)}>
        {node.groups.map((group) => {
          const sharedHeadings = group.sharedHeadings.filter((heading) => !headings.includes(heading));
          const shared = sharedHeadings.length > 0;
          const id = `shared-${group.id}`;
          return <div className="gallery-outline-pages" key={group.id}>
            {shared && <header className="gallery-outline-heading gallery-shared-headings" aria-label="Apartados que comparten estas páginas">
              <p className="helper-text">Esta página también contiene estos apartados:</p>
              {sharedHeadings.map((heading) => renderHeading(heading, id, Math.min(...sharedHeadings.map((entry) => entry.level)), group.pageIds.length))}
            </header>}
            <div className="gallery-outline-content" id={`gallery-node-${id}`} hidden={shared && collapsed.has(id)}>{renderPages(group.pageIds)}</div>
          </div>;
        })}
        {node.children.length > 0 && <div className="gallery-outline-children">{node.children.map(renderNode)}</div>}
      </div>
    </section>;
  }
}
