import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { deleteBook, downloadBookExport, downloadOriginalBook, fetchBookOutline, fetchBooks, importBook, updateBook, updateBookOutline, type BlobDownload, type BookOutlineEntry, type BookSummary } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

type BookEditFormState = {
  authorName: string;
  synopsis: string;
  title: string;
};

const emptyBookEditForm: BookEditFormState = {
  authorName: "",
  synopsis: "",
  title: ""
};

const removalExitAnimationMs = 280;

function EditIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="m13 7 4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M5 7h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M9 7V5.8c0-.44.36-.8.8-.8h4.4c.44 0 .8.36.8.8V7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7.5 7.5v10.7c0 .99.81 1.8 1.8 1.8h5.4c.99 0 1.8-.81 1.8-1.8V7.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10 11v5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M14 11v5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M12 3v10.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M4.5 16.5v1.2c0 1 .8 1.8 1.8 1.8h11.4c1 0 1.8-.8 1.8-1.8v-1.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function buildFallbackFileName(book: BookSummary, format: "epub" | "pdf"): string {
  const normalizedTitle = book.title.trim().replace(/\s+/gu, "-").toLowerCase() || "libro";
  return `${normalizedTitle}.${format}`;
}

function saveBlobDownload(download: BlobDownload, fallbackFileName: string) {
  const objectUrl = URL.createObjectURL(download.blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = download.fileName || fallbackFileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export function ShelfPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [isImportPanelVisible, setIsImportPanelVisible] = useState(false);
  const [editingBook, setEditingBook] = useState<BookSummary | null>(null);
  const [bookForm, setBookForm] = useState<BookEditFormState>(emptyBookEditForm);
  const [importForm, setImportForm] = useState<{ authorName: string; sourceType: "PDF" | "EPUB"; title: string }>({
    authorName: "",
    sourceType: "PDF",
    title: ""
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [bookActionError, setBookActionError] = useState<string | null>(null);
  const [bookActionSuccess, setBookActionSuccess] = useState<string | null>(null);
  const [outlineEntries, setOutlineEntries] = useState<Array<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">>>([]);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [outlineSuccess, setOutlineSuccess] = useState<string | null>(null);
  const [isSavingOutline, setIsSavingOutline] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<"epub" | "pdf" | null>(null);
  const [isSavingBook, setIsSavingBook] = useState(false);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const [removingBookId, setRemovingBookId] = useState<string | null>(null);
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [downloadMenuBookId, setDownloadMenuBookId] = useState<string | null>(null);

  const booksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["books"],
    queryFn: async () => {
      if (!accessToken) {
        return [];
      }

      const response = await fetchBooks(accessToken);
      return response.books;
    }
  });

  const outlineQuery = useQuery({
    enabled: Boolean(accessToken && editingBook?.bookId),
    queryKey: ["book-outline", editingBook?.bookId],
    queryFn: async () => {
      if (!accessToken || !editingBook) {
        return [] as BookOutlineEntry[];
      }

      const response = await fetchBookOutline(accessToken, editingBook.bookId);
      return response.outline;
    }
  });

  useEffect(() => {
    if (!editingBook) {
      setOutlineEntries([]);
      return;
    }

    setOutlineEntries(
      (outlineQuery.data ?? []).map((entry) => ({
        level: entry.level,
        pageNumber: entry.pageNumber,
        paragraphNumber: entry.paragraphNumber,
        title: entry.title
      }))
    );
  }, [editingBook, outlineQuery.data]);

  async function handleCreateBook(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || !selectedFile) {
      setCreateError("Selecciona un archivo PDF o EPUB para importarlo.");
      return;
    }

    setSubmitting(true);
    setCreateError(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("sourceType", importForm.sourceType);

      if (importForm.title) {
        formData.append("title", importForm.title);
      }

      if (importForm.authorName) {
        formData.append("authorName", importForm.authorName);
      }

      await importBook(accessToken, formData);

      setImportForm({ authorName: "", sourceType: "PDF", title: "" });
      setSelectedFile(null);
      setIsImportPanelVisible(false);
      await booksQuery.refetch();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro.");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleImportPanel() {
    setIsImportPanelVisible((current) => !current);
    setIsCreateMenuOpen(false);
    setCreateError(null);
    setEditingBook(null);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  function startEditingBook(book: BookSummary) {
    setEditingBook(book);
    setBookForm({
      authorName: book.authorName ?? "",
      synopsis: book.synopsis ?? "",
      title: book.title
    });
    setIsCreateMenuOpen(false);
    setIsImportPanelVisible(false);
    setBookActionError(null);
    setBookActionSuccess(null);
    setOutlineError(null);
    setOutlineSuccess(null);
    setDownloadMenuBookId(null);
  }

  function resetBookForm() {
    setEditingBook(null);
    setBookForm(emptyBookEditForm);
    setBookActionError(null);
    setOutlineError(null);
    setOutlineSuccess(null);
    setDownloadMenuBookId(null);
  }

  function updateOutlineEntry(index: number, patch: Partial<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">>) {
    setOutlineEntries((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  }

  function addOutlineEntry() {
    setOutlineEntries((current) => [...current, { level: 1, pageNumber: 1, paragraphNumber: 1, title: "Nuevo capítulo" }]);
  }

  function removeOutlineEntry(index: number) {
    setOutlineEntries((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  async function handleSaveOutline() {
    if (!accessToken || !editingBook) {
      return;
    }

    setOutlineError(null);
    setOutlineSuccess(null);
    setIsSavingOutline(true);

    try {
      await updateBookOutline(accessToken, editingBook.bookId, { entries: outlineEntries });
      await outlineQuery.refetch();
      setOutlineSuccess("El índice editable se guardó correctamente.");
    } catch (error) {
      setOutlineError(error instanceof Error ? error.message : "No se pudo guardar el índice.");
    } finally {
      setIsSavingOutline(false);
    }
  }

  async function handleDownloadExport(format: "epub" | "pdf") {
    if (!accessToken || !editingBook) {
      return;
    }

    setOutlineError(null);
    setOutlineSuccess(null);
    setExportingFormat(format);

    try {
      const download = await downloadBookExport(accessToken, editingBook.bookId, format);
      saveBlobDownload(download, buildFallbackFileName(editingBook, format));
    } catch (error) {
      setOutlineError(error instanceof Error ? error.message : `No se pudo exportar el libro a ${format.toUpperCase()}.`);
    } finally {
      setExportingFormat(null);
    }
  }

  async function handleDownloadOriginal(book: BookSummary) {
    if (!accessToken) {
      return;
    }

    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
    setDownloadingBookId(book.bookId);

    try {
      const format = book.sourceType === "PDF" ? "pdf" : "epub";
      const download = await downloadOriginalBook(accessToken, book.bookId);
      saveBlobDownload(download, buildFallbackFileName(book, format));
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : "No se pudo descargar el archivo original del libro.");
    } finally {
      setDownloadingBookId(null);
    }
  }

  async function handleExportFromCard(book: BookSummary, format: "epub" | "pdf") {
    if (!accessToken) {
      return;
    }

    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
    setDownloadingBookId(book.bookId);

    try {
      const download = await downloadBookExport(accessToken, book.bookId, format);
      saveBlobDownload(download, buildFallbackFileName(book, format));
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : `No se pudo exportar el libro a ${format.toUpperCase()}.`);
    } finally {
      setDownloadingBookId(null);
    }
  }

  function handleDownloadAction(book: BookSummary, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (downloadingBookId === book.bookId) {
      return;
    }

    if (book.sourceType === "IMAGES") {
      setDownloadMenuBookId((current) => current === book.bookId ? null : book.bookId);
      return;
    }

    void handleDownloadOriginal(book);
  }

  async function handleUpdateBook(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || !editingBook) {
      return;
    }

    setBookActionError(null);
    setBookActionSuccess(null);
    setIsSavingBook(true);

    try {
      await updateBook(accessToken, editingBook.bookId, {
        title: bookForm.title.trim(),
        ...(bookForm.authorName.trim() ? { authorName: bookForm.authorName.trim() } : {}),
        ...(bookForm.synopsis.trim() ? { synopsis: bookForm.synopsis.trim() } : {})
      });

      await booksQuery.refetch();
      setBookActionSuccess(`Se actualizó el libro ${bookForm.title.trim()}.`);
      setEditingBook(null);
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : "No se pudo actualizar el libro.");
    } finally {
      setIsSavingBook(false);
    }
  }

  async function handleDeleteBook(book: BookSummary) {
    if (!accessToken) {
      return;
    }

    const confirmed = window.confirm(`Se borrará el libro ${book.title} y todo su contenido. ¿Continuar?`);
    if (!confirmed) {
      return;
    }

    setBookActionError(null);
    setBookActionSuccess(null);
    setDeletingBookId(book.bookId);

    try {
      await deleteBook(accessToken, book.bookId);

      if (editingBook?.bookId === book.bookId) {
        setEditingBook(null);
      }

      setRemovingBookId(book.bookId);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, removalExitAnimationMs);
      });
      await booksQuery.refetch();
      setBookActionSuccess(`Se eliminó el libro ${book.title}.`);
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : "No se pudo eliminar el libro.");
    } finally {
      setRemovingBookId(null);
      setDeletingBookId(null);
    }
  }

  return (
    <div className="page-stack shelf-layout">
      <section className="panel wide-panel overflow-visible-panel">
        <div className="panel-header shelf-header">
          <div>
            <h2>Estantería</h2>
          </div>
          <div className="header-actions shelf-header-actions">
            <button
              aria-expanded={isCreateMenuOpen}
              aria-label="Abrir menú de creación"
              className="plus-button"
              onClick={() => setIsCreateMenuOpen((current) => !current)}
              type="button"
            >
              +
            </button>

            {isCreateMenuOpen ? (
              <div className="menu-panel" role="menu">
                <button className="menu-item" onClick={toggleImportPanel} type="button">
                  Importación
                </button>
                <Link className="menu-item" onClick={() => setIsCreateMenuOpen(false)} to="/builder">
                  Crear desde imágenes
                </Link>
              </div>
            ) : null}
          </div>
        </div>

        {booksQuery.isLoading ? <p>Cargando libros...</p> : null}
        {booksQuery.isError ? <p className="error-text">No se pudo cargar la estantería.</p> : null}
        {bookActionError ? <p className="error-text">{bookActionError}</p> : null}
        {bookActionSuccess ? <p className="success-text">{bookActionSuccess}</p> : null}

        <div className="shelf-grid">
          {booksQuery.data?.map((book) => {
            const isDeletingBook = deletingBookId === book.bookId;
            const removalState = removingBookId === book.bookId
              ? "exiting"
              : isDeletingBook
                ? "pending"
                : undefined;
            const isBookRemoving = removalState !== undefined;

            return (
            <article aria-busy={isBookRemoving} className="book-card shelf-book-card" data-removing={removalState} key={book.bookId}>
              <div
                className="book-card-actions"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDownloadMenuBookId((current) => current === book.bookId ? null : current);
                  }
                }}
              >
                <button
                  aria-expanded={book.sourceType === "IMAGES" ? downloadMenuBookId === book.bookId : undefined}
                  aria-haspopup={book.sourceType === "IMAGES" ? "menu" : undefined}
                  aria-label={book.sourceType === "IMAGES" ? `Descargar ${book.title} como EPUB o PDF` : `Descargar ${book.title}`}
                  className="book-card-icon-button book-card-download-button"
                  disabled={isBookRemoving || downloadingBookId === book.bookId}
                  onClick={(event) => handleDownloadAction(book, event)}
                  title={book.sourceType === "IMAGES" ? "Descargar como EPUB o PDF" : "Descargar archivo original"}
                  type="button"
                >
                  <DownloadIcon />
                </button>
                <button
                  aria-label={`Editar ${book.title}`}
                  className="book-card-icon-button book-card-edit-button"
                  disabled={isBookRemoving}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startEditingBook(book);
                  }}
                  title="Editar libro"
                  type="button"
                >
                  <EditIcon />
                </button>
                <button
                  aria-label={`Eliminar ${book.title}`}
                  className="book-card-icon-button book-card-delete-button"
                  disabled={isBookRemoving}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleDeleteBook(book);
                  }}
                  title="Eliminar libro"
                  type="button"
                >
                  <DeleteIcon />
                </button>

                {downloadMenuBookId === book.bookId ? (
                  <div className="book-card-download-menu" role="menu">
                    <p className="book-card-download-menu-title">Descargar libro de imágenes</p>
                    <button
                      className="menu-item book-card-download-option"
                      disabled={downloadingBookId === book.bookId}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleExportFromCard(book, "epub");
                      }}
                      role="menuitem"
                      type="button"
                    >
                      EPUB
                    </button>
                    <button
                      className="menu-item book-card-download-option"
                      disabled={downloadingBookId === book.bookId}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleExportFromCard(book, "pdf");
                      }}
                      role="menuitem"
                      type="button"
                    >
                      PDF
                    </button>
                  </div>
                ) : null}
              </div>

              <Link aria-disabled={isBookRemoving} className="book-card-link" tabIndex={isBookRemoving ? -1 : undefined} to={`/books/${book.bookId}`}>
                <span className="book-spine">{book.sourceType}</span>
                <div className="book-card-copy">
                  <h3>{book.title}</h3>
                  <p>{book.authorName ?? "Autor pendiente"}</p>
                </div>
                <dl>
                  <div>
                    <dt>Páginas</dt>
                    <dd>{book.totalPages}</dd>
                  </div>
                  <div>
                    <dt>Párrafos</dt>
                    <dd>{book.totalParagraphs}</dd>
                  </div>
                </dl>
              </Link>
              <div aria-hidden={!isBookRemoving} className="book-card-removing-badge">
                <span className="book-card-removing-dot" />
                {removalState === "exiting" ? "Retirando de la estantería..." : "Eliminando..."}
              </div>
            </article>
            );
          })}
        </div>
      </section>

      {editingBook ? (
        <aside className="panel form-panel import-panel-inline">
          <div className="panel-header compact-header">
            <div>
              <p className="eyebrow">Edición</p>
              <h2>{editingBook.title}</h2>
            </div>
            <button className="secondary-button" onClick={resetBookForm} type="button">
              Cerrar
            </button>
          </div>

          <form className="stack-form auth-form-compact" onSubmit={handleUpdateBook}>
            <label>
              Título
              <input
                onChange={(event) => setBookForm((current) => ({ ...current, title: event.target.value }))}
                required
                value={bookForm.title}
              />
            </label>
            <label>
              Autor
              <input
                onChange={(event) => setBookForm((current) => ({ ...current, authorName: event.target.value }))}
                placeholder="Autor o autora"
                value={bookForm.authorName}
              />
            </label>
            <label>
              Sinopsis
              <textarea
                onChange={(event) => setBookForm((current) => ({ ...current, synopsis: event.target.value }))}
                placeholder="Resumen opcional del libro"
                rows={5}
                value={bookForm.synopsis}
              />
            </label>

            {bookActionError ? <p className="error-text">{bookActionError}</p> : null}

            <div className="import-panel-actions">
              <button className="primary-button" disabled={isSavingBook} type="submit">
                {isSavingBook ? "Guardando..." : "Guardar cambios"}
              </button>
              <button className="secondary-button" disabled={exportingFormat === "epub"} onClick={() => void handleDownloadExport("epub")} type="button">
                {exportingFormat === "epub" ? "Exportando EPUB..." : "Exportar EPUB"}
              </button>
              <button className="secondary-button" disabled={exportingFormat === "pdf"} onClick={() => void handleDownloadExport("pdf")} type="button">
                {exportingFormat === "pdf" ? "Exportando PDF..." : "Exportar PDF"}
              </button>
              <button className="secondary-button" onClick={resetBookForm} type="button">
                Cancelar
              </button>
            </div>
          </form>

          <section className="outline-editor-panel">
            <div className="panel-header compact-header">
              <div>
                <p className="eyebrow">Estructura editorial</p>
                <h3>Índice editable</h3>
              </div>
              <button className="secondary-button" onClick={addOutlineEntry} type="button">
                Añadir entrada
              </button>
            </div>

            {outlineQuery.isLoading ? <p>Cargando índice…</p> : null}
            {outlineQuery.data?.some((entry) => entry.isGenerated) ? <p className="subdued">Se ha precargado una versión derivada del contenido. Puedes corregirla y guardarla para fijarla.</p> : null}
            {outlineError ? <p className="error-text">{outlineError}</p> : null}
            {outlineSuccess ? <p className="success-text">{outlineSuccess}</p> : null}

            <div className="outline-editor-list">
              {outlineEntries.length === 0 ? <p className="subdued">Todavía no hay entradas en el índice.</p> : null}
              {outlineEntries.map((entry, index) => (
                <div className="outline-editor-row" key={`${index}-${entry.title}`}>
                  <input
                    onChange={(event) => updateOutlineEntry(index, { title: event.target.value })}
                    placeholder="Título del capítulo"
                    value={entry.title}
                  />
                  <input
                    min={1}
                    onChange={(event) => updateOutlineEntry(index, { level: Number(event.target.value) || 1 })}
                    type="number"
                    value={entry.level}
                  />
                  <input
                    min={1}
                    onChange={(event) => updateOutlineEntry(index, { pageNumber: Number(event.target.value) || 1 })}
                    type="number"
                    value={entry.pageNumber}
                  />
                  <input
                    min={1}
                    onChange={(event) => updateOutlineEntry(index, { paragraphNumber: Number(event.target.value) || 1 })}
                    type="number"
                    value={entry.paragraphNumber}
                  />
                  <button className="secondary-button outline-delete-button" onClick={() => removeOutlineEntry(index)} type="button">
                    Quitar
                  </button>
                </div>
              ))}
            </div>

            <div className="import-panel-actions">
              <button className="primary-button" disabled={isSavingOutline} onClick={() => void handleSaveOutline()} type="button">
                {isSavingOutline ? "Guardando índice..." : "Guardar índice"}
              </button>
            </div>
          </section>
        </aside>
      ) : null}

      {isImportPanelVisible ? (
        <aside className="panel form-panel import-panel-inline">
          <div className="panel-header compact-header">
            <div>
              <p className="eyebrow">Importación</p>
              <h2>PDF o EPUB</h2>
            </div>
            <button className="secondary-button" onClick={() => setIsImportPanelVisible(false)} type="button">
              Cerrar
            </button>
          </div>

          <form className="stack-form auth-form-compact" onSubmit={handleCreateBook}>
            <label>
              Título
              <input
                onChange={(event) => setImportForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Si lo dejas vacío, se tomará del archivo"
                value={importForm.title}
              />
            </label>
            <label>
              Autor
              <input
                onChange={(event) => setImportForm((current) => ({ ...current, authorName: event.target.value }))}
                placeholder="Autor o autora"
                value={importForm.authorName}
              />
            </label>
            <label>
              Origen
              <select
                onChange={(event) => setImportForm((current) => ({ ...current, sourceType: event.target.value as "PDF" | "EPUB" }))}
                value={importForm.sourceType}
              >
                <option value="PDF">PDF</option>
                <option value="EPUB">EPUB</option>
              </select>
            </label>
            <label>
              Archivo
              <input
                accept=".pdf,.epub,application/pdf,application/epub+zip"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>

            {createError ? <p className="error-text">{createError}</p> : null}

            <div className="import-panel-actions">
              <button className="primary-button" disabled={submitting} type="submit">
                {submitting ? "Importando..." : "Importar libro"}
              </button>
              <button className="secondary-button" onClick={() => setIsImportPanelVisible(false)} type="button">
                Cancelar
              </button>
            </div>
          </form>
        </aside>
      ) : null}
    </div>
  );
}