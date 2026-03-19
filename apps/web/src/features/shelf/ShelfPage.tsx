import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchBooks, importBook } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

export function ShelfPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const [importForm, setImportForm] = useState<{ authorName: string; sourceType: "PDF" | "EPUB"; title: string }>({
    authorName: "",
    sourceType: "PDF",
    title: ""
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
      await booksQuery.refetch();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Estantería</p>
            <h2>{user?.displayName ?? user?.username ?? "Tu colección"}</h2>
          </div>
          <Link className="secondary-button link-button" to="/builder">
            Crear desde imágenes
          </Link>
        </div>

        {booksQuery.isLoading ? <p>Cargando libros...</p> : null}
        {booksQuery.isError ? <p className="error-text">No se pudo cargar la estantería.</p> : null}

        <div className="shelf-grid">
          {booksQuery.data?.map((book) => (
            <Link className="book-card" key={book.bookId} to={`/books/${book.bookId}`}>
              <span className="book-spine">{book.sourceType}</span>
              <div>
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
          ))}
        </div>
      </section>

      <aside className="panel form-panel">
        <p className="eyebrow">Importación</p>
        <h2>PDF o EPUB</h2>
        <form className="stack-form" onSubmit={handleCreateBook}>
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

          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? "Importando..." : "Importar libro"}
          </button>
        </form>
      </aside>
    </div>
  );
}