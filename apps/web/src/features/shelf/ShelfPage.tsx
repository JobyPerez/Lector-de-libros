import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { createBookDownloadUrl, deleteBook, fetchBookCover, fetchBooks, importBook, inspectBookImport, leaveBookShare, updateBook, type BookRole, type BookScope, type BookSummary, type ReadingStatus } from "../../app/api";
import { BOOK_LANGUAGE_OPTIONS, getBookLanguageLabel, type BookLanguageCode } from "../../app/book-language";
import { useAuthStore } from "../../app/auth-store";
import notionIconUrl from "../../assets/notion.svg";
import { ShareBookModal } from "../sharing/ShareBookModal";

export type ShelfSortMode = "lastOpened" | "rating";

type BookEditFormState = {
  authorName: string;
  languageCode: BookLanguageCode;
  notionBookUrl: string;
  rating: number | null;
  readingStatus: ReadingStatus;
  title: string;
  userComments: string;
};

type ShelfView = "edit" | "import" | "shelf";
type ShelfViewTransitionDirection = "back" | "forward";

const emptyBookEditForm: BookEditFormState = {
  authorName: "",
  languageCode: "es",
  notionBookUrl: "",
  rating: null,
  readingStatus: "WANT_TO_READ",
  title: "",
  userComments: ""
};

const READING_STATUS_CONFIG: { id: ReadingStatus; label: string }[] = [
  { id: "READING", label: "Leyendo" },
  { id: "WANT_TO_READ", label: "Pendiente" },
  { id: "READ", label: "Terminado" },
  { id: "ABANDONED", label: "Abandonado" }
];

const RATING_LABELS: Record<number, string> = {
  1: "1 - No me gustó nada",
  2: "2 - No me gustó",
  3: "3 - Normalito",
  4: "4 - Me gustó",
  5: "5 - Me gustó mucho"
};

const removalExitAnimationMs = 280;
const shelfNumberFormatter = new Intl.NumberFormat("es-ES");

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

function ShareIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8.2 10.9 7.6-3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="m8.2 13.1 7.6 3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
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

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
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

function BookSearchChoiceIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7 7h9M7 11h9M7 15h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function TextSearchChoiceIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M4 6h16M4 11h10M4 16h8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="17.5" cy="16.5" r="3.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="m19.8 18.8 2.2 2.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="m18 6-12 12M6 6l12 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" className={filled ? "star-icon is-filled" : "star-icon"} fill={filled ? "currentColor" : "none"} viewBox="0 0 24 24">
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function StarRatingInput({
  value,
  onChange
}: {
  value: number | null;
  onChange: (rating: number | null) => void;
}) {
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const activeRating = hoverValue ?? value;

  return (
    <div className="star-rating-picker-wrapper">
      <div className="star-rating-picker" onMouseLeave={() => setHoverValue(null)}>
        {[1, 2, 3, 4, 5].map((star) => {
          const isFilled = activeRating !== null && star <= activeRating;
          return (
            <button
              aria-label={`Calificar con ${RATING_LABELS[star]}`}
              className={["star-rating-button", isFilled ? "is-active" : ""].filter(Boolean).join(" ")}
              key={star}
              onClick={(e) => {
                e.preventDefault();
                onChange(value === star ? null : star);
              }}
              onMouseEnter={() => setHoverValue(star)}
              type="button"
            >
              <StarIcon filled={isFilled} />
            </button>
          );
        })}
        {value !== null ? (
          <button
            aria-label="Borrar calificación"
            className="star-rating-clear-button"
            onClick={(e) => {
              e.preventDefault();
              onChange(null);
            }}
            title="Quitar calificación"
            type="button"
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="star-rating-picker-label">
        {activeRating !== null ? (
          <span className="star-rating-active-label">{RATING_LABELS[activeRating]}</span>
        ) : (
          <span className="star-rating-empty-label">Sin calificar</span>
        )}
      </div>
    </div>
  );
}

function startBrowserDownload(downloadUrl: string) {
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
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
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlShelfQuery = searchParams.get("q")?.trim() ?? "";
  const [shelfSearchQuery, setShelfSearchQuery] = useState(urlShelfQuery);
  const [isShelfSearchOpen, setIsShelfSearchOpen] = useState(Boolean(urlShelfQuery));
  const [isSearchMenuOpen, setIsSearchMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [isImportPanelVisible, setIsImportPanelVisible] = useState(false);
  const [editingBook, setEditingBook] = useState<BookSummary | null>(null);
  const [bookForm, setBookForm] = useState<BookEditFormState>(emptyBookEditForm);
  const [importForm, setImportForm] = useState<{ authorName: string; languageCode: BookLanguageCode; title: string }>({
    authorName: "",
    languageCode: "es",
    title: ""
  });
  const [languageSuggestion, setLanguageSuggestion] = useState<"detected" | "metadata" | null>(null);
  const [inspectingLanguage, setInspectingLanguage] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [bookActionError, setBookActionError] = useState<string | null>(null);
  const [bookActionSuccess, setBookActionSuccess] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<"epub" | "pdf" | null>(null);
  const [exportingBookId, setExportingBookId] = useState<string | null>(null);
  const [exportingFormatCard, setExportingFormatCard] = useState<"epub" | "pdf" | null>(null);
  const [isSavingBook, setIsSavingBook] = useState(false);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const [removingBookId, setRemovingBookId] = useState<string | null>(null);
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [downloadMenuBookId, setDownloadMenuBookId] = useState<string | null>(null);
  const [expandedBookIds, setExpandedBookIds] = useState<ReadonlySet<string>>(new Set());
  const [viewTransitionDirection, setViewTransitionDirection] = useState<ShelfViewTransitionDirection>("forward");
  const [shareBook, setShareBook] = useState<BookSummary | null>(null);
  const [sortMode, setSortMode] = useState<ShelfSortMode>("lastOpened");
  const activeView: ShelfView = editingBook ? "edit" : isImportPanelVisible ? "import" : "shelf";
  const canEditBookMetadata = !editingBook?.currentUserRole || editingBook.currentUserRole === "OWNER";
  const requestedScope = searchParams.get("scope");
  const scope: BookScope = requestedScope === "shared" || requestedScope === "all" ? requestedScope : "mine";

  const sharedBooksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["books", "shared"],
    queryFn: async () => {
      if (!accessToken) {
        return [];
      }

      const response = await fetchBooks(accessToken, { scope: "shared" });
      return response.books;
    }
  });

  const hasSharedBooks = (sharedBooksQuery.data?.length ?? 0) > 0;
  const effectiveScope = scope;

  function toggleBookDetails(bookId: string) {
    setExpandedBookIds((current) => {
      const next = new Set(current);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  }

  function selectScope(nextScope: BookScope) {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (nextScope === "mine") {
        nextParams.delete("scope");
      } else {
        nextParams.set("scope", nextScope);
      }
      return nextParams;
    });
  }

  const booksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["books", effectiveScope],
    queryFn: async () => {
      if (!accessToken) {
        return [];
      }

      const response = await fetchBooks(accessToken, { scope: effectiveScope });
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
      formData.append("languageCode", importForm.languageCode);

      if (importForm.title) {
        formData.append("title", importForm.title);
      }

      if (importForm.authorName) {
        formData.append("authorName", importForm.authorName);
      }

      await importBook(accessToken, formData);

      setImportForm({ authorName: "", languageCode: "es", title: "" });
      setLanguageSuggestion(null);
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

  async function handleImportFileChange(file: File | null) {
    setSelectedFile(file);
    setLanguageSuggestion(null);
    if (!file || !accessToken) return;

    setInspectingLanguage(true);
    try {
      const suggestion = await inspectBookImport(accessToken, file);
      if (suggestion.languageCode) {
        setImportForm((current) => ({ ...current, languageCode: suggestion.languageCode ?? current.languageCode }));
        setLanguageSuggestion(suggestion.source);
      }
    } catch {
      // Language inspection is advisory; importing remains available with manual selection.
    } finally {
      setInspectingLanguage(false);
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

  useEffect(() => {
    setShelfSearchQuery(urlShelfQuery);
    if (urlShelfQuery) {
      setIsShelfSearchOpen(true);
    }
  }, [urlShelfQuery]);

  useEffect(() => {
    if (!isSearchMenuOpen && !isCreateMenuOpen) {
      return;
    }

    function handleDocumentClick(event: MouseEvent) {
      if (headerActionsRef.current && !headerActionsRef.current.contains(event.target as Node)) {
        setIsSearchMenuOpen(false);
        setIsCreateMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSearchMenuOpen(false);
        setIsCreateMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCreateMenuOpen, isSearchMenuOpen]);

  function handleShelfSearchChange(value: string) {
    setShelfSearchQuery(value);
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (value.trim()) {
        nextParams.set("q", value);
      } else {
        nextParams.delete("q");
      }
      return nextParams;
    }, { replace: true });
  }

  function openShelfSearch() {
    setIsSearchMenuOpen(false);
    setIsCreateMenuOpen(false);
    setIsShelfSearchOpen(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  }

  function closeShelfSearch() {
    setIsShelfSearchOpen(false);
    setShelfSearchQuery("");
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      nextParams.delete("q");
      return nextParams;
    }, { replace: true });
  }

  function openGlobalSearch() {
    setIsSearchMenuOpen(false);
    setIsCreateMenuOpen(false);
    navigate("/search");
  }

  function startEditingBook(book: BookSummary) {
    setViewTransitionDirection("forward");
    setEditingBook(book);
    setBookForm({
      authorName: book.authorName ?? "",
      languageCode: book.languageCode,
      notionBookUrl: book.notionBookUrl ?? "",
      rating: book.rating ?? null,
      readingStatus: book.readingStatus ?? "WANT_TO_READ",
      title: book.title,
      userComments: book.userComments ?? ""
    });
    setIsCreateMenuOpen(false);
    setIsImportPanelVisible(false);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  function hasUnsavedChanges(): boolean {
    if (!editingBook) {
      return false;
    }
    const originalTitle = editingBook.title.trim();
    const originalAuthor = (editingBook.authorName ?? "").trim();
    const originalNotion = (editingBook.notionBookUrl ?? "").trim();
    const originalLanguageCode = editingBook.languageCode;
    const originalStatus = editingBook.readingStatus ?? "WANT_TO_READ";
    const originalRating = editingBook.rating ?? null;
    const originalComments = (editingBook.userComments ?? "").trim();

    return (
      bookForm.title.trim() !== originalTitle ||
      bookForm.authorName.trim() !== originalAuthor ||
      bookForm.languageCode !== originalLanguageCode ||
      bookForm.notionBookUrl.trim() !== originalNotion ||
      bookForm.readingStatus !== originalStatus ||
      bookForm.rating !== originalRating ||
      bookForm.userComments.trim() !== originalComments
    );
  }

  function resetBookForm() {
    setViewTransitionDirection("back");
    setEditingBook(null);
    setBookForm(emptyBookEditForm);
    setBookActionError(null);
    setBookActionSuccess(null);
    setDownloadMenuBookId(null);
  }

  function handleCancelOrBack() {
    if (hasUnsavedChanges()) {
      const confirmLeave = window.confirm("Tienes cambios sin guardar. Si vuelves a la estantería, se perderán las modificaciones. ¿Deseas continuar?");
      if (!confirmLeave) {
        return;
      }
    }
    resetBookForm();
  }

  async function handleDownloadExport(format: "epub" | "pdf") {
    if (!accessToken || !editingBook) {
      return;
    }

    setBookActionError(null);
    setBookActionSuccess(null);
    setExportingFormat(format);

    try {
      const downloadUrl = await createBookDownloadUrl(accessToken, editingBook.bookId, { format, kind: "export" });
      startBrowserDownload(downloadUrl);
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
      const downloadUrl = await createBookDownloadUrl(accessToken, book.bookId, { kind: "original" });
      startBrowserDownload(downloadUrl);
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
    setExportingBookId(book.bookId);
    setExportingFormatCard(format);

    try {
      const downloadUrl = await createBookDownloadUrl(accessToken, book.bookId, { format, kind: "export" });
      startBrowserDownload(downloadUrl);
    } catch (error) {
      setBookActionError(error instanceof Error ? error.message : `No se pudo exportar el libro a ${format.toUpperCase()}.`);
    } finally {
      setExportingBookId(null);
      setExportingFormatCard(null);
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
        languageCode: bookForm.languageCode,
        notionBookUrl: bookForm.notionBookUrl.trim() || null,
        rating: bookForm.rating,
        readingStatus: bookForm.readingStatus,
        userComments: bookForm.userComments.trim() || null
      });

      await queryClient.invalidateQueries({ queryKey: ["books"] });
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

    const isOwner = !book.currentUserRole || book.currentUserRole === "OWNER";

    if (!isOwner) {
      const ownerLabel = book.ownerUsername ? `@${book.ownerUsername}` : "el propietario";
      const confirmed = window.confirm(
        `Vas a salir del libro compartido "${book.title}" de ${ownerLabel}.\n\n` +
          `Dejarás de tener acceso a este libro y se eliminarán tus notas, marcadores y progreso personales. ` +
          `El libro y las notas de ${ownerLabel} no se verán afectados. ¿Continuar?`
      );
      if (!confirmed) {
        return;
      }

      setBookActionError(null);
      setBookActionSuccess(null);
      setDeletingBookId(book.bookId);

      try {
        await leaveBookShare(accessToken, book.bookId);
        setRemovingBookId(book.bookId);
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, removalExitAnimationMs);
        });
        await booksQuery.refetch();
        setBookActionSuccess(`Dejaste de tener acceso al libro "${book.title}".`);
      } catch (error) {
        setBookActionError(error instanceof Error ? error.message : "No se pudo salir del libro.");
      } finally {
        setRemovingBookId(null);
        setDeletingBookId(null);
      }
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
      try {
        await deleteBook(accessToken, book.bookId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo eliminar el libro.";
        const isShared = /compartido|share/i.test(message);
        if (!isShared) {
          throw error;
        }
        const forceConfirmed = window.confirm(
          "Este libro está compartido con otros usuarios. Si lo borras también se eliminarán sus notas y progreso. ¿Continuar?"
        );
        if (!forceConfirmed) {
          return;
        }
        await deleteBook(accessToken, book.bookId, { force: true });
      }

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

  const allBooks = booksQuery.data ?? [];

  const sortBooks = (books: BookSummary[]) => {
    return [...books].sort((a, b) => {
      if (sortMode === "rating") {
        const ratingA = a.rating ?? 0;
        const ratingB = b.rating ?? 0;
        if (ratingB !== ratingA) {
          return ratingB - ratingA;
        }
      }
      const dateA = new Date(a.lastOpenedAt ?? a.createdAt ?? 0).getTime();
      const dateB = new Date(b.lastOpenedAt ?? b.createdAt ?? 0).getTime();
      return dateB - dateA;
    });
  };

  const normalizedShelfQuery = normalizeSearchText(shelfSearchQuery);

  const matchesShelfQuery = (book: BookSummary) => {
    if (!normalizedShelfQuery) {
      return true;
    }
    const titleNorm = normalizeSearchText(book.title);
    const authorNorm = normalizeSearchText(book.authorName ?? "");
    return titleNorm.includes(normalizedShelfQuery) || authorNorm.includes(normalizedShelfQuery);
  };

  const sectionsWithBooks = READING_STATUS_CONFIG.map((statusConfig) => {
    const matchingBooks = allBooks.filter((book) => {
      const bookStatus = book.readingStatus ?? "WANT_TO_READ";
      return bookStatus === statusConfig.id && matchesShelfQuery(book);
    });
    return {
      ...statusConfig,
      books: sortBooks(matchingBooks)
    };
  }).filter((section) => section.books.length > 0);

  const totalFilteredBooks = sectionsWithBooks.reduce((acc, section) => acc + section.books.length, 0);

  function renderBookCard(book: BookSummary) {
    const isDeletingBook = deletingBookId === book.bookId;
    const removalState = removingBookId === book.bookId
      ? "exiting"
      : isDeletingBook
        ? "pending"
        : undefined;
    const isBookRemoving = removalState !== undefined;
    const isBookOwner = !book.currentUserRole || book.currentUserRole === "OWNER";
    const isExpanded = expandedBookIds.has(book.bookId);
    const detailsId = `shelf-book-details-${book.bookId}`;

    return (
      <article
        aria-busy={isBookRemoving}
        className="book-card shelf-book-card"
        data-download-menu-open={downloadMenuBookId === book.bookId ? "true" : undefined}
        data-expanded={isExpanded ? "true" : undefined}
        data-removing={removalState}
        key={book.bookId}
      >
        <Link aria-disabled={isBookRemoving} className="book-card-link shelf-book-link" tabIndex={isBookRemoving ? -1 : undefined} to={`/books/${book.bookId}`}>
          <div className="shelf-book-cover-shell">
            <ShelfBookCover accessToken={accessToken} book={book} />
          </div>
        </Link>

        <div className="shelf-book-plank-row">
          <button
            aria-controls={detailsId}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Ocultar información de ${book.title}` : `Mostrar información de ${book.title}`}
            className="shelf-book-expand-button"
            disabled={isBookRemoving}
            onClick={() => toggleBookDetails(book.bookId)}
            title={isExpanded ? "Ocultar información" : "Mostrar información"}
            type="button"
          >
            <ChevronDownIcon />
          </button>
        </div>
        <div className="shelf-book-details" id={detailsId}>
          <div className="shelf-book-details-inner">
            <span className="book-spine shelf-book-source-badge">{book.sourceType === "IMAGES" ? "OCR" : book.sourceType}</span>
            <div className="book-card-copy shelf-book-copy">
              <h3>{book.title}</h3>
              <p>{book.authorName ?? "Autor pendiente"}</p>
              {book.currentUserRole && book.currentUserRole !== "OWNER" && book.ownerUsername ? (
                <p className="shelf-book-shared-by">
                  Compartido por <strong>@{book.ownerUsername}</strong>
                </p>
              ) : null}
            </div>

            {book.rating ? (
              <div className="shelf-book-rating-badge" title={RATING_LABELS[book.rating] ?? `Calificación: ${book.rating}/5`}>
                <span className="shelf-book-rating-stars">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <span className={star <= (book.rating ?? 0) ? "star-active" : "star-inactive"} key={star}>★</span>
                  ))}
                </span>
                <span className="shelf-book-rating-text">{RATING_LABELS[book.rating]}</span>
              </div>
            ) : null}

            {book.userComments?.trim() ? (
              <div className="shelf-book-user-comments">
                <p className="shelf-book-user-comments-label">Comentarios:</p>
                <p className="shelf-book-user-comments-text">{book.userComments.trim()}</p>
              </div>
            ) : null}

            <dl className="shelf-book-stats">
              <div>
                <dt>Idioma</dt>
                <dd>{getBookLanguageLabel(book.languageCode)}</dd>
              </div>
              <div>
                <dt>Páginas</dt>
                <dd>{shelfNumberFormatter.format(book.totalPages)}</dd>
              </div>
              <div>
                <dt>Palabras</dt>
                <dd>{shelfNumberFormatter.format(book.totalWords)}</dd>
              </div>
              {book.lastOpenedAt ? (
                <div>
                  <dt>Última lectura</dt>
                  <dd>{new Date(book.lastOpenedAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}</dd>
                </div>
              ) : null}
            </dl>
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
                className={["book-card-icon-button book-card-download-button", exportingBookId === book.bookId ? "icon-spin" : ""].filter(Boolean).join(" ")}
                disabled={isBookRemoving || downloadingBookId === book.bookId || exportingBookId === book.bookId}
                onClick={(event) => handleDownloadAction(book, event)}
                title={book.sourceType === "IMAGES" ? "Descargar como EPUB o PDF" : "Descargar archivo original"}
                type="button"
              >
                <DownloadIcon />
              </button>
              {book.notionBookUrl?.trim() ? (
                <a
                  aria-label={`Abrir ${book.title} en Notion`}
                  className="book-card-icon-button book-card-notion-button"
                  href={book.notionBookUrl.trim()}
                  onClick={(event) => { event.stopPropagation(); }}
                  rel="noreferrer noopener"
                  target="_blank"
                  title="Abrir libro en Notion"
                >
                  <img alt="" aria-hidden="true" className="shelf-book-notion-icon" src={notionIconUrl} />
                </a>
              ) : null}
              {book.currentUserRole === "OWNER" ? (
                <button
                  aria-label={`Compartir ${book.title}`}
                  className="book-card-icon-button book-card-share-button"
                  disabled={isBookRemoving}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setShareBook(book);
                  }}
                  title="Compartir"
                  type="button"
                >
                  <ShareIcon />
                </button>
              ) : null}
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
                aria-label={isBookOwner ? `Eliminar ${book.title}` : `Salir del libro ${book.title}`}
                className="book-card-icon-button book-card-delete-button"
                disabled={isBookRemoving}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleDeleteBook(book);
                }}
                title={isBookOwner ? "Eliminar libro" : "Salir del libro compartido"}
                type="button"
              >
                <DeleteIcon />
              </button>

              {downloadMenuBookId === book.bookId ? (
                <div className="book-card-download-menu" role="menu">
                  <p className="book-card-download-menu-title">Descargar libro de imágenes</p>
                  <button
                    className="menu-item book-card-download-option"
                    disabled={exportingBookId === book.bookId}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleExportFromCard(book, "epub");
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {exportingBookId === book.bookId && exportingFormatCard === "epub" ? "Exportando EPUB..." : "EPUB"}
                  </button>
                  <button
                    className="menu-item book-card-download-option"
                    disabled={exportingBookId === book.bookId}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleExportFromCard(book, "pdf");
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {exportingBookId === book.bookId && exportingFormatCard === "pdf" ? "Exportando PDF..." : "PDF"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div aria-hidden={!isBookRemoving} className="book-card-removing-badge">
          <span className="book-card-removing-dot" />
          {removalState === "exiting" ? "Retirando de la estantería..." : "Eliminando..."}
        </div>
      </article>
    );
  }

  return (
    <div className="page-stack shelf-layout">
      {activeView === "shelf" ? (
      <section className="panel wide-panel overflow-visible-panel screen-scene" data-direction={viewTransitionDirection}>
        <div className="panel-header shelf-header">
          <div className="shelf-header-copy">
            <h2>Estantería</h2>
          </div>
          <div className="header-actions shelf-header-actions" ref={headerActionsRef}>
            <button
              aria-expanded={isCreateMenuOpen}
              aria-label="Abrir menú de creación"
              className="plus-button"
              onClick={() => {
                setIsCreateMenuOpen((current) => !current);
                setIsSearchMenuOpen(false);
              }}
              type="button"
            >
              +
            </button>

            <div className="shelf-header-menu-container">
              <button
                aria-expanded={isSearchMenuOpen}
                aria-label="Opciones de búsqueda"
                className={["shelf-header-icon-button", isShelfSearchOpen || Boolean(shelfSearchQuery) ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => {
                  setIsSearchMenuOpen((current) => !current);
                  setIsCreateMenuOpen(false);
                }}
                title="Buscar libros o palabras"
                type="button"
              >
                <SearchIcon />
              </button>

              {isSearchMenuOpen ? (
                <div className="menu-panel shelf-search-choice-menu" role="menu">
                  <button
                    className="menu-item shelf-search-choice-item"
                    onClick={openShelfSearch}
                    type="button"
                  >
                    <span className="shelf-search-choice-icon" aria-hidden="true">
                      <BookSearchChoiceIcon />
                    </span>
                    <span className="shelf-search-choice-text">
                      <strong>Buscar en estantería</strong>
                      <span>Por título y autor</span>
                    </span>
                  </button>
                  <button
                    className="menu-item shelf-search-choice-item"
                    onClick={openGlobalSearch}
                    type="button"
                  >
                    <span className="shelf-search-choice-icon" aria-hidden="true">
                      <TextSearchChoiceIcon />
                    </span>
                    <span className="shelf-search-choice-text">
                      <strong>Buscar palabras</strong>
                      <span>Dentro de todos los libros</span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>

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

        <div className="shelf-toolbar">
          {hasSharedBooks || sharedBooksQuery.isLoading || scope !== "mine" ? (
            <div className="shelf-scope-tabs" role="tablist">
              <button
                aria-selected={effectiveScope === "mine"}
                className={["shelf-scope-tab", effectiveScope === "mine" ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => selectScope("mine")}
                role="tab"
                type="button"
              >
                Mis libros
              </button>
              <button
                aria-selected={effectiveScope === "shared"}
                className={["shelf-scope-tab", effectiveScope === "shared" ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => selectScope("shared")}
                role="tab"
                type="button"
              >
                Compartidos conmigo
              </button>
              <button
                aria-selected={effectiveScope === "all"}
                className={["shelf-scope-tab", effectiveScope === "all" ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => selectScope("all")}
                role="tab"
                type="button"
              >
                Todos
              </button>
            </div>
          ) : <div />}

          <div className="shelf-sort-controls">
            <label className="shelf-sort-label" htmlFor="shelf-sort-select">Ordenar:</label>
            <select
              className="shelf-sort-select"
              id="shelf-sort-select"
              onChange={(e) => setSortMode(e.target.value as ShelfSortMode)}
              value={sortMode}
            >
              <option value="lastOpened">Última lectura</option>
              <option value="rating">Calificación</option>
            </select>
          </div>
        </div>

        {isShelfSearchOpen || Boolean(shelfSearchQuery) ? (
          <div className="shelf-search-bar-wrapper">
            <div className="shelf-search-bar">
              <span className="shelf-search-bar-icon" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                aria-label="Buscar libros por título o autor"
                className="shelf-search-input"
                onChange={(e) => handleShelfSearchChange(e.target.value)}
                placeholder="Buscar por título o autor..."
                ref={searchInputRef}
                type="text"
                value={shelfSearchQuery}
              />
              {shelfSearchQuery ? (
                <button
                  aria-label="Limpiar búsqueda"
                  className="shelf-search-clear-btn"
                  onClick={() => handleShelfSearchChange("")}
                  title="Limpiar búsqueda"
                  type="button"
                >
                  <ClearIcon />
                </button>
              ) : null}
              <button
                aria-label="Cerrar búsqueda en estantería"
                className="shelf-search-close-btn"
                onClick={closeShelfSearch}
                type="button"
              >
                Cerrar
              </button>
            </div>
            {shelfSearchQuery ? (
              <div className="shelf-search-stats">
                {totalFilteredBooks === 1
                  ? "1 libro encontrado"
                  : `${totalFilteredBooks} libros encontrados`}
              </div>
            ) : null}
          </div>
        ) : null}

        {booksQuery.isLoading ? <p>Cargando libros...</p> : null}
        {booksQuery.isError ? <p className="error-text">No se pudo cargar la estantería.</p> : null}
        {bookActionError ? <p className="error-text">{bookActionError}</p> : null}
        {bookActionSuccess ? <p className="success-text">{bookActionSuccess}</p> : null}

        {!booksQuery.isLoading && allBooks.length === 0 ? (
          <div className="shelf-empty-state">
            <p>No hay libros en tu estantería.</p>
          </div>
        ) : null}

        {!booksQuery.isLoading && allBooks.length > 0 && normalizedShelfQuery && totalFilteredBooks === 0 ? (
          <div className="shelf-empty-search-panel">
            <div className="shelf-empty-search-icon" aria-hidden="true">
              <SearchIcon />
            </div>
            <h3>Sin resultados</h3>
            <p>No se encontraron libros que coincidan con <strong>"{shelfSearchQuery}"</strong> en esta sección.</p>
            <button
              className="secondary-button"
              onClick={() => handleShelfSearchChange("")}
              type="button"
            >
              Limpiar búsqueda
            </button>
          </div>
        ) : null}

        <div className="shelf-sections-container">
          {sectionsWithBooks.map((section) => (
            <section className="shelf-section" key={section.id}>
              <div className="shelf-section-header">
                <h3 className="shelf-section-title">{section.label}</h3>
                <span className="shelf-section-count">{section.books.length}</span>
              </div>
              <div className="shelf-grid" data-compact-row={section.books.length > 0 && section.books.length < 3 ? "true" : undefined}>
                {section.books.map((book) => renderBookCard(book))}
              </div>
            </section>
          ))}
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
              onClick={handleCancelOrBack}
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
                disabled={!canEditBookMetadata}
                onChange={(event) => setBookForm((current) => ({ ...current, title: event.target.value }))}
                required
                value={bookForm.title}
              />
            </label>
            <label>
              Autor
              <input
                disabled={!canEditBookMetadata}
                onChange={(event) => setBookForm((current) => ({ ...current, authorName: event.target.value }))}
                placeholder="Autor o autora"
                value={bookForm.authorName}
              />
            </label>
            <label>
              Idioma
              <select
                disabled={!canEditBookMetadata}
                onChange={(event) => setBookForm((current) => ({ ...current, languageCode: event.target.value as BookLanguageCode }))}
                value={bookForm.languageCode}
              >
                {BOOK_LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="helper-text">Cambiarlo elimina el audio generado anteriormente; el OCR existente no se reprocesa.</span>
            </label>
            <label>
              URL en Notion personal
              <input
                onChange={(event) => setBookForm((current) => ({ ...current, notionBookUrl: event.target.value }))}
                placeholder="https://www.notion.so/..."
                type="url"
                value={bookForm.notionBookUrl}
              />
            </label>

            <div className="shelf-edit-form-grid">
              <label>
                Estado de lectura
                <select
                  onChange={(event) =>
                    setBookForm((current) => ({
                      ...current,
                      readingStatus: event.target.value as ReadingStatus
                    }))
                  }
                  value={bookForm.readingStatus}
                >
                  {READING_STATUS_CONFIG.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="shelf-rating-form-group">
                <span className="shelf-rating-form-label">Calificación</span>
                <StarRatingInput
                  onChange={(nextRating) =>
                    setBookForm((current) => ({
                      ...current,
                      rating: nextRating
                    }))
                  }
                  value={bookForm.rating}
                />
              </div>
            </div>

            <label>
              Comentarios sobre el libro
              <textarea
                onChange={(event) => setBookForm((current) => ({ ...current, userComments: event.target.value }))}
                placeholder="¿Qué te ha parecido el libro? Escribe aquí tus notas o impresiones..."
                rows={5}
                value={bookForm.userComments}
              />
            </label>

            {bookActionError ? <p className="error-text">{bookActionError}</p> : null}

            <div className="import-panel-actions">
              <button className="primary-button" disabled={isSavingBook} type="submit">
                {isSavingBook ? "Guardando..." : "Guardar cambios"}
              </button>
              <button className={["secondary-button", exportingFormat === "epub" ? "icon-spin" : ""].filter(Boolean).join(" ")} disabled={exportingFormat === "epub"} onClick={() => void handleDownloadExport("epub")} type="button">
                <span className="export-button-content">
                  <DownloadIcon />
                  {exportingFormat === "epub" ? "Exportando EPUB..." : "Exportar EPUB"}
                </span>
              </button>
              <button className={["secondary-button", exportingFormat === "pdf" ? "icon-spin" : ""].filter(Boolean).join(" ")} disabled={exportingFormat === "pdf"} onClick={() => void handleDownloadExport("pdf")} type="button">
                <span className="export-button-content">
                  <DownloadIcon />
                  {exportingFormat === "pdf" ? "Exportando PDF..." : "Exportar PDF"}
                </span>
              </button>
              <button className="secondary-button" onClick={handleCancelOrBack} type="button">
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
              Idioma
              <select
                onChange={(event) => {
                  setImportForm((current) => ({ ...current, languageCode: event.target.value as BookLanguageCode }));
                  setLanguageSuggestion(null);
                }}
                value={importForm.languageCode}
              >
                {BOOK_LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Archivo
              <input
                accept=".pdf,.epub,application/pdf,application/epub+zip"
                onChange={(event) => void handleImportFileChange(event.target.files?.[0] ?? null)}
                type="file"
              />
              <span className="helper-text">
                {inspectingLanguage
                  ? "Analizando el idioma..."
                  : languageSuggestion === "metadata"
                    ? "Idioma sugerido desde los metadatos del EPUB. Puedes cambiarlo."
                    : languageSuggestion === "detected"
                      ? "Idioma sugerido a partir del texto. Puedes cambiarlo."
                      : "Formatos admitidos: PDF y EPUB."}
              </span>
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

      {shareBook && accessToken ? (
        <ShareBookModal
          accessToken={accessToken}
          book={shareBook}
          currentUserRole={shareBook.currentUserRole ?? "OWNER"}
          onClose={() => setShareBook(null)}
        />
      ) : null}
    </div>
  );
}
