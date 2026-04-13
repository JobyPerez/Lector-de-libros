import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { fetchBook, fetchBookOutline, updateBookOutline, type BookOutlineEntry, type BookOutlineSource } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { getOutlineSourceMeta } from "../../app/outline-source";

type OutlineEditorEntry = Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title"> & {
  editorId: string;
  isNew: boolean;
};

let outlineEditorEntryId = 0;

function createOutlineEditorEntry(entry: Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">, isNew: boolean): OutlineEditorEntry {
  outlineEditorEntryId += 1;

  return {
    ...entry,
    editorId: `outline-entry-${outlineEditorEntryId}`,
    isNew
  };
}

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

export function OutlineEditorPage() {
  const { bookId = "" } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [outlineEntries, setOutlineEntries] = useState<OutlineEditorEntry[]>([]);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [outlineSuccess, setOutlineSuccess] = useState<string | null>(null);
  const [isSavingOutline, setIsSavingOutline] = useState(false);

  const bookQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["book", bookId],
    queryFn: async () => {
      if (!accessToken || !bookId) {
        throw new Error("El libro no está disponible.");
      }

      const response = await fetchBook(accessToken, bookId);
      return response.book;
    }
  });

  const outlineQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["book-outline", bookId],
    queryFn: async () => {
      if (!accessToken || !bookId) {
        return {
          outline: [] as BookOutlineEntry[],
          outlineSource: "NONE" as BookOutlineSource
        };
      }

      return fetchBookOutline(accessToken, bookId);
    }
  });

  const outlineSourceMeta = getOutlineSourceMeta(outlineQuery.data?.outlineSource ?? "NONE");

  useEffect(() => {
    setOutlineEntries(
      (outlineQuery.data?.outline ?? []).map((entry) => ({
        level: entry.level,
        pageNumber: entry.pageNumber,
        paragraphNumber: entry.paragraphNumber,
        title: entry.title
      })).map((entry) => createOutlineEditorEntry(entry, false))
    );
  }, [outlineQuery.data]);

  function updateOutlineEntry(index: number, patch: Partial<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">>) {
    setOutlineEntries((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  }

  function addOutlineEntry() {
    setOutlineEntries((current) => [...current, createOutlineEditorEntry({ level: 1, pageNumber: 1, paragraphNumber: 1, title: "Nuevo capítulo" }, true)]);
  }

  function removeOutlineEntry(index: number) {
    setOutlineEntries((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  async function handleSaveOutline() {
    if (!accessToken || !bookId) {
      return;
    }

    setOutlineError(null);
    setOutlineSuccess(null);
    setIsSavingOutline(true);

    try {
      await updateBookOutline(accessToken, bookId, {
        entries: outlineEntries.map((entry) => ({
          level: entry.level,
          pageNumber: entry.pageNumber,
          paragraphNumber: entry.paragraphNumber,
          title: entry.title
        }))
      });

      await Promise.all([
        outlineQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["reader-navigation", bookId] }),
        queryClient.invalidateQueries({ queryKey: ["book-outline", bookId] })
      ]);

      setOutlineSuccess("El índice editable se guardó correctamente.");
    } catch (error) {
      setOutlineError(error instanceof Error ? error.message : "No se pudo guardar el índice.");
    } finally {
      setIsSavingOutline(false);
    }
  }

  return (
    <div className="page-stack shelf-layout">
      <section className="panel form-panel wide-panel import-panel-inline screen-scene">
        <div className="panel-header compact-header">
          <div>
            <p className="eyebrow">Estructura editorial</p>
            <h2>{bookQuery.data?.title ?? "Índice del libro"}</h2>
          </div>
          <button
            aria-label="Volver al libro"
            className="secondary-button reader-header-icon-button"
            onClick={() => navigate(`/books/${bookId}`)}
            title="Volver al libro"
            type="button"
          >
            <BackIcon />
          </button>
        </div>

        <section className="outline-editor-panel">
          <div className="panel-header compact-header">
            <div>
              <p className="eyebrow">Índice</p>
              <h3>Editor de capítulos</h3>
            </div>
            <button className="secondary-button" onClick={addOutlineEntry} type="button">
              Añadir entrada
            </button>
          </div>

          {bookQuery.isLoading || outlineQuery.isLoading ? <p>Cargando índice…</p> : null}
          {bookQuery.isError ? <p className="error-text">No se pudo cargar el libro.</p> : null}
          {outlineQuery.isError ? <p className="error-text">No se pudo cargar el índice.</p> : null}
          {outlineSourceMeta ? (
            <p className="subdued outline-source-note" title={outlineSourceMeta.description}>
              <span>Origen actual</span>
              <span className="reader-navigation-source-badge">{outlineSourceMeta.badgeLabel}</span>
            </p>
          ) : null}
          {outlineQuery.data?.outline.some((entry) => entry.isGenerated) ? <p className="subdued">Se ha precargado una versión derivada del contenido. Puedes corregirla y guardarla para fijarla.</p> : null}
          {outlineError ? <p className="error-text">{outlineError}</p> : null}
          {outlineSuccess ? <p className="success-text">{outlineSuccess}</p> : null}

          <div className="outline-editor-list">
            {outlineEntries.length === 0 ? <p className="subdued">Todavía no hay entradas en el índice.</p> : null}
            {outlineEntries.map((entry, index) => (
              <div className="outline-editor-row" data-new={entry.isNew ? "true" : "false"} key={entry.editorId}>
                <input
                  onChange={(event) => updateOutlineEntry(index, { title: event.target.value })}
                  placeholder="Título del capítulo"
                  value={entry.title}
                />
                {entry.isNew ? (
                  <>
                    <input
                      aria-label="Nivel del capítulo"
                      min={1}
                      onChange={(event) => updateOutlineEntry(index, { level: Number(event.target.value) || 1 })}
                      placeholder="Nivel"
                      type="number"
                      value={entry.level}
                    />
                    <input
                      aria-label="Página inicial del capítulo"
                      min={1}
                      onChange={(event) => updateOutlineEntry(index, { pageNumber: Number(event.target.value) || 1 })}
                      placeholder="Página"
                      type="number"
                      value={entry.pageNumber}
                    />
                    <input
                      aria-label="Párrafo inicial del capítulo"
                      min={1}
                      onChange={(event) => updateOutlineEntry(index, { paragraphNumber: Number(event.target.value) || 1 })}
                      placeholder="Párrafo"
                      type="number"
                      value={entry.paragraphNumber}
                    />
                  </>
                ) : null}
                <button className="secondary-button outline-delete-button" onClick={() => removeOutlineEntry(index)} type="button">
                  Quitar
                </button>
              </div>
            ))}
          </div>

          <div className="import-panel-actions">
            <button className="primary-button" disabled={isSavingOutline || outlineQuery.isLoading} onClick={() => void handleSaveOutline()} type="button">
              {isSavingOutline ? "Guardando índice..." : "Guardar índice"}
            </button>
            <button className="secondary-button" onClick={() => navigate(`/books/${bookId}`)} type="button">
              Volver al libro
            </button>
          </div>
        </section>
      </section>
    </div>
  );
}