import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { appendImagesToBook, createImageBook, fetchBooks } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

export function BookBuilderPage() {
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [createForm, setCreateForm] = useState({ authorName: "", synopsis: "", title: "" });
  const [selectedCreateFiles, setSelectedCreateFiles] = useState<File[]>([]);
  const [selectedAppendFiles, setSelectedAppendFiles] = useState<File[]>([]);
  const [selectedBookId, setSelectedBookId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const booksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["builder-books"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      const response = await fetchBooks(accessToken);
      return response.books;
    }
  });

  const imageBooks = (booksQuery.data ?? []).filter((book) => book.sourceType === "IMAGES");

  function toFileArray(fileList: FileList | null): File[] {
    return fileList ? Array.from(fileList) : [];
  }

  async function handleCreateFromImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    if (selectedCreateFiles.length === 0) {
      setCreateError("Selecciona al menos una imagen para crear el libro.");
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const formData = new FormData();
      formData.append("title", createForm.title);

      if (createForm.authorName) {
        formData.append("authorName", createForm.authorName);
      }

      if (createForm.synopsis) {
        formData.append("synopsis", createForm.synopsis);
      }

      for (const file of selectedCreateFiles) {
        formData.append("images", file);
      }

      const response = await createImageBook(accessToken, formData);
      await booksQuery.refetch();
      navigate(`/books/${response.book.bookId}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro desde imágenes.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleAppendImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    if (!selectedBookId) {
      setAppendError("Selecciona un libro de imágenes existente.");
      return;
    }

    if (selectedAppendFiles.length === 0) {
      setAppendError("Selecciona al menos una imagen adicional.");
      return;
    }

    setIsAppending(true);
    setAppendError(null);

    try {
      const formData = new FormData();
      for (const file of selectedAppendFiles) {
        formData.append("images", file);
      }

      const response = await appendImagesToBook(accessToken, selectedBookId, formData);
      await booksQuery.refetch();
      navigate(`/books/${response.book.bookId}`);
    } catch (error) {
      setAppendError(error instanceof Error ? error.message : "No se pudieron añadir nuevas páginas.");
    } finally {
      setIsAppending(false);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Constructor de libros</p>
            <h2>OCR desde imágenes</h2>
          </div>
          <Link className="secondary-button link-button" to="/">
            Volver
          </Link>
        </div>

        <div className="builder-board">
          <article className="builder-form-card">
            <h3>Crear un libro nuevo</h3>
            <p className="subdued">Sube varias imágenes de páginas en orden. El backend ejecutará OCR, guardará las imágenes en Oracle y abrirá el lector listo para seguir leyendo.</p>

            <form className="stack-form" onSubmit={handleCreateFromImages}>
              <label>
                Título del libro
                <input
                  onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Mi libro escaneado"
                  required
                  value={createForm.title}
                />
              </label>

              <label>
                Autor
                <input
                  onChange={(event) => setCreateForm((current) => ({ ...current, authorName: event.target.value }))}
                  placeholder="Autor o autora"
                  value={createForm.authorName}
                />
              </label>

              <label>
                Sinopsis
                <textarea
                  onChange={(event) => setCreateForm((current) => ({ ...current, synopsis: event.target.value }))}
                  placeholder="Descripción opcional"
                  rows={4}
                  value={createForm.synopsis}
                />
              </label>

              <label>
                Imágenes de páginas
                <input
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(event) => setSelectedCreateFiles(toFileArray(event.target.files))}
                  type="file"
                />
              </label>

              <p className="helper-text">Formatos soportados: PNG, JPG y WEBP.</p>

              {selectedCreateFiles.length > 0 ? (
                <div className="file-pill-list">
                  {selectedCreateFiles.map((file) => (
                    <span className="file-pill" key={file.name}>{file.name}</span>
                  ))}
                </div>
              ) : null}

              {createError ? <p className="error-text">{createError}</p> : null}

              <button className="primary-button" disabled={isCreating} type="submit">
                {isCreating ? "Procesando OCR..." : "Crear libro desde imágenes"}
              </button>
            </form>
          </article>

          <article className="builder-form-card">
            <h3>Añadir páginas a un libro existente</h3>
            <p className="subdued">Úsalo para seguir ampliando un libro que ya empezaste a leer. Las páginas nuevas se añaden al final sin perder el progreso guardado.</p>

            <form className="stack-form" onSubmit={handleAppendImages}>
              <label>
                Libro de imágenes
                <select onChange={(event) => setSelectedBookId(event.target.value)} value={selectedBookId}>
                  <option value="">Selecciona un libro</option>
                  {imageBooks.map((book) => (
                    <option key={book.bookId} value={book.bookId}>{book.title}</option>
                  ))}
                </select>
              </label>

              <label>
                Nuevas imágenes
                <input
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(event) => setSelectedAppendFiles(toFileArray(event.target.files))}
                  type="file"
                />
              </label>

              {selectedAppendFiles.length > 0 ? (
                <div className="file-pill-list">
                  {selectedAppendFiles.map((file) => (
                    <span className="file-pill" key={file.name}>{file.name}</span>
                  ))}
                </div>
              ) : null}

              {appendError ? <p className="error-text">{appendError}</p> : null}

              <button className="secondary-button" disabled={isAppending} type="submit">
                {isAppending ? "Procesando OCR..." : "Añadir páginas"}
              </button>
            </form>

            <div className="book-option-list">
              <h3>Tus libros de imágenes</h3>
              {booksQuery.isLoading ? <p className="subdued">Cargando libros...</p> : null}
              {!booksQuery.isLoading && imageBooks.length === 0 ? <p className="subdued">Todavía no tienes libros creados desde imágenes.</p> : null}
              {imageBooks.map((book) => (
                <Link className="book-option-card" key={book.bookId} to={`/books/${book.bookId}`}>
                  <strong>{book.title}</strong>
                  <span>{book.totalPages} páginas, {book.totalParagraphs} párrafos</span>
                </Link>
              ))}
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}