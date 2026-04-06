import { useAuthStore, type SessionUser } from "./auth-store";

const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

let refreshSessionPromise: Promise<AuthResponse> | null = null;

type ApiOptions = {
  accessToken?: string | null;
  body?: unknown;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  signal?: AbortSignal;
};

type RequestHeaders = Record<string, string>;

function createHeaders(options: { accessToken?: string | null | undefined; contentType?: string | undefined }): RequestHeaders {
  return {
    ...(options.contentType ? { "Content-Type": options.contentType } : {}),
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
  };
}

async function parseErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? fallbackMessage;
}

async function refreshAccessToken(): Promise<string> {
  if (!refreshSessionPromise) {
    const { clearSession, refreshToken } = useAuthStore.getState();

    if (!refreshToken) {
      clearSession();
      throw new Error("La sesión ha caducado. Vuelve a iniciar sesión.");
    }

    refreshSessionPromise = fetch(`${apiBaseUrl}/auth/refresh`, {
      body: JSON.stringify({ refreshToken }),
      headers: createHeaders({ contentType: "application/json" }),
      method: "POST"
    })
      .then(async (response) => {
        if (!response.ok) {
          const message = await parseErrorMessage(response, "No se pudo renovar la sesión.");
          if (response.status === 400 || response.status === 401) {
            clearSession();
          }

          throw new Error(message);
        }

        return response.json() as Promise<AuthResponse>;
      })
      .then((session) => {
        useAuthStore.getState().setSession(session);
        return session;
      })
      .finally(() => {
        refreshSessionPromise = null;
      });
  }

  const session = await refreshSessionPromise;
  return session.accessToken;
}

async function fetchWithAutoRefresh(
  path: string,
  options: {
    accessToken?: string | null | undefined;
    body?: BodyInit | undefined;
    fallbackMessage: string;
    headers?: RequestHeaders | undefined;
    method?: string | undefined;
    signal?: AbortSignal | undefined;
  }
): Promise<Response> {
  const executeFetch = (token: string | null | undefined) => {
    const nextHeaders = {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };

    const requestInit: RequestInit = {
      headers: nextHeaders,
      method: options.method ?? "GET"
    };

    if (options.signal !== undefined) {
      requestInit.signal = options.signal;
    }

    if (options.body !== undefined) {
      requestInit.body = options.body;
    }

    return fetch(`${apiBaseUrl}${path}`, requestInit);
  };

  let response = await executeFetch(options.accessToken);
  if (response.status !== 401 || !options.accessToken) {
    return response;
  }

  const nextAccessToken = await refreshAccessToken();
  response = await executeFetch(nextAccessToken);
  return response;
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetchWithAutoRefresh(path, {
    accessToken: options.accessToken,
    body: options.body ? JSON.stringify(options.body) : undefined,
    fallbackMessage: "La solicitud no se pudo completar.",
    headers: createHeaders({
      accessToken: options.accessToken,
      contentType: options.body ? "application/json" : undefined
    }),
    method: options.method ?? "GET"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "La solicitud no se pudo completar."));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, accessToken: string): Promise<Blob> {
  const response = await fetchWithAutoRefresh(path, {
    accessToken,
    fallbackMessage: "La solicitud no se pudo completar.",
    headers: createHeaders({ accessToken }),
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "La solicitud no se pudo completar."));
  }

  return response.blob();
}

export type AuthResponse = {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
};

export type BookSummary = {
  authorName: string | null;
  bookId: string;
  createdAt?: string;
  synopsis?: string | null;
  sourceType: "PDF" | "EPUB" | "IMAGES";
  status: string;
  title: string;
  totalPages: number;
  totalParagraphs: number;
  updatedAt?: string;
};

export type ImageOcrMode = "LOCAL" | "VISION";

