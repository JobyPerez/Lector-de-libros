import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { deleteBookPage, fetchBook, fetchBookPage, fetchBookPageImage, fetchBookPages, fetchBookPagesOcrJob, isBookEditor, reorderBookPages, startBookPagesOcrJob, updateBookPagesOcrJob, type BookGalleryPage, type BookPagesResponse, type ImageOcrMode } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { AdvancedLayoutCheckbox, OcrModelSelect, OcrPromptEditor, defaultOcrMode, normalizeOcrOptions, useOcrModelSelection, usesOcrModel } from "../../components/OcrConfig";
import { movePages, selectPageRange } from "./page-order";
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
  const originCardRef = useRef<HTMLElement>(null);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ocrMode, setOcrMode] = useState<ImageOcrMode>(defaultOcrMode);
  const [advancedLayout, setAdvancedLayout] = useState(false);
  const [promptOverride, setPromptOverride] = useState("");
  const { models, selectedModelId, selectedModel, setSelectedModelId, canRunOcr, compatibilityMessage } = useOcrModelSelection(`gallery:${bookId}`);
  const pagesQuery = useQuery({ queryKey: ["book-pages", bookId], queryFn: () => fetchBookPages(accessToken, bookId), enabled: !!accessToken });
  const bookQuery = useQuery({ queryKey: ["book", bookId], queryFn: () => fetchBook(accessToken, bookId), enabled: !!accessToken });
  const data = pagesQuery.data;
  const book = bookQuery.data?.book;
  const persisted = data?.pages.map((page) => page.pageId) ?? [];
  const order = draft ?? persisted;
  const dirty = draft !== null && draft.join(",") !== baseline.join(",");
  useUnsavedChanges(dirty || busy);
  const canEdit = isBookEditor(book?.currentUserRole);
  const isImages = book?.sourceType === "IMAGES";
  const jobsQuery = useQuery({
    queryKey: ["book-pages-ocr-job", bookId, jobId], queryFn: () => fetchBookPagesOcrJob(accessToken, bookId, jobId),
    enabled: !!accessToken && canEdit && isImages && !!jobId,
    refetchInterval: (query) => !query.state.data || query.state.data.status === "PENDING" || query.state.data.status === "RUNNING" ? 2000 : false
  });
  const jobs = jobId && jobsQuery.data ? [jobsQuery.data] : [];
  const activeJob = canEdit && isImages && !!jobId && (!jobsQuery.data || jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING"));
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
    await Promise.all(["book-pages", "book", "books", "builder-books", "book-page", "book-page-image", "reader-annotations", "reader-navigation", "reader-readable-neighbors", "progress", "builder-page-visual", "builder-page-annotations", "builder-navigation", "ai-requests", "section-summary"].map((key) =>
      client.invalidateQueries({ predicate: (query) => query.queryKey[0] === key && (query.queryKey[1] === bookId || key === "books" || key === "builder-books") })));
  }
  function changeOrder(next: string[]) {
    if (!canEdit || !data?.capabilities.reorder || busy || activeJob || next.join(",") === order.join(",")) return;
    if (draft === null) setBaseline(persisted);
    setDraft(next);
    setNotice("Orden modificado. Guarda o cancela los cambios.");
  }
  async function perform(action: () => Promise<BookPagesResponse | void>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      if (result) { client.setQueryData(["book-pages", bookId], result); setDraft(null); }
      await invalidate();
      setNotice("Cambios guardados.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
      await invalidate();
    } finally { setBusy(false); }
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
  const originPage = originPageId ? byId.get(originPageId) : data?.pages.find((page) => page.pageNumber === originPageNumber);
  const highlightedPageId = originPageId || originPage?.pageId || "";
  const readerPageNumber = originPage?.pageNumber ?? (Number.isInteger(originPageNumber) && originPageNumber > 0 ? originPageNumber : 1);
  const readerHref = highlightedPageId || originPageNumber > 0
    ? `/books/${bookId}?page=${readerPageNumber}${highlightedPageId ? `&pageId=${encodeURIComponent(highlightedPageId)}` : ""}`
    : `/books/${bookId}`;
  useEffect(() => {
    const key = `${bookId}:${highlightedPageId}`;
    if (!book || !originCardRef.current || scrolledOriginRef.current === key) return;
    scrolledOriginRef.current = key;
    originCardRef.current.scrollIntoView?.({ block: "center", behavior: "auto" });
  }, [bookId, book, highlightedPageId, data]);
  if (!data || !book) return <section className="panel"><h2>Galería de páginas</h2>{pagesQuery.isError || bookQuery.isError ? <><p className="error-text" role="alert">{pagesQuery.error?.message ?? bookQuery.error?.message}</p><button className="secondary-button" onClick={() => { void pagesQuery.refetch(); void bookQuery.refetch(); }}>Reintentar</button></> : <p role="status">Cargando páginas...</p>}</section>;
  return <section className="panel book-gallery" aria-labelledby="gallery-title" data-preview-size={previewSize}>
    <div className="panel-header"><div><p className="eyebrow">Galería de páginas · {book.sourceType}</p><h2 id="gallery-title" ref={headingRef} tabIndex={-1}>{book.title}</h2></div><Link className="secondary-button" to={readerHref} state={{ returnTo: galleryHref }}>Volver al lector</Link></div>
    {originPageId && !originPage && <p className="helper-text">La página de origen ya no está disponible. No se abrirá otra página en su lugar.</p>}
    <div className="gallery-toolbar">
      <span role="status">{selected.size} de {data.pages.length} seleccionadas</span>
      <button className="secondary-button" onClick={() => setSelected(new Set(order))}>Seleccionar todas</button>
      <button className="secondary-button" onClick={() => { setSelected(new Set()); setAnchor(null); }}>Limpiar selección</button>
      {canEdit && isImages && <><button className="secondary-button" disabled={!pendingOcrPageIds.length} onClick={() => { setSelected(new Set(pendingOcrPageIds)); setAnchor(null); }}>Seleccionar OCR pendiente</button><button className="secondary-button" disabled={!failedOcrPageIds.length} onClick={() => { setSelected(new Set(failedOcrPageIds)); setAnchor(null); }}>Seleccionar OCR fallido</button></>}
      {canEdit && <button className="danger-button" disabled={!selected.size || dirty || busy || activeJob || [...selected].some((id) => !byId.get(id)?.capabilities.delete)} onClick={() => remove([...selected])}>Eliminar selección</button>}
      <label>Tamaño de vista previa <select value={previewSize} onChange={(event) => setPreviewSize(event.target.value)}><option value="compact">Compacto</option><option value="normal">Normal</option><option value="large">Grande</option></select></label>
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
        <button className="primary-button" disabled={!dirty} onClick={() => void perform(() => reorderBookPages(accessToken, bookId, { pageIds: order, expectedPageIds: baseline }))}>Guardar orden</button>
        <button className="secondary-button" disabled={draft === null} onClick={() => { setDraft(null); setError(""); setNotice("Orden cancelado."); }}>Cancelar</button>
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
    {dirty && <p className="helper-text" role="status">Orden sin guardar. Guarda o cancela antes de eliminar páginas o ejecutar OCR. Leer y editar usan la numeración guardada.</p>}
    {error && <p className="error-text" role="alert">{error} Si el libro ha cambiado, cancela el orden y vuelve a intentarlo.</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {jobId && jobsQuery.isError && <div className="gallery-job" role="alert"><p className="error-text">No se pudo consultar el OCR: {jobsQuery.error.message}</p><p className="helper-text">Cerrar el seguimiento no cancela el trabajo OCR del servidor.</p><button className="secondary-button" onClick={() => void jobsQuery.refetch()}>Reintentar</button><button className="secondary-button" disabled={busy} onClick={() => { setJobId(""); try { localStorage.removeItem(jobStorageKey); } catch { /* Storage may be unavailable. */ } setNotice("Seguimiento cerrado. El OCR del servidor no se ha cancelado."); }}>Cerrar seguimiento</button></div>}
    {jobs.map((job) => <div className="gallery-job" key={job.jobId} role="status"><strong>OCR: {job.status} ({job.processed}/{job.total}; {job.failed} fallidas)</strong><progress max={Math.max(1, job.total)} value={job.processed} aria-label="Progreso OCR" />{job.error && <p className="error-text">{job.error}</p>}{job.pages.filter((page) => page.error).map((failure) => <p className="error-text" key={failure.pageId}>Página {byId.get(failure.pageId)?.pageNumber ?? failure.pageId}: {failure.error}</p>)}
      {(job.status === "PENDING" || job.status === "RUNNING") && <button className="secondary-button" disabled={busy || job.cancelRequested} onClick={() => void perform(async () => { const next = await updateBookPagesOcrJob(accessToken, bookId, job.jobId, "cancel"); client.setQueryData(["book-pages-ocr-job", bookId, job.jobId], next); })}>{job.cancelRequested ? "Cancelando OCR..." : "Cancelar OCR"}</button>}
      {(job.status === "FAILED" || job.status === "CANCELLED") && <button className="secondary-button" disabled={busy || dirty} onClick={() => void perform(async () => { const next = await updateBookPagesOcrJob(accessToken, bookId, job.jobId, "retry"); client.setQueryData(["book-pages-ocr-job", bookId, job.jobId], next); })}>Reintentar páginas pendientes</button>}
    </div>)}
    {!order.length && <p>Este libro todavía no tiene páginas.</p>}
    <div className="gallery-grid">
      {order.map((id, index) => {
        const page = byId.get(id);
        if (!page) return null;
        return <article className="gallery-card" data-selected={selected.has(id)} data-origin={id === highlightedPageId} aria-current={id === highlightedPageId ? "page" : undefined} ref={id === highlightedPageId ? originCardRef : undefined} key={id}
          onDragOver={(event) => { if (canEdit && dragIds && !busy && !activeJob) event.preventDefault(); }}
          onDrop={(event) => { event.preventDefault(); if (dragIds) changeOrder(movePages(order, dragIds, id, position)); setDragIds(null); }}>
          <div className="gallery-card-heading"><label><input type="checkbox" checked={selected.has(id)} onChange={() => {}} onClick={(event) => {
            setSelected((current) => { if (event.shiftKey) return selectPageRange(order, current, anchor, id); const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
            if (!event.shiftKey) setAnchor(id);
          }} /> Página {index + 1}{page.pageLabel ? ` · ${page.pageLabel}` : ""}</label>{id === highlightedPageId && <span className="gallery-origin-label">Página de origen</span>}
          {canEdit && <button className="secondary-button gallery-drag" draggable={!busy && !activeJob} disabled={busy || activeJob} aria-label={`Arrastrar página ${index + 1}`} onDragStart={(event) => { const ids = selected.has(id) ? selected : new Set([id]); setDragIds(ids); event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragIds(null)}>Mover</button>}</div>
          <PagePreview page={page} bookId={bookId} accessToken={accessToken} image={isImages} />
          <p className="helper-text">Página guardada {page.pageNumber}{isImages ? ` · OCR: ${page.ocrStatus}` : ""}</p>
          <div className="gallery-card-actions"><Link className="secondary-button" to={`${galleryPath}/${id}/read${gallerySearch}`}>Leer</Link>
            {canEdit && <>{page.capabilities.edit && <Link className="secondary-button" to={`${galleryPath}/${id}/edit${gallerySearch}`}>Editar</Link>}{page.capabilities.delete && <button className="danger-button" disabled={dirty || busy || activeJob} onClick={() => remove([id])}>Eliminar</button>}</>}
          </div>
        </article>;
      })}
    </div>
    {showScrollTop && createPortal(<button type="button" className="primary-button gallery-scroll-top" aria-label="Volver arriba" title="Volver arriba" onClick={() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12 6-6 6 6M12 6v12" /></svg><span>Subir</span></button>, document.body)}
  </section>;
}
