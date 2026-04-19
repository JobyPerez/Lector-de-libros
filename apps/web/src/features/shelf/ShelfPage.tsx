import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { deleteBook, downloadBookExport, downloadOriginalBook, fetchBookCover, fetchBooks, importBook, updateBook, type BlobDownload, type BookSummary } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

type BookEditFormState = {
  authorName: string;
  notionBookUrl: string;
  synopsis: string;
  title: string;
};

type ShelfView = "edit" | "import" | "shelf";
type ShelfViewTransitionDirection = "back" | "forward";

const emptyBookEditForm: BookEditFormState = {
  authorName: "",
  notionBookUrl: "",
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

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="5.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M15 15L19 19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

function buildBookMonogram(title: string): string {
  const titleWords = title
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (titleWords.length === 0) {
    return "LB";
  }

  return titleWords
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "LB";
}

function describeSourceType(sourceType: BookSummary["sourceType"]): string {
  if (sourceType === "EPUB") {
    return "Edicion digital";
  }

  if (sourceType === "IMAGES") {
    return "Captura visual";
  }

  return "Edicion PDF";
}

function ShelfBookCover({ accessToken, book }: { accessToken: string | null; book: BookSummary }) {
  const cacheKey = book.updatedAt ?? book.createdAt ?? `${book.totalPages}-${book.totalParagraphs}`;
  const coverQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["book-cover", book.bookId, cacheKey],
    queryFn: async () => {
      if (!accessToken) {
        return null;
      }

      return fetchBookCover(accessToken, book.bookId, cacheKey);
    },
    staleTime: 60_000
  });
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!coverQuery.data) {
      setCoverUrl(null);
      return;
    }

    const nextObjectUrl = URL.createObjectURL(coverQuery.data);
    setCoverUrl(nextObjectUrl);

    return () => {
      URL.revokeObjectURL(nextObjectUrl);
    };
  }, [coverQuery.data]);

  return (
    <div className="shelf-book-cover-frame" data-has-cover={coverUrl ? "true" : "false"} data-loading={coverQuery.isLoading ? "true" : undefined}>
      <span className="book-spine shelf-book-source-badge">{book.sourceType}</span>

      {coverUrl ? (
        <img alt={`Portada de ${book.title}`} className="shelf-book-cover-image" loading="lazy" src={coverUrl} />
      ) : (
        <div className="shelf-book-cover-placeholder">
          <span aria-hidden="true" className="shelf-book-cover-monogram">{buildBookMonogram(book.title)}</span>
          <div className="shelf-book-cover-fallback-copy">
            <span className="shelf-book-cover-kicker">{describeSourceType(book.sourceType)}</span>
            <strong>{book.title}</strong>
            <span>{book.authorName ?? "Autor pendiente"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ShelfPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const navigate = useNavigate();
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
  const [exportingFormat, setExportingFormat] = useState<"epub" | "pdf" | null>(null);
  const [isSavingBook, setIsSavingBook] = useState(false);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const [removingBookId, setRemovingBookId] = useState<string | null>(null);
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [downloadMenuBookId, setDownloadMenuBookId] = useState<string | null>(null);
  const [viewTransitionDirection, setViewTransitionDirection] = useState<ShelfViewTransitionDirection>("forward");
  const activeView: ShelfView = editingBook ? "edit" : isImportPanelVisible ? "import" : "shelf";

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
      setViewTransitionDirection("back");
      setIsImportPanelVisible(false);
      await booksQuery.refetch();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro.");
    } finally {
      setSubmitting(false);
    }
  }

  function openImportPanel() {
    setViewTransitionDirection("forward");
    setIsImportPanelVisible(true);
    setIsCreateMenuOpen(false);
    setCreateError(null);
    setEditingBook(null);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  function closeImportPanel() {
    setViewTransitionDirection("back");
    setIsImportPanelVisible(false);
    setCreateError(null);
  }

  function openGlobalSearch() {
    setIsCreateMenuOpen(false);
    navigate("/search");
  }

  function startEditingBook(book: BookSummary) {
    setViewTransitionDirection("forward");
    setEditingBook(book);
    setBookForm({
      authorName: book.authorName ?? "",
      notionBookUrl: book.notionBookUrl ?? "",
      synopsis: book.synopsis ?? "",
      title: book.title
    });
    setIsCreateMenuOpen(false);
    setIsImportPanelVisible(false);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  function resetBookForm() {
    setViewTransitionDirection("back");
    setEditingBook(null);
    setBookForm(emptyBookEditForm);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  async function handleDownloadExport(format: "epub" | "pdf") {
    if (!accessToken || !editingBook) {
      return;
    }

    setExportingFormat(format);

    try {
      const download = await downloadBookExport(accessToken, editingBook.bookId, format);
      saveBlobDownload(download, buildFallbackFileName(editingBook, format));
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : `No se pudo exportar el libro a ${format.toUpperCase()}.`);
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
        ...(bookForm.notionBookUrl.trim() ? { notionBookUrl: bookForm.notionBookUrl.trim() } : {}),
        ...(bookForm.synopsis.trim() ? { synopsis: bookForm.synopsis.trim() } : {})
      });

      await booksQuery.refetch();
      setBookActionSuccess(`Se actualizó el libro ${bookForm.title.trim()}.`);
      setViewTransitionDirection("back");
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
        setViewTransitionDirection("back");
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
      {activeView === "shelf" ? (
      <section className="panel wide-panel overflow-visible-panel screen-scene" data-direction={viewTransitionDirection}>
        <div className="panel-header shelf-header">
          <div className="shelf-header-copy">
            <h2>Estantería</h2>
          </div>
          <div className="header-actions shelf-header-actions">
            <button
              aria-expanded={isCreateMenuOpen}
              aria-label="Abrir menú de creación"
              className="plus-button"
              onClick={() => {
                setIsCreateMenuOpen((current) => !current);
              }}
              type="button"
            >
              +
            </button>

            <button
              aria-label="Abrir buscador global"
              className="shelf-header-icon-button"
              onClick={openGlobalSearch}
              title="Buscar en todos tus libros"
              type="button"
            >
              <SearchIcon />
            </button>

            {isCreateMenuOpen ? (
              <div className="menu-panel" role="menu">
                <button className="menu-item" onClick={openImportPanel} type="button">
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

              <Link aria-disabled={isBookRemoving} className="book-card-link shelf-book-link" tabIndex={isBookRemoving ? -1 : undefined} to={`/books/${book.bookId}`}>
                <div className="shelf-book-cover-shell">
                  <ShelfBookCover accessToken={accessToken} book={book} />
                </div>

                <div className="book-card-copy shelf-book-copy">
                  <h3>{book.title}</h3>
                  <p>{book.authorName ?? "Autor pendiente"}</p>
                </div>

                <dl className="shelf-book-stats">
                  <div>
                    <dt>Páginas</dt>
                    <dd>{book.totalPages}</dd>
                  </div>
                  <div>
                    <dt>Párrafos</dt>
                    <dd>{book.totalParagraphs}</dd>
                  </div>
                  {book.lastOpenedAt ? (
                    <div>
                      <dt>Última lectura</dt>
                      <dd>{new Date(book.lastOpenedAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}</dd>
                    </div>
                  ) : null}
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
      ) : null}

      {activeView === "edit" && editingBook ? (
        <section className="panel form-panel wide-panel import-panel-inline screen-scene" data-direction={viewTransitionDirection}>
          <div className="panel-header compact-header">
            <div>
              <p className="eyebrow">Edición</p>
              <h2>{editingBook.title}</h2>
            </div>
            <button
              aria-label="Volver a la estantería"
              className="secondary-button reader-header-icon-button"
              onClick={resetBookForm}
              title="Volver a la estantería"
              type="button"
            >
              <BackIcon />
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
              URL en Notion
              <input
                onChange={(event) => setBookForm((current) => ({ ...current, notionBookUrl: event.target.value }))}
                placeholder="https://www.notion.so/..."
                type="url"
                value={bookForm.notionBookUrl}
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
        </section>
      ) : null}

      {activeView === "import" ? (
        <section className="panel form-panel wide-panel import-panel-inline screen-scene" data-direction={viewTransitionDirection}>
          <div className="panel-header compact-header">
            <div>
              <p className="eyebrow">Importación</p>
              <h2>PDF o EPUB</h2>
            </div>
            <button
              aria-label="Volver a la estantería"
              className="secondary-button reader-header-icon-button"
              onClick={closeImportPanel}
              title="Volver a la estantería"
              type="button"
            >
              <BackIcon />
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
              <button className="secondary-button" onClick={closeImportPanel} type="button">
                Cancelar
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}