export type ParagraphContent = {
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

export type HighlightColor = "YELLOW" | "GREEN" | "BLUE" | "PINK";

export type ReaderBookmark = {
  bookmarkId: string;
  createdAt: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
};

export type ReaderHighlight = {
  charEnd: number;
  charStart: number;
  color: HighlightColor;
  createdAt: string;
  highlightId: string;
  highlightedText: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  updatedAt: string;
};

export type ReaderNote = {
  createdAt: string;
  highlightCharEnd: number | null;
  highlightCharStart: number | null;
  highlightColor: HighlightColor | null;
  highlightId: string | null;
  highlightedText: string | null;
  noteId: string;
  noteText: string;
  pageNumber: number;
  paragraphId: string | null;
  paragraphNumber: number | null;
  sequenceNumber: number | null;
  updatedAt: string;
};

export type ReaderTocEntry = {
  level: number;
  pageNumber: number;
  paragraphNumber: number;
  sequenceNumber: number | null;
  title: string;
};

export type ReaderPageAnnotations = {
  bookmarks: ReaderBookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
};

export type ReaderNavigationSummary = {
  bookmarks: ReaderBookmark[];
  notes: ReaderNote[];
  toc: ReaderTocEntry[];
};

export type BookPageResponse = {
  book: BookSummary & { synopsis?: string | null };
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  page: {
    editedText: string | null;
    hasSourceImage: boolean;
    htmlContent: string | null;
    ocrStatus: string;
    pageNumber: number;
    paragraphs: ParagraphContent[];
    rawText: string | null;
    sourceFileId: string | null;
  };
};

export type ReadingProgress = {
  audioOffsetMs: number;
  currentPageNumber: number;
  currentParagraphNumber: number;
  currentSequenceNumber: number;
  lastOpenedAt: string;
  progressId: string;
  readingPercentage: number;
  updatedAt: string;
};

export type ReaderAudioOptions = {
  signal?: AbortSignal;
  voiceModel?: string;
};

export type ManagedUser = {
  createdAt: string;
  displayName: string | null;
  email: string;
  role: SessionUser["role"];
  totalBooks: number;
  updatedAt: string;
  userId: string;
  username: string;
};

export function registerUser(payload: { displayName?: string; email: string; password: string; username: string }) {
  return request<AuthResponse>("/auth/register", { body: payload, method: "POST" });
}

export function loginUser(payload: { password: string; usernameOrEmail: string }) {
  return request<AuthResponse>("/auth/login", { body: payload, method: "POST" });
}

export function forgotPassword(payload: { email: string }) {
  return request<{ message: string }>("/auth/forgot-password", { body: payload, method: "POST" });
}

export function resetPassword(payload: { password: string; token: string }) {
  return request<void>("/auth/reset-password", { body: payload, method: "POST" });
}

export function fetchCurrentUser(accessToken: string) {
  return request<{ user: SessionUser }>("/auth/me", { accessToken });
}

export function fetchBooks(accessToken: string) {
  return request<{ books: BookSummary[] }>("/books", { accessToken });
}

export function createBook(accessToken: string, payload: { authorName?: string; sourceType: "PDF" | "EPUB" | "IMAGES"; synopsis?: string; title: string }) {
  return request<{ book: BookSummary }>("/books", { accessToken, body: payload, method: "POST" });
}

export async function importBook(accessToken: string, payload: FormData) {
  const response = await fetchWithAutoRefresh("/books/import", {
    accessToken,
    body: payload,
    fallbackMessage: "No se pudo importar el libro.",
    headers: createHeaders({ accessToken }),
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo importar el libro."));
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export function updateBook(accessToken: string, bookId: string, payload: { authorName?: string; synopsis?: string; title: string }) {
  return request<{ book: BookSummary }>(`/books/${bookId}`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function deleteBook(accessToken: string, bookId: string) {
  return request<void>(`/books/${bookId}`, {
    accessToken,
    method: "DELETE"
  });
}

function createImageUploadPayload(payload: FormData, ocrMode?: ImageOcrMode): FormData {
  const nextPayload = new FormData();

  payload.forEach((value, key) => {
    nextPayload.append(key, value);
  });

  if (ocrMode) {
    nextPayload.set("ocrMode", ocrMode);
  }

  return nextPayload;
}

export async function createImageBook(accessToken: string, payload: FormData, options?: { ocrMode?: ImageOcrMode }) {
  const response = await fetchWithAutoRefresh("/books/from-images", {
    accessToken,
    body: createImageUploadPayload(payload, options?.ocrMode),
    fallbackMessage: "No se pudo crear el libro desde imágenes.",
    headers: createHeaders({ accessToken }),
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo crear el libro desde imágenes."));
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export async function appendImagesToBook(accessToken: string, bookId: string, payload: FormData, options?: { afterPage?: number; ocrMode?: ImageOcrMode }) {
  const searchParams = new URLSearchParams();
  if (options?.afterPage !== undefined) {
    searchParams.set("afterPage", String(options.afterPage));
  }

  const path = searchParams.size > 0
    ? `/books/${bookId}/import-images?${searchParams.toString()}`
    : `/books/${bookId}/import-images`;

  const response = await fetchWithAutoRefresh(path, {
    accessToken,
    body: createImageUploadPayload(payload, options?.ocrMode),
    fallbackMessage: "No se pudieron añadir imágenes al libro.",
    headers: createHeaders({ accessToken }),
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudieron añadir imágenes al libro."));
  }

  return response.json() as Promise<{
    addedPages: number;
    addedParagraphs: number;
    book: BookSummary;
    insertionStartPageNumber: number;
  }>;
}

export function deleteBookPage(accessToken: string, bookId: string, pageNumber: number) {
  return request<{
    book: BookSummary;
    deletedPageNumber: number;
    nextPageNumber: number | null;
  }>(`/books/${bookId}/pages/${pageNumber}`, {
    accessToken,
    method: "DELETE"
  });
}

export function fetchBook(accessToken: string, bookId: string) {
  return request<{ book: BookSummary & { synopsis?: string | null } }>(`/books/${bookId}`, { accessToken });
}

export function fetchBookPage(accessToken: string, bookId: string, pageNumber: number) {
  return request<BookPageResponse>(`/books/${bookId}/pages/${pageNumber}`, { accessToken });
}

export function fetchPageAnnotations(accessToken: string, bookId: string, pageNumber: number) {
  return request<ReaderPageAnnotations>(`/books/${bookId}/annotations?pageNumber=${encodeURIComponent(String(pageNumber))}`, { accessToken });
}

export function fetchReaderNavigation(accessToken: string, bookId: string) {
  return request<ReaderNavigationSummary>(`/books/${bookId}/navigation`, { accessToken });
}

export function createBookmark(accessToken: string, bookId: string, payload: { paragraphId: string }) {
  return request<{ bookmark: ReaderBookmark }>(`/books/${bookId}/bookmarks`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function deleteBookmark(accessToken: string, bookId: string, bookmarkId: string) {
  return request<void>(`/books/${bookId}/bookmarks/${bookmarkId}`, {
    accessToken,
    method: "DELETE"
  });
}

export function createHighlight(
  accessToken: string,
  bookId: string,
  payload: { charEnd: number; charStart: number; color: HighlightColor; highlightedText: string; paragraphId: string }
) {
  return request<{ highlight: ReaderHighlight }>(`/books/${bookId}/highlights`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function deleteHighlight(accessToken: string, bookId: string, highlightId: string) {
  return request<void>(`/books/${bookId}/highlights/${highlightId}`, {
    accessToken,
    method: "DELETE"
  });
}

export function createNote(
  accessToken: string,
  bookId: string,
  payload: { highlightId?: string; noteText: string; pageNumber?: number; paragraphId?: string }
) {
  return request<{ note: ReaderNote }>(`/books/${bookId}/notes`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function updateNote(accessToken: string, bookId: string, noteId: string, payload: { noteText: string }) {
  return request<void>(`/books/${bookId}/notes/${noteId}`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function deleteNote(accessToken: string, bookId: string, noteId: string) {
  return request<void>(`/books/${bookId}/notes/${noteId}`, {
    accessToken,
    method: "DELETE"
  });
}

export function fetchBookPageImage(accessToken: string, bookId: string, pageNumber: number, cacheKey?: string | null) {
  const query = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : "";
  return requestBlob(`/books/${bookId}/pages/${pageNumber}/image${query}`, accessToken);
}

export function updateOcrPage(accessToken: string, bookId: string, pageNumber: number, payload: { editedText: string }) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/ocr`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function rerunOcrPage(accessToken: string, bookId: string, pageNumber: number, payload?: { ocrMode?: ImageOcrMode }) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/rerun-ocr`, {
    accessToken,
    body: { ocrMode: payload?.ocrMode ?? "VISION" },
    method: "POST"
  });
}

export function fetchProgress(accessToken: string, bookId: string) {
  return request<{ progress: ReadingProgress | null }>(`/books/${bookId}/progress`, { accessToken });
}

export function updateProgress(accessToken: string, bookId: string, payload: Omit<ReadingProgress, "lastOpenedAt" | "progressId" | "updatedAt">) {
  return request<void>(`/books/${bookId}/progress`, { accessToken, body: payload, method: "PUT" });
}

export async function requestParagraphAudio(accessToken: string, bookId: string, paragraphId: string, options: ReaderAudioOptions = {}) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/tts`, {
    accessToken,
    body: JSON.stringify({ paragraphId, voiceModel: options.voiceModel }),
    fallbackMessage: "No se pudo generar el audio del párrafo.",
    headers: createHeaders({ accessToken, contentType: "application/json" }),
    method: "POST",
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "No se pudo generar el audio del párrafo."));
  }

  return response.blob();
}

export function fetchUsers(accessToken: string) {
  return request<{ users: ManagedUser[] }>("/users", { accessToken });
}

export function createManagedUser(
  accessToken: string,
  payload: { displayName?: string; email: string; password: string; role: SessionUser["role"]; username: string }
) {
  return request<{ user: SessionUser }>("/users", {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function updateManagedUser(
  accessToken: string,
  userId: string,
  payload: { displayName?: string; email: string; password?: string; role: SessionUser["role"] }
) {
  return request<void>(`/users/${userId}`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function deleteManagedUser(accessToken: string, userId: string) {
  return request<void>(`/users/${userId}`, {
    accessToken,
    method: "DELETE"
  });
}