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

type ApiErrorPayload = {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  retryable?: boolean;
};

export type ApiRequestError = Error & {
  code?: string;
  retryAfterSeconds?: number;
  retryable?: boolean;
  statusCode: number;
};

export type BlobDownload = {
  blob: Blob;
  fileName: string | null;
};

function createHeaders(options: { accessToken?: string | null | undefined; contentType?: string | undefined }): RequestHeaders {
  return {
    ...(options.contentType ? { "Content-Type": options.contentType } : {}),
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
  };
}

async function parseErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  return payload?.message ?? fallbackMessage;
}

async function createApiRequestError(response: Response, fallbackMessage: string): Promise<ApiRequestError> {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  const error = new Error(payload?.message ?? fallbackMessage) as ApiRequestError;

  error.statusCode = response.status;

  if (typeof payload?.code === "string") {
    error.code = payload.code;
  }

  if (typeof payload?.retryAfterSeconds === "number") {
    error.retryAfterSeconds = payload.retryAfterSeconds;
  }

  if (payload?.retryable === true) {
    error.retryable = true;
  }

  return error;
}

export function isRetryableRateLimitError(error: unknown): error is ApiRequestError {
  return error instanceof Error
    && (error as Partial<ApiRequestError>).retryable === true
    && typeof (error as Partial<ApiRequestError>).retryAfterSeconds === "number"
    && ((error as Partial<ApiRequestError>).statusCode === 429 || (error as Partial<ApiRequestError>).code === "OCR_RATE_LIMIT");
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
    throw await createApiRequestError(response, "La solicitud no se pudo completar.");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, accessToken: string): Promise<Blob> {
  const result = await requestBlobDownload(path, accessToken);
  return result.blob;
}

function parseContentDispositionFileName(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/iu);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = contentDisposition.match(/filename=([^;]+)/iu);
  return plainMatch?.[1]?.trim() ?? null;
}

async function requestBlobDownload(path: string, accessToken: string): Promise<BlobDownload> {
  const response = await fetchWithAutoRefresh(path, {
    accessToken,
    fallbackMessage: "La solicitud no se pudo completar.",
    headers: createHeaders({ accessToken }),
    method: "GET"
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "La solicitud no se pudo completar.");
  }

  return {
    blob: await response.blob(),
    fileName: parseContentDispositionFileName(response.headers.get("Content-Disposition"))
  };
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
export type ImageRotation = 0 | 90 | 180 | 270;

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

export type ReaderAudioBlockParagraph = {
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  textLength: number;
};

export type DeepgramBalanceSummary = {
  success: true;
  balance_usd: number;
  project_id: string;
  project_name: string;
};

function decodeBase64Url(value: string): string {
  const normalizedValue = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const paddingLength = (4 - (normalizedValue.length % 4)) % 4;
  const paddedValue = normalizedValue.padEnd(normalizedValue.length + paddingLength, "=");

  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const binary = window.atob(paddedValue);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return Buffer.from(paddedValue, "base64").toString("utf8");
}

function parseAudioBlockParagraphs(response: Response): ReaderAudioBlockParagraph[] {
  const encodedParagraphs = response.headers.get("X-Reader-Tts-Paragraphs");
  if (!encodedParagraphs) {
    throw new Error("La respuesta del bloque de audio no incluye el mapa de párrafos.");
  }

  const payload = JSON.parse(decodeBase64Url(encodedParagraphs)) as ReaderAudioBlockParagraph[];
  if (!Array.isArray(payload)) {
    throw new Error("El mapa de párrafos del bloque de audio no es válido.");
  }

  return payload;
}

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
  chapterId?: string;
  isGenerated?: boolean;
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
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  toc: ReaderTocEntry[];
};

export type SectionSummarySection = {
  chapterId: string;
  endPageNumber: number;
  endParagraphNumber: number;
  endSequenceNumber: number;
  isGenerated: boolean;
  level: number;
  startPageNumber: number;
  startParagraphNumber: number;
  startSequenceNumber: number;
  title: string;
};

export type SectionSummaryRecord = {
  createdAt: string;
  isStale: boolean;
  summaryId: string;
  summaryText: string;
  updatedAt: string;
};

export type SectionSummaryResponse = {
  section: SectionSummarySection;
  summary: SectionSummaryRecord | null;
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
    pageLabel?: string | null;
    pageNumber: number;
    pageType?: string;
    paragraphs: ParagraphContent[];
    rawText: string | null;
    sourceImageRotation: ImageRotation;
    sourceFileId: string | null;
    updatedAt: string;
  };
};

