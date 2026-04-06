import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { deleteBook, fetchBooks, importBook, updateBook, type BookSummary } from "../../app/api";
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
  const [isSavingBook, setIsSavingBook] = useState(false);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);

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
  }

  function resetBookForm() {
    setEditingBook(null);
    setBookForm(emptyBookEditForm);
    setBookActionError(null);
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

      await booksQuery.refetch();
      setBookActionSuccess(`Se eliminó el libro ${book.title}.`);
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : "No se pudo eliminar el libro.");
    } finally {
      setDeletingBookId(null);
    }
  }

  return (
    <div className="page-stack">
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
          {booksQuery.data?.map((book) => (
            <article className="book-card shelf-book-card" key={book.bookId}>
              <div className="book-card-actions">
                <button
                  aria-label={`Editar ${book.title}`}
                  className="book-card-icon-button book-card-edit-button"
                  onClick={() => startEditingBook(book)}
                  title="Editar libro"
                  type="button"
                >
                  <EditIcon />
                </button>
                <button
                  aria-label={`Eliminar ${book.title}`}
                  className="book-card-icon-button book-card-delete-button"
                  disabled={deletingBookId === book.bookId}
                  onClick={() => void handleDeleteBook(book)}
                  title="Eliminar libro"
                  type="button"
                >
                  <DeleteIcon />
                </button>
              </div>

              <Link className="book-card-link" to={`/books/${book.bookId}`}>
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
            </article>
          ))}
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
              <button className="secondary-button" onClick={resetBookForm} type="button">
                Cancelar
              </button>
            </div>
          </form>
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