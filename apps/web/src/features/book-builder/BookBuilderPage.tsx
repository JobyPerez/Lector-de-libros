import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  appendImagesToBook,
  createImageBook,
  fetchBookPage,
  fetchBookPageImage,
  fetchBooks,
  fetchReaderNavigation,
  rerunOcrPage,
  updateOcrPage,
  type ImageOcrMode,
  type ReaderBookmark,
  type ReaderNote,
  type ReaderTocEntry,
  type HighlightColor
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { buildOcrPreviewHtml } from "./ocr-preview";

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

function ToolbarIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function NavigationIcon() {
  return (
    <ToolbarIcon>
      <path d="M5.5 7.25H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 12H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 16.75H14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="17.5" cy="16.75" fill="currentColor" r="1.2" />
    </ToolbarIcon>
  );
}

function CloseIcon() {
  return (
    <ToolbarIcon>
      <path d="M8 8L16 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M16 8L8 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function PagePreviousIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M17 7L10 12L17 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function PageNextIcon() {
  return (
    <ToolbarIcon>
      <path d="M17 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M7 7L14 12L7 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function SaveOcrIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 5.5H15.8L18.5 8.2V18C18.5 18.8284 17.8284 19.5 17 19.5H7C6.17157 19.5 5.5 18.8284 5.5 18V7C5.5 6.17157 6.17157 5.5 7 5.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8.5 5.5V10H14.5V5.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 15H15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

type ReviewNavigationItem =
  | {
      isActive: boolean;
      key: string;
      level: number;
      pageNumber: number;
      paragraphNumber: number;
      title: string;
      type: "toc";
    }
  | {
      bookmarkId: string;
      isActive: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      title: string;
      type: "bookmark";
    }
  | {
      color: HighlightColor | null;
      excerpt: string;
      isActive: boolean;
      key: string;
      noteId: string;
      noteText: string;
      pageNumber: number;
      paragraphNumber: number;
      type: "note";
    };

function formatRelativeAnchor(pageNumber: number, paragraphNumber: number | null | undefined) {
  return paragraphNumber ? `Pág. ${pageNumber} · párr. ${paragraphNumber}` : `Pág. ${pageNumber}`;
}

function formatPageAnchor(pageNumber: number) {
  return `Pág. ${pageNumber}`;
}

function notePreview(note: ReaderNote) {
  const sourceExcerpt = note.highlightedText?.trim();
  if (sourceExcerpt) {
    return sourceExcerpt;
  }

  return note.noteText;
}

function tocEntryKey(entry: ReaderTocEntry) {
  return `${entry.pageNumber}:${entry.paragraphNumber}:${entry.title}`;
}

function highlightClassName(color: HighlightColor) {
  switch (color) {
    case "GREEN":
      return "reader-text-highlight-green";
    case "BLUE":
      return "reader-text-highlight-blue";
    case "PINK":
      return "reader-text-highlight-pink";
    case "YELLOW":
    default:
      return "reader-text-highlight-yellow";
  }
}

export function BookBuilderPage() {
  const location = useLocation();
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
  const [originalEditedText, setOriginalEditedText] = useState("");
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
  const [isReviewIndexVisible, setIsReviewIndexVisible] = useState(false);
  const [isReviewOcrMenuVisible, setIsReviewOcrMenuVisible] = useState(false);
  const [isReviewPageJumpActive, setIsReviewPageJumpActive] = useState(false);
  const [reviewPageJumpValue, setReviewPageJumpValue] = useState("1");
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);
  const reviewPageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const requestedAppendBookId = searchParams.get("appendBookId")?.trim() ?? "";
  const requestedInsertAfterPageParam = searchParams.get("insertAfterPage")?.trim() ?? "";
  const requestedReviewBookId = searchParams.get("reviewBookId")?.trim() ?? "";
  const requestedReviewPageParam = searchParams.get("reviewPage")?.trim() ?? "";
  const returnTo = typeof location.state === "object"
    && location.state !== null
    && "returnTo" in location.state
    && typeof location.state.returnTo === "string"
      ? location.state.returnTo
      : null;
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

  const reviewNavigationQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-navigation", reviewBookId],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchReaderNavigation(accessToken, reviewBookId);
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

    const nextEditedText = page.editedText ?? page.rawText ?? page.paragraphs.map((paragraph) => paragraph.paragraphText).join("\n\n");
    setEditedText(nextEditedText);
    setOriginalEditedText(nextEditedText);
    setReviewError(null);
  }, [reviewBookId, reviewPageNumber, reviewPageQuery.data?.page]);

  useEffect(() => {
    if (isReviewPageJumpActive) {
      return;
    }

    setReviewPageJumpValue(String(reviewPageNumber));
  }, [isReviewPageJumpActive, reviewPageNumber]);

  useEffect(() => {
    if (!isReviewPageJumpActive || typeof window === "undefined") {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      reviewPageJumpInputRef.current?.focus();
      reviewPageJumpInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isReviewPageJumpActive]);

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
      setOriginalEditedText(editedText);
      setReviewMessage("El texto OCR de la página se actualizó correctamente.");
      await Promise.all([reviewPageQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo guardar la edición OCR.");
    } finally {
      setIsSavingReview(false);
    }
  }

  async function handleRerunOcr(modeOverride?: ImageOcrMode) {
    if (!accessToken || !reviewBookId) {
      return;
    }

    const nextMode = modeOverride ?? reviewOcrMode;

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);
    setIsReviewOcrMenuVisible(false);

    try {
      setReviewOcrMode(nextMode);
      await rerunOcrPage(accessToken, reviewBookId, reviewPageNumber, { ocrMode: nextMode });
      setReviewMessage("El OCR de la página se volvió a reconocer correctamente.");
      await Promise.all([reviewPageQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo volver a reconocer el OCR de la página.");
    } finally {
      setIsSavingReview(false);
    }
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

  function jumpToReviewPage(pageNumber: number) {
    const totalPages = selectedReviewBook?.totalPages ?? 0;
    setReviewPageNumber(Math.min(Math.max(pageNumber, 1), Math.max(totalPages, 1)));
    setReviewMessage(null);
    setReviewError(null);
    setIsReviewIndexVisible(false);
  }

  function cancelReviewPageJump() {
    setIsReviewPageJumpActive(false);
    setReviewPageJumpValue(String(reviewPageNumber));
  }

  function parseReviewPageJumpValue() {
    const parsedValue = Number.parseInt(reviewPageJumpValue.trim(), 10);
    if (!Number.isFinite(parsedValue)) {
      return null;
    }

    const totalPages = selectedReviewBook?.totalPages ?? 0;
    return Math.min(Math.max(parsedValue, 1), Math.max(totalPages, 1));
  }

  function handleReviewPageJumpSubmit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const nextPageNumber = parseReviewPageJumpValue();
    if (nextPageNumber === null) {
      cancelReviewPageJump();
      return;
    }

    setIsReviewPageJumpActive(false);
    jumpToReviewPage(nextPageNumber);
  }

  function handleBackFromReview() {
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    if (selectedReviewBook) {
      navigate(`/books/${selectedReviewBook.bookId}?page=${reviewPageNumber}`);
      return;
    }

    navigate("/");
  }

  const isReviewDirty = editedText !== originalEditedText;
  const reviewPreviewHtml = useMemo(
    () => buildOcrPreviewHtml(editedText, reviewPageQuery.data?.page.htmlContent ?? null),
    [editedText, reviewPageQuery.data?.page.htmlContent]
  );
  const activeTocEntryKey = useMemo(() => {
    const tocEntries = reviewNavigationQuery.data?.toc ?? [];
    let activeEntry: ReaderTocEntry | null = null;

    for (const entry of tocEntries) {
      if (entry.pageNumber <= reviewPageNumber) {
        activeEntry = entry;
      }
    }

    return activeEntry ? tocEntryKey(activeEntry) : null;
  }, [reviewNavigationQuery.data?.toc, reviewPageNumber]);
  const orderedNavigationItems = useMemo<ReviewNavigationItem[]>(() => {
    const tocItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.toc ?? []).map((entry) => ({
      isActive: activeTocEntryKey === tocEntryKey(entry),
      key: `toc:${tocEntryKey(entry)}`,
      level: entry.level,
      pageNumber: entry.pageNumber,
      paragraphNumber: entry.paragraphNumber,
      title: entry.title,
      type: "toc"
    }));

    const bookmarkItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.bookmarks ?? []).map((bookmark: ReaderBookmark) => ({
      bookmarkId: bookmark.bookmarkId,
      isActive: bookmark.pageNumber === reviewPageNumber,
      key: `bookmark:${bookmark.bookmarkId}`,
      pageNumber: bookmark.pageNumber,
      paragraphNumber: bookmark.paragraphNumber,
      title: "Marcador guardado",
      type: "bookmark"
    }));

    const noteItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.notes ?? []).map((note: ReaderNote) => ({
      color: note.highlightColor,
      excerpt: notePreview(note),
      isActive: note.pageNumber === reviewPageNumber,
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      noteText: note.noteText,
      pageNumber: note.pageNumber,
      paragraphNumber: note.paragraphNumber ?? 1,
      type: "note"
    }));

    const sortWeight = { bookmark: 1, note: 2, toc: 0 } as const;

    return [...tocItems, ...bookmarkItems, ...noteItems].sort((left, right) => {
      if (left.pageNumber !== right.pageNumber) {
        return left.pageNumber - right.pageNumber;
      }

      if (left.paragraphNumber !== right.paragraphNumber) {
        return left.paragraphNumber - right.paragraphNumber;
      }

      return sortWeight[left.type] - sortWeight[right.type];
    });
  }, [activeTocEntryKey, reviewNavigationQuery.data?.bookmarks, reviewNavigationQuery.data?.notes, reviewNavigationQuery.data?.toc, reviewPageNumber]);

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
      <>
      <section className="panel wide-panel review-ocr-panel" id="review-ocr">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Edición</p>
            <h2>{selectedReviewBook?.title ?? "Cargando libro..."}</h2>
          </div>
          <button
            aria-label="Volver al lector"
            className="secondary-button reader-header-icon-button"
            onClick={handleBackFromReview}
            title="Volver al lector"
            type="button"
          >
            <BackIcon />
          </button>
        </div>

        {imageBooks.length === 0 ? (
          <div className="empty-state">
            <p>Todavía no hay libros creados desde imágenes para revisar.</p>
          </div>
        ) : (
          <>
            {reviewPageQuery.isLoading ? <p className="subdued">Cargando página para revisión...</p> : null}
            {reviewPageQuery.isError ? <p className="error-text">No se pudo cargar la página seleccionada.</p> : null}

            <div className="builder-review-grid">
              <article className="review-panel">
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">Imagen original</p>
                  </div>
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
                <form className="stack-form" id="ocr-review-form" onSubmit={handleSaveOcr}>
                  <label>
                    Edición de la página
                    <textarea
                      className="ocr-editor"
                      onChange={(event) => setEditedText(event.target.value)}
                      rows={18}
                      value={editedText}
                    />
                  </label>

                  <p className="helper-text">Separa párrafos dejando una línea en blanco entre ellos. También puedes usar # y ## para títulos, **texto** para negrita, *texto* para cursiva y ![alt](url) para incrustar una imagen.</p>

                  {reviewPreviewHtml ? (
                    <div>
                      <p className="page-label">Previsualización de la página guardada</p>
                      <article className="reader-prose reader-prose-rich">
                        <div
                          className="reader-rich-content"
                          dangerouslySetInnerHTML={{ __html: reviewPreviewHtml }}
                        />
                      </article>
                    </div>
                  ) : null}

                  {reviewError ? <p className="error-text">{reviewError}</p> : null}
                  {reviewMessage ? <p className="success-text">{reviewMessage}</p> : null}
                </form>
              </article>
            </div>
          </>
        )}
      </section>
      {imageBooks.length > 0 ? (
        <>
          {isReviewIndexVisible ? (
            <aside aria-label="Índice de páginas para OCR" className="reader-navigation-panel" role="dialog">
              <div className="reader-navigation-header">
                <div>
                  <p className="eyebrow">Navegación</p>
                  <h3>Índice y notas</h3>
                </div>
                <button
                  aria-label="Cerrar índice"
                  className="reader-icon-ghost"
                  onClick={() => setIsReviewIndexVisible(false)}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>

              <section className="reader-navigation-section">
                <div className="reader-navigation-section-heading">
                  <strong>Índice del libro</strong>
                  <span>{orderedNavigationItems.length}</span>
                </div>
                {orderedNavigationItems.length ? (
                  <div className="reader-navigation-list">
                    {orderedNavigationItems.map((item) => {
                      if (item.type === "toc") {
                        return (
                          <button
                            className={item.isActive ? "reader-navigation-item active" : "reader-navigation-item"}
                            key={item.key}
                            onClick={() => jumpToReviewPage(item.pageNumber)}
                            style={{ "--toc-level": String(Math.max(0, item.level - 1)) } as React.CSSProperties}
                            type="button"
                          >
                            <div className="reader-navigation-item-topline">
                              <strong>{item.title}</strong>
                              <span className="reader-navigation-inline-meta">{formatPageAnchor(item.pageNumber)}</span>
                            </div>
                          </button>
                        );
                      }

                      if (item.type === "bookmark") {
                        return (
                          <article className={item.isActive ? "reader-note-card reader-navigation-item-bookmark-card active" : "reader-note-card reader-navigation-item-bookmark-card"} key={item.key}>
                            <button
                              className="reader-navigation-item reader-navigation-item-bookmark"
                              onClick={() => jumpToReviewPage(item.pageNumber)}
                              type="button"
                            >
                              <div className="reader-navigation-item-topline">
                                <span className="reader-navigation-chip reader-navigation-chip-bookmark">■</span>
                                <strong>{item.title}</strong>
                                <span className="reader-navigation-inline-meta">{formatPageAnchor(item.pageNumber)}</span>
                              </div>
                            </button>
                          </article>
                        );
                      }

                      return (
                        <article className={item.isActive ? "reader-note-card reader-navigation-item-note active" : "reader-note-card reader-navigation-item-note"} key={item.key}>
                          <button
                            className="reader-note-jump"
                            onClick={() => jumpToReviewPage(item.pageNumber)}
                            type="button"
                          >
                            <div className="reader-navigation-item-topline">
                              <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
                              <strong>{item.excerpt}</strong>
                              <span className="reader-navigation-inline-meta">{formatRelativeAnchor(item.pageNumber, item.paragraphNumber)}</span>
                            </div>
                          </button>
                          <p>{item.noteText}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="reader-navigation-empty">Este libro no trae índice estructurado. Aquí seguirás viendo marcadores y notas.</p>
                )}
              </section>

              <section className="reader-navigation-section">
                <div className="reader-navigation-section-heading">
                  <strong>Notas</strong>
                  <span>{reviewNavigationQuery.data?.notes.length ?? 0}</span>
                </div>
                <p className="reader-navigation-empty">Las notas y marcadores aparecen integrados dentro del índice según su posición en el libro.</p>
              </section>
            </aside>
          ) : null}

          <div aria-label="Controles de edición OCR" className="review-floating-controls" role="toolbar">
            <div aria-live="polite" className="reader-floating-status review-floating-status">
              <form className="reader-page-jump-form" onSubmit={(event) => handleReviewPageJumpSubmit(event)}>
                <label className="reader-page-jump-label">
                  <input
                    aria-label="Página actual"
                    className="reader-page-jump-input"
                    inputMode="numeric"
                    max={selectedReviewBook?.totalPages || undefined}
                    min={1}
                    onBlur={() => {
                      handleReviewPageJumpSubmit();
                    }}
                    onChange={(event) => setReviewPageJumpValue(event.target.value.replace(/[^\d]/gu, ""))}
                    onFocus={() => setIsReviewPageJumpActive(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelReviewPageJump();
                      }
                    }}
                    onPointerDown={() => setIsReviewPageJumpActive(true)}
                    ref={reviewPageJumpInputRef}
                    size={Math.max(String(selectedReviewBook?.totalPages || reviewPageNumber).length, 2)}
                    type="text"
                    value={isReviewPageJumpActive ? reviewPageJumpValue : String(reviewPageNumber)}
                  />
                  <strong>/ {selectedReviewBook?.totalPages ?? 0}</strong>
                </label>
              </form>
            </div>

            <button
              aria-expanded={isReviewIndexVisible}
              aria-label="Abrir índice de páginas"
              className={isReviewIndexVisible ? "reader-float-button active" : "reader-float-button"}
              onClick={() => setIsReviewIndexVisible((current) => !current)}
              title="Índice de páginas"
              type="button"
            >
              <NavigationIcon />
            </button>

            <button
              aria-label="Página anterior"
              className="reader-float-button"
              disabled={reviewPageNumber <= 1}
              onClick={() => changeReviewPage(-1)}
              title="Página anterior"
              type="button"
            >
              <PagePreviousIcon />
            </button>

            <button
              aria-label="Página siguiente"
              className="reader-float-button"
              disabled={reviewPageNumber >= (selectedReviewBook?.totalPages ?? 0)}
              onClick={() => changeReviewPage(1)}
              title="Página siguiente"
              type="button"
            >
              <PageNextIcon />
            </button>

            <div className="review-floating-ocr-menu">
              {isReviewOcrMenuVisible ? (
                <div aria-label="Opciones de OCR" className="review-floating-ocr-panel" role="dialog">
                  <p className="review-floating-ocr-title">Volver a reconocer con</p>
                  <button
                    className={reviewOcrMode === "VISION" ? "review-ocr-option active" : "review-ocr-option"}
                    disabled={isSavingReview || !reviewBookId}
                    onClick={() => void handleRerunOcr("VISION")}
                    type="button"
                  >
                    <strong>Preciso con IA</strong>
                    <span>Mayor precisión para páginas difíciles.</span>
                  </button>
                  <button
                    className={reviewOcrMode === "LOCAL" ? "review-ocr-option active" : "review-ocr-option"}
                    disabled={isSavingReview || !reviewBookId}
                    onClick={() => void handleRerunOcr("LOCAL")}
                    type="button"
                  >
                    <strong>Rápido local</strong>
                    <span>Más veloz para páginas limpias.</span>
                  </button>
                </div>
              ) : null}

              <button
                aria-expanded={isReviewOcrMenuVisible}
                aria-label={isSavingReview ? "Reconociendo OCR" : "Opciones de OCR"}
                className={isReviewOcrMenuVisible ? "reader-float-button review-ocr-text-button active" : "reader-float-button review-ocr-text-button"}
                disabled={isSavingReview || !reviewBookId}
                onClick={() => setIsReviewOcrMenuVisible((current) => !current)}
                title={isSavingReview ? "Reconociendo OCR..." : "Opciones de OCR"}
                type="button"
              >
                <span>OCR</span>
              </button>
            </div>

            <button
              aria-label={isSavingReview ? "Guardando correcciones" : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar correcciones")}
              className="reader-float-button primary"
              disabled={isSavingReview || !reviewBookId || !isReviewDirty}
              form="ocr-review-form"
              title={isSavingReview ? "Guardando correcciones..." : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar correcciones")}
              type="submit"
            >
              <SaveOcrIcon />
            </button>
          </div>
        </>
      ) : null}
      </>
      ) : null}
    </div>
  );
}