export type BookOutlineEntry = {
  chapterId?: string;
  isGenerated?: boolean;
  level: number;
  pageNumber: number;
  paragraphNumber: number;
  sequenceNumber?: number | null;
  title: string;
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
  paragraphCount?: number;
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
    throw await createApiRequestError(response, "No se pudo importar el libro.");
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
    throw await createApiRequestError(response, "No se pudo crear el libro desde imágenes.");
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export async function appendImagesToBook(accessToken: string, bookId: string, payload: FormData, options?: { afterPage?: number; ocrMode?: ImageOcrMode; progressId?: string }) {
  const searchParams = new URLSearchParams();
  if (options?.afterPage !== undefined) {
    searchParams.set("afterPage", String(options.afterPage));
  }

  if ((options as { progressId?: string } | undefined)?.progressId) {
    searchParams.set("progressId", (options as { progressId?: string }).progressId ?? "");
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
    throw await createApiRequestError(response, "No se pudieron añadir imágenes al libro.");
  }

  return response.json() as Promise<{
    addedPages: number;
    addedParagraphs: number;
    book: BookSummary;
    insertionStartPageNumber: number;
  }>;
}

export type AppendImagesImportProgress = {
  bookId: string;
  completedFiles: number;
  currentFileIndex: number | null;
  currentFileName: string | null;
  errorMessage: string | null;
  stage: "ocr" | "waiting" | "saving" | "completed" | "failed";
  totalFiles: number;
  waitMessage: string | null;
  waitSecondsRemaining: number | null;
};

export function fetchAppendImagesImportProgress(accessToken: string, progressId: string) {
  return request<{ progress: AppendImagesImportProgress }>(`/books/import-images/progress/${progressId}`, {
    accessToken,
    method: "GET"
  });
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

export function fetchBookOutline(accessToken: string, bookId: string) {
  return request<{ outline: BookOutlineEntry[] }>(`/books/${bookId}/outline`, { accessToken });
}

export function fetchSectionSummary(accessToken: string, bookId: string, chapterId: string) {
  return request<SectionSummaryResponse>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary`, { accessToken });
}

export function generateSectionSummary(accessToken: string, bookId: string, chapterId: string) {
  return request<SectionSummaryResponse>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary`, {
    accessToken,
    body: {},
    method: "POST"
  });
}

export function updateBookOutline(accessToken: string, bookId: string, payload: { entries: Array<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">> }) {
  return request<void>(`/books/${bookId}/outline`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
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

export async function uploadBookPageImage(accessToken: string, bookId: string, pageNumber: number, payload: FormData) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/pages/${pageNumber}/image`, {
    accessToken,
    body: payload,
    fallbackMessage: "No se pudo guardar la imagen editada de la página.",
    headers: createHeaders({ accessToken }),
    method: "PUT"
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo guardar la imagen editada de la página.");
  }
}

export function downloadBookExport(accessToken: string, bookId: string, format: "epub" | "pdf") {
  return requestBlobDownload(`/books/${bookId}/export/${format}`, accessToken);
}

export function downloadOriginalBook(accessToken: string, bookId: string) {
  return requestBlobDownload(`/books/${bookId}/download-original`, accessToken);
}

export function updateOcrPage(accessToken: string, bookId: string, pageNumber: number, payload: { editedText: string; sourceImageRotation?: ImageRotation }) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/ocr`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function updateBookPageImageRotation(accessToken: string, bookId: string, pageNumber: number, payload: { rotation: ImageRotation }) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/image-rotation`, {
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
    throw await createApiRequestError(response, "No se pudo generar el audio del párrafo.");
  }

  return response.blob();
}

export async function requestParagraphAudioBlock(accessToken: string, bookId: string, startSequenceNumber: number, options: ReaderAudioOptions = {}) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/tts/block`, {
    accessToken,
    body: JSON.stringify({
      paragraphCount: options.paragraphCount,
      startSequenceNumber,
      voiceModel: options.voiceModel
    }),
    fallbackMessage: "No se pudo generar el bloque de audio.",
    headers: createHeaders({ accessToken, contentType: "application/json" }),
    method: "POST",
    signal: options.signal
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo generar el bloque de audio.");
  }

  return {
    blob: await response.blob(),
    paragraphs: parseAudioBlockParagraphs(response)
  };
}

export async function requestSectionSummaryAudio(accessToken: string, bookId: string, chapterId: string, options: ReaderAudioOptions = {}) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary/tts`, {
    accessToken,
    body: JSON.stringify({ voiceModel: options.voiceModel }),
    fallbackMessage: "No se pudo generar el audio del resumen.",
    headers: createHeaders({ accessToken, contentType: "application/json" }),
    method: "POST",
    signal: options.signal
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo generar el audio del resumen.");
  }

  return response.blob();
}

export function fetchDeepgramBalance(accessToken: string) {
  return request<DeepgramBalanceSummary>("/tts/deepgram/balance", { accessToken });
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