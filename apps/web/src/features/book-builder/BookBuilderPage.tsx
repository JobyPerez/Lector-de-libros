import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { appendImagesToBook, createImageBook, fetchBookPage, fetchBookPageImage, fetchBooks, rerunOcrPage, updateOcrPage, type ImageOcrMode } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

export function BookBuilderPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [createForm, setCreateForm] = useState({ authorName: "", synopsis: "", title: "" });
  const [selectedCreateFiles, setSelectedCreateFiles] = useState<File[]>([]);
  const [selectedAppendFiles, setSelectedAppendFiles] = useState<File[]>([]);
  const [selectedBookId, setSelectedBookId] = useState("");
  const [reviewBookId, setReviewBookId] = useState("");
  const [reviewPageNumber, setReviewPageNumber] = useState(1);
  const [editedText, setEditedText] = useState("");
  const [createOcrMode, setCreateOcrMode] = useState<ImageOcrMode>("VISION");
  const [appendOcrMode, setAppendOcrMode] = useState<ImageOcrMode>("VISION");
  const [reviewOcrMode, setReviewOcrMode] = useState<ImageOcrMode>("VISION");
  const [createError, setCreateError] = useState<string | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);
  const requestedAppendBookId = searchParams.get("appendBookId")?.trim() ?? "";
  const requestedInsertAfterPageParam = searchParams.get("insertAfterPage")?.trim() ?? "";
  const requestedReviewBookId = searchParams.get("reviewBookId")?.trim() ?? "";
  const requestedReviewPageParam = searchParams.get("reviewPage")?.trim() ?? "";
  const isAppendOnlyMode = requestedAppendBookId.length > 0;
  const isReviewOnlyMode = requestedReviewBookId.length > 0;
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
  const selectedReviewBook = imageBooks.find((book) => book.bookId === reviewBookId) ?? null;
  const selectedAppendBook = imageBooks.find((book) => book.bookId === selectedBookId) ?? null;
  const requestedReviewPage = requestedReviewPageParam ? Number(requestedReviewPageParam) : Number.NaN;
  const requestedInsertAfterPage = requestedInsertAfterPageParam ? Number(requestedInsertAfterPageParam) : Number.NaN;
  const appendAfterPageNumber = selectedAppendBook && selectedAppendBook.bookId === requestedAppendBookId && Number.isInteger(requestedInsertAfterPage)
    ? Math.min(Math.max(requestedInsertAfterPage, 0), selectedAppendBook.totalPages)
    : undefined;

  const reviewPageQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-page", reviewBookId, reviewPageNumber],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchBookPage(accessToken, reviewBookId, reviewPageNumber);
    }
  });

  useEffect(() => {
    const firstImageBook = imageBooks[0];
    const hasRequestedAppendBook = requestedAppendBookId
      ? imageBooks.some((book) => book.bookId === requestedAppendBookId)
      : false;
    const requestedReviewBook = requestedReviewBookId
      ? imageBooks.find((book) => book.bookId === requestedReviewBookId) ?? null
      : null;

    if (!firstImageBook) {
      setSelectedBookId("");
      setReviewBookId("");
      return;
    }

    if (!selectedBookId) {
      if (hasRequestedAppendBook) {
        setSelectedBookId(requestedAppendBookId);
      } else {
        setSelectedBookId(firstImageBook.bookId);
      }
    } else if (!imageBooks.some((book) => book.bookId === selectedBookId)) {
      setSelectedBookId(firstImageBook.bookId);
    }

    if (!isReviewOnlyMode) {
      setReviewBookId("");
      return;
    }

    if (!reviewBookId) {
      if (requestedReviewBook) {
        setReviewBookId(requestedReviewBook.bookId);
        setReviewPageNumber(
          Number.isInteger(requestedReviewPage)
            ? Math.min(Math.max(requestedReviewPage, 1), requestedReviewBook.totalPages)
            : 1
        );
      } else {
        setReviewBookId(firstImageBook.bookId);
        setReviewPageNumber(1);
      }
    } else if (!imageBooks.some((book) => book.bookId === reviewBookId)) {
      setReviewBookId(firstImageBook.bookId);
      setReviewPageNumber(1);
    }
  }, [imageBooks, isReviewOnlyMode, requestedAppendBookId, requestedReviewBookId, requestedReviewPage, reviewBookId, selectedBookId]);

  useEffect(() => {
    const page = reviewPageQuery.data?.page;

    if (!page) {
      return;
    }

    setEditedText(page.editedText ?? page.rawText ?? page.paragraphs.map((paragraph) => paragraph.paragraphText).join("\n\n"));
    setReviewError(null);
  }, [reviewBookId, reviewPageNumber, reviewPageQuery.data?.page]);

  useEffect(() => {
    let active = true;
    let nextObjectUrl: string | null = null;

    if (!isReviewOnlyMode || !accessToken || !reviewBookId || !reviewPageQuery.data?.page.hasSourceImage) {
      setReviewImageUrl(null);
      return () => {
        active = false;
      };
    }

    void fetchBookPageImage(accessToken, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.sourceFileId)
      .then((imageBlob) => {
        if (!active) {
          return;
        }

        nextObjectUrl = URL.createObjectURL(imageBlob);
        setReviewImageUrl(nextObjectUrl);
      })
      .catch(() => {
        if (active) {
          setReviewImageUrl(null);
        }
      });

    return () => {
      active = false;
      if (nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
      }
    };
  }, [accessToken, isReviewOnlyMode, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.hasSourceImage, reviewPageQuery.data?.page.sourceFileId]);

  function toFileArray(fileList: FileList | null): File[] {
    return fileList ? Array.from(fileList) : [];
  }

  function isSupportedImageFile(file: File): boolean {
    const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    const normalizedName = file.name.toLowerCase();

    return supportedMimeTypes.has(file.type) || /\.(jpe?g|png|webp)$/u.test(normalizedName);
  }

  function appendFiles(files: File[]) {
    const validFiles = files.filter(isSupportedImageFile);
    const invalidFiles = files.filter((file) => !isSupportedImageFile(file));

    setSelectedAppendFiles((currentFiles) => [...currentFiles, ...validFiles]);

    if (invalidFiles.length > 0) {
      const invalidNames = invalidFiles.map((file) => file.name).join(", ");
      setAppendError(`Algunas imágenes no se pueden usar todavía (${invalidNames}). Usa PNG, JPG o WEBP.`);
      return;
    }

    setAppendError(null);
  }

  function handleAppendFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    appendFiles(toFileArray(event.target.files));
    event.target.value = "";
  }

  function clearAppendSelection() {
    setSelectedAppendFiles([]);
    setAppendError(null);
  }

  function describeOcrMode(mode: ImageOcrMode): string {
    return mode === "VISION"
      ? "Más preciso para fotos difíciles y páginas con ruido. Tarda más."
      : "Más rápido para páginas limpias. También recorta encabezado y pie antes del OCR.";
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

      const response = await createImageBook(accessToken, formData, { ocrMode: createOcrMode });
      await booksQuery.refetch();
      setReviewBookId(response.book.bookId);
      setReviewPageNumber(1);
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

      const response = await appendImagesToBook(accessToken, selectedBookId, formData, {
        ...(appendAfterPageNumber !== undefined ? { afterPage: appendAfterPageNumber } : {}),
        ocrMode: appendOcrMode
      });
      await booksQuery.refetch();
      clearAppendSelection();
      if (reviewBookId === selectedBookId) {
        setReviewPageNumber(response.insertionStartPageNumber);
      }
      navigate(`/books/${response.book.bookId}?page=${response.insertionStartPageNumber}`);
    } catch (error) {
      setAppendError(error instanceof Error ? error.message : "No se pudieron añadir nuevas páginas.");
    } finally {
      setIsAppending(false);
    }
  }

  async function handleSaveOcr(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || !reviewBookId) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);

    try {
      await updateOcrPage(accessToken, reviewBookId, reviewPageNumber, { editedText });
      setReviewMessage("El texto OCR de la página se actualizó correctamente.");
      await Promise.all([reviewPageQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo guardar la edición OCR.");
    } finally {
      setIsSavingReview(false);
    }
  }

  async function handleRerunOcr() {
    if (!accessToken || !reviewBookId) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);

    try {
      await rerunOcrPage(accessToken, reviewBookId, reviewPageNumber, { ocrMode: reviewOcrMode });
      setReviewMessage("El OCR de la página se volvió a reconocer correctamente.");
      await Promise.all([reviewPageQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo volver a reconocer el OCR de la página.");
    } finally {
      setIsSavingReview(false);
    }
  }

  function handleReviewBookChange(nextBookId: string) {
    setReviewBookId(nextBookId);
    setReviewPageNumber(1);
    setReviewMessage(null);
    setReviewError(null);
  }

  function changeReviewPage(delta: -1 | 1) {
    const totalPages = selectedReviewBook?.totalPages ?? 0;
    setReviewPageNumber((currentPage) => {
      const nextPage = currentPage + delta;
      return Math.min(Math.max(nextPage, 1), Math.max(totalPages, 1));
    });
    setReviewMessage(null);
    setReviewError(null);
  }

  return (
    <div className="page-stack">
      {!isReviewOnlyMode ? (
        <section className="panel wide-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">{isAppendOnlyMode ? "Libro actual" : "Constructor de libros"}</p>
              <h2>{isAppendOnlyMode ? "Añadir páginas al libro" : "OCR desde imágenes"}</h2>
            </div>
            <Link className="secondary-button link-button" to="/">
              Volver
            </Link>
          </div>

          <div className="builder-board">
            {!isAppendOnlyMode ? (
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

                  <label>
                    Modo OCR
                    <select onChange={(event) => setCreateOcrMode(event.target.value as ImageOcrMode)} value={createOcrMode}>
                      <option value="VISION">OCR preciso con IA</option>
                      <option value="LOCAL">OCR rápido</option>
                    </select>
                  </label>

                  <p className="helper-text">{describeOcrMode(createOcrMode)}</p>
                  <p className="helper-text">El sistema recorta automáticamente la parte superior e inferior de la página para evitar encabezados y números de página.</p>

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
            ) : null}

            <article className="builder-form-card">
              <h3>Añadir páginas a un libro existente</h3>
              <p className="subdued">Úsalo para seguir ampliando un libro que ya empezaste a leer. Si vienes desde el lector, las páginas nuevas se insertarán justo después de la página en la que estabas.</p>

              <form className="stack-form" id="append-pages" onSubmit={handleAppendImages}>
                <label>
                  Libro de imágenes
                  <select onChange={(event) => setSelectedBookId(event.target.value)} value={selectedBookId}>
                    <option value="">Selecciona un libro</option>
                    {imageBooks.map((book) => (
                      <option key={book.bookId} value={book.bookId}>{book.title}</option>
                    ))}
                  </select>
                </label>

                {selectedAppendBook ? (
                  <div className="selected-book-banner">
                    <strong>Libro seleccionado:</strong>
                    <span>{selectedAppendBook.title}</span>
                  </div>
                ) : null}

                {selectedAppendBook && appendAfterPageNumber !== undefined ? (
                  <div className="selected-book-banner">
                    <strong>Posición de inserción:</strong>
                    <span>
                      {appendAfterPageNumber === 0
                        ? "Las nuevas páginas se añadirán al principio del libro."
                        : `Se insertarán después de la página ${appendAfterPageNumber}.`}
                    </span>
                  </div>
                ) : null}

                <div className="capture-input-grid">
                  <label>
                    Nuevas imágenes
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={handleAppendFileSelection}
                      type="file"
                    />
                  </label>

                  <label>
                    Añadir desde cámara
                    <input
                      accept="image/*"
                      capture="environment"
                      onChange={handleAppendFileSelection}
                      type="file"
                    />
                  </label>
                </div>

                <p className="helper-text">Desde el móvil se abrirá la cámara si el navegador lo permite. En escritorio, la disponibilidad depende del navegador y del sistema.</p>

                <label>
                  Modo OCR
                  <select onChange={(event) => setAppendOcrMode(event.target.value as ImageOcrMode)} value={appendOcrMode}>
                    <option value="VISION">OCR preciso con IA</option>
                    <option value="LOCAL">OCR rápido</option>
                  </select>
                </label>

                <p className="helper-text">{describeOcrMode(appendOcrMode)}</p>
                <p className="helper-text">También aquí se recorta automáticamente el encabezado y el pie antes de reconocer el contenido.</p>

                {selectedAppendFiles.length > 0 ? (
                  <>
                    <div className="file-pill-list">
                      {selectedAppendFiles.map((file, index) => (
                        <span className="file-pill" key={`${file.name}-${index}`}>{file.name}</span>
                      ))}
                    </div>
                    <button className="text-button align-start" onClick={clearAppendSelection} type="button">
                      Limpiar selección
                    </button>
                  </>
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
      ) : null}

      {isReviewOnlyMode ? (
      <section className="panel wide-panel" id="review-ocr">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Revisión</p>
            <h2>Edición manual del OCR</h2>
          </div>
          {selectedReviewBook ? (
            <Link className="secondary-button link-button" to={`/books/${selectedReviewBook.bookId}`}>
              Abrir lector
            </Link>
          ) : null}
        </div>

        {imageBooks.length === 0 ? (
          <div className="empty-state">
            <p>Todavía no hay libros creados desde imágenes para revisar.</p>
          </div>
        ) : (
          <>
            <div className="review-toolbar">
              <label className="toolbar-field">
                Libro de imágenes
                <select onChange={(event) => handleReviewBookChange(event.target.value)} value={reviewBookId}>
                  {imageBooks.map((book) => (
                    <option key={book.bookId} value={book.bookId}>{book.title}</option>
                  ))}
                </select>
              </label>

              <div className="page-switcher">
                <button
                  className="secondary-button"
                  disabled={reviewPageNumber <= 1}
                  onClick={() => changeReviewPage(-1)}
                  type="button"
                >
                  Página anterior
                </button>
                <span className="page-counter">
                  Página {reviewPageNumber} de {selectedReviewBook?.totalPages ?? 0}
                </span>
                <button
                  className="secondary-button"
                  disabled={reviewPageNumber >= (selectedReviewBook?.totalPages ?? 0)}
                  onClick={() => changeReviewPage(1)}
                  type="button"
                >
                  Página siguiente
                </button>
              </div>
            </div>

            {reviewPageQuery.isLoading ? <p className="subdued">Cargando página para revisión...</p> : null}
            {reviewPageQuery.isError ? <p className="error-text">No se pudo cargar la página seleccionada.</p> : null}

            <div className="builder-review-grid">
              <article className="review-panel">
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">Original</p>
                    <h3>Imagen de la página</h3>
                  </div>
                  <span className="tag-chip">{reviewPageQuery.data?.page.ocrStatus ?? "-"}</span>
                </div>

                {reviewImageUrl ? (
                  <img alt={`Página ${reviewPageNumber} para revisión OCR`} className="preview-image" src={reviewImageUrl} />
                ) : (
                  <div className="empty-state compact-state">
                    <p>No hay imagen asociada a esta página.</p>
                  </div>
                )}
              </article>

              <article className="review-panel">
                <form className="stack-form" onSubmit={handleSaveOcr}>
                  <div className="source-panel-header">
                    <div>
                      <p className="page-label">Edición</p>
                      <h3>Texto corregido</h3>
                    </div>
                  </div>

                  <label>
                    Texto de la página
                    <textarea
                      className="ocr-editor"
                      onChange={(event) => setEditedText(event.target.value)}
                      rows={18}
                      value={editedText}
                    />
                  </label>

                  <p className="helper-text">Separa párrafos dejando una línea en blanco entre ellos.</p>

                  <label>
                    Volver a reconocer con
                    <select onChange={(event) => setReviewOcrMode(event.target.value as ImageOcrMode)} value={reviewOcrMode}>
                      <option value="VISION">OCR preciso con IA</option>
                      <option value="LOCAL">OCR rápido</option>
                    </select>
                  </label>

                  <p className="helper-text">{describeOcrMode(reviewOcrMode)}</p>

                  {reviewError ? <p className="error-text">{reviewError}</p> : null}
                  {reviewMessage ? <p className="success-text">{reviewMessage}</p> : null}

                  <button className="secondary-button" disabled={isSavingReview || !reviewBookId} onClick={() => void handleRerunOcr()} type="button">
                    {isSavingReview ? "Reconociendo OCR..." : "Volver a reconocer OCR"}
                  </button>

                  <button className="primary-button" disabled={isSavingReview || !reviewBookId} type="submit">
                    {isSavingReview ? "Guardando OCR..." : "Guardar corrección de página"}
                  </button>
                </form>
              </article>
            </div>
          </>
        )}
      </section>
      ) : null}
    </div>
  );
}