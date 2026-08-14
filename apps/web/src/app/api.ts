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

type BookDownloadTokenResponse = {
  expiresInSeconds: number;
  token: string;
};

export type AppVersionCommit = {
  authorName: string;
  authoredAt: string;
  hash: string;
  shortHash: string;
  subject: string;
};

export type AppVersionResponse = {
  commits: AppVersionCommit[];
  currentCommit: string;
  currentShortCommit: string;
  currentVersion: string;
  hasUpdate: boolean;
  rangeFound: boolean;
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
    && ((error as Partial<ApiRequestError>).statusCode === 429 || (error as Partial<ApiRequestError>).code === "OCR_RATE_LIMIT" || (error as Partial<ApiRequestError>).code === "OCR_PROVIDER_UNAVAILABLE" || (error as Partial<ApiRequestError>).code === "OCR_INVALID_RESPONSE" || (error as Partial<ApiRequestError>).code === "AI_RATE_LIMIT");
}

export function fetchAppVersion(fromCommit: string) {
  const query = new URLSearchParams({ fromCommit });
  return request<AppVersionResponse>(`/app-version?${query.toString()}`);
}

export type AiFeature = "ocr-vision" | "section-summary" | "ai-requests" | "outline-regenerate";

export type AiModelId = "nemotron-3-ultra-free" | "deepseek-v4-flash-free" | "mimo-v2.5-free";
export type SummaryAiModelId = Exclude<AiModelId, "mimo-v2.5-free">;

export type AiModelOption = {
  contextWindowTokens: number;
  description: string;
  id: AiModelId;
  name: string;
  privacyNotice: string;
  supportsVision: boolean;
};

export type AiConfigResponse = {
  configured: boolean;
  defaultModel: SummaryAiModelId;
  features: AiFeature[];
  models: AiModelOption[];
  ocrModel: AiModelId;
  provider: "opencode";
  summaryModelIds: SummaryAiModelId[];
};

export function fetchAiConfig() {
  return request<AiConfigResponse>("/ai-config");
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

export type BookRole = "OWNER" | "EDITOR" | "COMMENTER" | "VIEWER";

export type ShareRole = "viewer" | "commenter" | "editor";

export type BookSummary = {
  authorName: string | null;
  bookId: string;
  createdAt?: string;
  currentUserRole?: BookRole;
  lastOpenedAt?: string | null;
  notionBookUrl?: string | null;
  ownerDisplayName?: string | null;
  ownerUserId?: string;
  ownerUsername?: string;
  shareUserAnnotations?: boolean;
  synopsis?: string | null;
  sourceType: "PDF" | "EPUB" | "IMAGES";
  status: string;
  title: string;
  totalPages: number;
  totalParagraphs: number;
  updatedAt?: string;
};

export type BookShare = {
  createdAt: string;
  displayName: string | null;
  email: string;
  invitedByUsername: string | null;
  role: ShareRole;
  userId: string;
  username: string;
};

export type BookScope = "mine" | "shared" | "all";

export function isBookEditor(role: BookRole | undefined): boolean {
  return role === "OWNER" || role === "EDITOR";
}

export function isBookCommenterOrAbove(role: BookRole | undefined): boolean {
  return role === "OWNER" || role === "EDITOR" || role === "COMMENTER";
}

export type ImageOcrMode = "LOCAL" | "VISION" | "TEXTRACT";
export type ImageRotation = 0 | 90 | 180 | 270;

type ImageOcrRequestOptions = {
  ocrMode?: ImageOcrMode | undefined;
  promptOverride?: string | undefined;
  skipOcr?: boolean | undefined;
};

export type ParagraphContent = {
  characterCount: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
  wordCount: number;
};

export type BookSearchResult = {
  authorName: string | null;
  bookId: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sectionTitle: string | null;
  sequenceNumber: number;
  title: string;
};

export type BookSearchResponse = {
  book: {
    authorName: string | null;
    bookId: string;
    title: string;
  };
  caseSensitive: boolean;
  hasMore: boolean;
  limit: number;
  offset: number;
  query: string;
  results: BookSearchResult[];
};

export type GlobalBookSearchResponse = {
  caseSensitive: boolean;
  hasMore: boolean;
  limit: number;
  offset: number;
  query: string;
  results: BookSearchResult[];
};

export type HighlightColor = "YELLOW" | "GREEN" | "BLUE" | "PINK";

export type ReaderBookmark = {
  bookmarkId: string;
  createdAt: string;
  isOwnedByCurrentUser?: boolean;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  sharedWithUserIds?: string[];
  userDisplayName?: string | null;
  userId?: string;
  username?: string;
  visibilitySource?: "OWN" | "DIRECT" | "BOOK";
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
  audioByteLength?: number;
  durationMs?: number;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  textLength: number;
};

export type ChapterAudioOfflinePlanBlock = {
  cachedCharacters: number;
  missingCharacters: number;
  paragraphCount: number;
  startSequenceNumber: number;
  totalCharacters: number;
};

export type ChapterAudioOfflinePlan = {
  blocks: ChapterAudioOfflinePlanBlock[];
  cachedCharacters: number;
  chapterId: string;
  endSequenceNumber: number;
  estimatedCostUsd: number;
  missingCharacters: number;
  startSequenceNumber: number;
  title: string;
  totalCharacters: number;
  voiceModel: string;
};

export type DeepgramBalanceSummary = {
  success: true;
  balance_usd: number;
  project_id: string;
  project_name: string;
};

export const deepgramTtsModels = [
  "aura-2-nestor-es",
  "aura-2-carina-es",
  "aura-2-alvaro-es",
  "aura-2-diana-es",
  "aura-2-agustina-es",
  "aura-2-silvia-es"
] as const;

export type DeepgramTtsModel = (typeof deepgramTtsModels)[number];

export type UpdateProfilePayload = {
  awsAccessKeyId?: string;
  awsRegion?: string;
  awsSecretAccessKey?: string;
  clearAwsCredentials?: boolean;
  clearDeepgramApiKey?: boolean;
  deepgramApiKey?: string;
  deepgramTtsModel?: DeepgramTtsModel;
  displayName?: string;
  email: string;
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
  isOwnedByCurrentUser?: boolean;
  noteId: string;
  noteText: string;
  pageNumber: number;
  paragraphId: string | null;
  paragraphNumber: number | null;
  sequenceNumber: number | null;
  sharedWithUserIds?: string[];
  updatedAt: string;
  userDisplayName?: string | null;
  userId?: string;
  username?: string;
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

export type BookOutlineSource = "EPUB_TOC" | "GENERATED_HEADINGS" | "MANUAL" | "NONE";

export type ReaderPageAnnotations = {
  bookmarks: ReaderBookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
};

export type ReaderNavigationSummary = {
  bookmarks: ReaderBookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  readingMetrics: {
    book: {
      characterCount: number;
      wordCount: number;
    };
    sections: Array<{
      chapterId: string;
      characterCount: number;
      charactersBeforeSection: number;
      endPageNumber: number;
      endSequenceNumber: number;
      nextStartPageNumber: number | null;
      startPageNumber: number;
      startSequenceNumber: number;
      wordCount: number;
      wordsBeforeSection: number;
    }>;
  };
  toc: ReaderTocEntry[];
  tocSource: BookOutlineSource;
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
  modelId: AiModelId | null;
  summaryId: string;
  summaryText: string;
  updatedAt: string;
};

export type SectionSummaryResponse = {
  section: SectionSummarySection;
  summary: SectionSummaryRecord | null;
};

export type SectionSummaryPromptResponse = {
  prompt: string;
  section: SectionSummarySection;
};

export type AiRequestScopeType = "BOOK" | "SECTION";
export type AiRequestKind = "TEXT" | "DIAGRAM";
export type AiVisualType = "AUTO" | "MIND_MAP" | "CONCEPT_MAP" | "TIMELINE" | "INFOGRAPHIC" | "FLOWCHART" | "RELATIONSHIPS";

export type AiRequestRecord = {
  author: {
    displayName: string | null;
    userId: string;
    username: string;
  };
  bookId: string;
  chapterId: string | null;
  createdAt: string;
  endPageNumber: number | null;
  endParagraphNumber: number | null;
  endSequenceNumber: number | null;
  modelId: AiModelId | null;
  isOwnedByCurrentUser: boolean;
  kind: AiRequestKind;
  promptText: string;
  requestId: string;
  responseText: string;
  sharedWithUserIds?: string[];
  scopeType: AiRequestScopeType;
  sectionTitle: string | null;
  startPageNumber: number | null;
  startParagraphNumber: number | null;
  startSequenceNumber: number | null;
  updatedAt: string;
  visibilitySource: "OWN" | "DIRECT";
};

export type AiRequestsResponse = {
  book: BookSummary;
  prompt: string;
  requests: AiRequestRecord[];
  section?: SectionSummarySection;
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
    readingOffset: {
      charactersBeforePage: number;
      wordsBeforePage: number;
    };
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

export type AwsCostLineItem = {
  amount: number;
  service: string;
};

export type AwsCostMonthToDate = {
  currency: string;
  fetchedAt: string;
  services: AwsCostLineItem[];
  total: number;
};

export function fetchAwsCostMonthToDate(accessToken: string) {
  return request<AwsCostMonthToDate>("/aws-cost/month-to-date", { accessToken });
}

export function updateCurrentUserProfile(accessToken: string, payload: UpdateProfilePayload) {
  return request<{ user: SessionUser }>("/auth/me/profile", {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function fetchBooks(accessToken: string, options?: { scope?: BookScope }) {
  const params = options?.scope ? `?scope=${encodeURIComponent(options.scope)}` : "";
  return request<{ books: BookSummary[] }>(`/books${params}`, { accessToken });
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

export function updateBook(accessToken: string, bookId: string, payload: { authorName?: string; notionBookUrl?: string | null; synopsis?: string; title: string }) {
  return request<{ book: BookSummary }>(`/books/${bookId}`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function deleteBook(accessToken: string, bookId: string, options?: { force?: boolean }) {
  const params = options?.force ? "?force=true" : "";
  return request<void>(`/books/${bookId}${params}`, {
    accessToken,
    method: "DELETE"
  });
}

function createImageUploadPayload(payload: FormData, options?: ImageOcrRequestOptions): FormData {
  const nextPayload = new FormData();

  payload.forEach((value, key) => {
    nextPayload.append(key, value);
  });

  if (options?.ocrMode) {
    nextPayload.set("ocrMode", options.ocrMode);
  }

  const normalizedPromptOverride = options?.promptOverride?.trim();
  if (normalizedPromptOverride) {
    nextPayload.set("promptOverride", normalizedPromptOverride);
  }

  if (options?.skipOcr) {
    nextPayload.set("skipOcr", "true");
  }

  return nextPayload;
}

export async function createImageBook(accessToken: string, payload: FormData, options?: ImageOcrRequestOptions) {
  const response = await fetchWithAutoRefresh("/books/from-images", {
    accessToken,
    body: createImageUploadPayload(payload, options),
    fallbackMessage: "No se pudo crear el libro desde imágenes.",
    headers: createHeaders({ accessToken }),
    method: "POST"
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo crear el libro desde imágenes.");
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export async function appendImagesToBook(accessToken: string, bookId: string, payload: FormData, options?: {
  afterPage?: number | undefined;
  ocrMode?: ImageOcrMode | undefined;
  progressId?: string | undefined;
  promptOverride?: string | undefined;
  skipOcr?: boolean | undefined;
}) {
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
    body: createImageUploadPayload(payload, {
      ocrMode: options?.ocrMode,
      promptOverride: options?.promptOverride,
      skipOcr: options?.skipOcr
    }),
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
    cancelled?: boolean;
    insertionStartPageNumber: number;
    nextAfterPage?: number | null;
  }>;
}

export type OcrWaitReason = "invalid-response" | "rate-limit" | "unavailable";

export type AppendImagesImportProgress = {
  bookId: string;
  completedFiles: number;
  currentFileIndex: number | null;
  currentFileName: string | null;
  errorMessage: string | null;
  insertedPages: number;
  insertionStartPageNumber: number | null;
  nextAfterPage: number | null;
  stage: "ocr" | "waiting" | "saving" | "cancelling" | "cancelled" | "completed" | "failed";
  totalFiles: number;
  waitMessage: string | null;
  waitReason: OcrWaitReason | null;
  waitSecondsRemaining: number | null;
};

export function fetchAppendImagesImportProgress(accessToken: string, progressId: string) {
  return request<{ progress: AppendImagesImportProgress }>(`/books/import-images/progress/${progressId}`, {
    accessToken,
    method: "GET"
  });
}

export function cancelAppendImagesImport(accessToken: string, progressId: string) {
  return request<{ progress: AppendImagesImportProgress }>(`/books/import-images/progress/${progressId}/cancel`, {
    accessToken,
    method: "POST"
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

export function fetchBookShares(accessToken: string, bookId: string) {
  return request<{ shares: BookShare[] }>(`/books/${bookId}/shares`, { accessToken });
}

export type SharableUser = {
  displayName: string | null;
  email: string;
  role: ShareRole | null;
  userId: string;
  username: string;
};

export function fetchSharabableUsers(accessToken: string, bookId: string) {
  return request<{ users: SharableUser[] }>(`/books/${bookId}/sharable-users`, { accessToken });
}

export type AnnotationShareUser = Pick<SharableUser, "displayName" | "userId" | "username">;

export function fetchAnnotationShareUsers(accessToken: string, bookId: string) {
  return request<{ users: AnnotationShareUser[] }>(`/books/${bookId}/annotation-share-users`, { accessToken });
}

export function addBookShare(accessToken: string, bookId: string, payload: { role: ShareRole; userId: string }) {
  return request<{ role: ShareRole; userId: string; username: string }>(`/books/${bookId}/shares`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function updateBookShare(accessToken: string, bookId: string, userId: string, payload: { role: ShareRole }) {
  return request<{ ok: true; role: ShareRole }>(`/books/${bookId}/shares/${userId}`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function removeBookShare(accessToken: string, bookId: string, userId: string) {
  return request<{ ok: true }>(`/books/${bookId}/shares/${userId}`, {
    accessToken,
    method: "DELETE"
  });
}

export function leaveBookShare(accessToken: string, bookId: string) {
  return request<{ ok: true }>(`/books/${bookId}/shares/leave`, {
    accessToken,
    method: "POST"
  });
}

export function transferBookOwnership(accessToken: string, bookId: string, username: string) {
  return request<{ ok: true; newOwnerUserId: string }>(`/books/${bookId}/transfer`, {
    accessToken,
    body: { username },
    method: "POST"
  });
}

export function setShareUserAnnotations(accessToken: string, bookId: string, enabled: boolean) {
  return request<{ shareUserAnnotations: boolean }>(`/books/${bookId}/share-user-annotations`, {
    accessToken,
    body: { enabled },
    method: "PUT"
  });
}

export function fetchBookPage(accessToken: string, bookId: string, pageNumber: number) {
  return request<BookPageResponse>(`/books/${bookId}/pages/${pageNumber}`, { accessToken });
}

export function fetchBookSearch(accessToken: string, bookId: string, query: string, options?: { caseSensitive?: boolean; limit?: number; offset?: number }) {
  const searchParams = new URLSearchParams({
    query
  });

  if (options?.caseSensitive) {
    searchParams.set("caseSensitive", "true");
  }

  if (typeof options?.limit === "number") {
    searchParams.set("limit", String(options.limit));
  }

  if (typeof options?.offset === "number") {
    searchParams.set("offset", String(options.offset));
  }

  return request<BookSearchResponse>(`/books/${bookId}/search?${searchParams.toString()}`, { accessToken });
}

export function fetchGlobalBookSearch(accessToken: string, query: string, options?: { caseSensitive?: boolean; limit?: number; offset?: number }) {
  const searchParams = new URLSearchParams({
    query
  });

  if (options?.caseSensitive) {
    searchParams.set("caseSensitive", "true");
  }

  if (typeof options?.limit === "number") {
    searchParams.set("limit", String(options.limit));
  }

  if (typeof options?.offset === "number") {
    searchParams.set("offset", String(options.offset));
  }

  return request<GlobalBookSearchResponse>(`/books/search?${searchParams.toString()}`, { accessToken });
}

export function fetchPageAnnotations(accessToken: string, bookId: string, pageNumber: number) {
  return request<ReaderPageAnnotations>(`/books/${bookId}/annotations?pageNumber=${encodeURIComponent(String(pageNumber))}`, { accessToken });
}

export function fetchReaderNavigation(accessToken: string, bookId: string) {
  return request<ReaderNavigationSummary>(`/books/${bookId}/navigation`, { accessToken });
}

export function fetchBookOutline(accessToken: string, bookId: string) {
  return request<{ outline: BookOutlineEntry[]; outlineSource: BookOutlineSource }>(`/books/${bookId}/outline`, { accessToken });
}

export function fetchSectionSummary(accessToken: string, bookId: string, chapterId: string) {
  return request<SectionSummaryResponse>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary`, { accessToken });
}

export function fetchSectionSummaryPrompt(accessToken: string, bookId: string, chapterId: string) {
  return request<SectionSummaryPromptResponse>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary/prompt`, { accessToken });
}

export function generateSectionSummary(accessToken: string, bookId: string, chapterId: string, payload: { model?: SummaryAiModelId; promptOverride?: string } = {}) {
  return request<SectionSummaryResponse>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/summary`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function fetchAiRequests(accessToken: string, bookId: string, chapterId?: string) {
  const path = chapterId
    ? `/books/${bookId}/sections/${encodeURIComponent(chapterId)}/ai-requests`
    : `/books/${bookId}/ai-requests`;
  return request<AiRequestsResponse>(path, { accessToken });
}

export function createAiRequest(accessToken: string, bookId: string, payload: { chapterId?: string; chapterIds?: string[]; kind: AiRequestKind; model?: SummaryAiModelId; promptText: string; visualType?: AiVisualType }) {
  const path = payload.chapterId
    ? `/books/${bookId}/sections/${encodeURIComponent(payload.chapterId)}/ai-requests`
    : `/books/${bookId}/ai-requests`;
  return request<{ request: AiRequestRecord | null }>(path, {
    accessToken,
    body: {
      ...(payload.chapterIds ? { chapterIds: payload.chapterIds } : {}),
      kind: payload.kind,
      ...(payload.model ? { model: payload.model } : {}),
      promptText: payload.promptText,
      ...(payload.visualType ? { visualType: payload.visualType } : {})
    },
    method: "POST"
  });
}

export function updateAiRequestShares(accessToken: string, bookId: string, requestId: string, sharedWithUserIds: string[]) {
  return request<{ sharedWithUserIds: string[] }>(`/books/${bookId}/ai-requests/${requestId}/shares`, {
    accessToken,
    body: { sharedWithUserIds },
    method: "PUT"
  });
}

export function deleteAiRequest(accessToken: string, bookId: string, requestId: string) {
  return request<void>(`/books/${bookId}/ai-requests/${requestId}`, {
    accessToken,
    method: "DELETE"
  });
}

export function updateBookOutline(accessToken: string, bookId: string, payload: { entries: Array<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">> }) {
  return request<void>(`/books/${bookId}/outline`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function regenerateBookOutline(accessToken: string, bookId: string) {
  return request<void>(`/books/${bookId}/outline/regenerate`, {
    accessToken,
    body: {},
    method: "POST"
  });
}

export function createBookmark(accessToken: string, bookId: string, payload: { paragraphId: string }) {
  return request<{ bookmark: ReaderBookmark }>(`/books/${bookId}/bookmarks`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function updateBookmarkShares(accessToken: string, bookId: string, bookmarkId: string, sharedWithUserIds: string[]) {
  return request<{ sharedWithUserIds: string[] }>(`/books/${bookId}/bookmarks/${bookmarkId}/shares`, {
    accessToken,
    body: { sharedWithUserIds },
    method: "PUT"
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
  payload: { charEnd: number; charStart: number; color: HighlightColor; highlightedText: string; paragraphId: string; sharedWithUserIds?: string[] }
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
  payload: { highlightId?: string; noteText: string; pageNumber?: number; paragraphId?: string; sharedWithUserIds?: string[] }
) {
  return request<{ note: ReaderNote }>(`/books/${bookId}/notes`, {
    accessToken,
    body: payload,
    method: "POST"
  });
}

export function updateNote(
  accessToken: string,
  bookId: string,
  noteId: string,
  payload: { highlightColor?: HighlightColor; noteText?: string; sharedWithUserIds?: string[] }
) {
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

export async function fetchBookCover(accessToken: string, bookId: string, cacheKey?: string | null): Promise<Blob | null> {
  const query = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : "";

  try {
    return await requestBlob(`/books/${bookId}/cover${query}`, accessToken);
  } catch (error) {
    if (error instanceof Error && typeof (error as Partial<ApiRequestError>).statusCode === "number" && (error as Partial<ApiRequestError>).statusCode === 404) {
      return null;
    }

    throw error;
  }
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

export async function createBookDownloadUrl(accessToken: string, bookId: string, payload: { format?: "epub" | "pdf"; kind: "export" | "original" }) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/download-token`, {
    accessToken,
    body: JSON.stringify(payload),
    fallbackMessage: "No se pudo preparar la descarga.",
    headers: createHeaders({ accessToken, contentType: "application/json" }),
    method: "POST"
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo preparar la descarga.");
  }

  const result = await response.json() as BookDownloadTokenResponse;
  return `${apiBaseUrl}/books/download/${encodeURIComponent(result.token)}`;
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

export function rerunOcrPage(accessToken: string, bookId: string, pageNumber: number, payload?: ImageOcrRequestOptions) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/rerun-ocr`, {
    accessToken,
    body: {
      ocrMode: payload?.ocrMode ?? "VISION",
      ...(payload?.promptOverride?.trim() ? { promptOverride: payload.promptOverride.trim() } : {})
    },
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

export function fetchChapterAudioOfflinePlan(accessToken: string, bookId: string, chapterId: string, voiceModel: string) {
  const query = new URLSearchParams({ voiceModel });
  return request<ChapterAudioOfflinePlan>(`/books/${bookId}/sections/${encodeURIComponent(chapterId)}/tts/offline-plan?${query.toString()}`, { accessToken });
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

export async function requestAiResponseAudio(accessToken: string, bookId: string, requestId: string, options: ReaderAudioOptions = {}) {
  const response = await fetchWithAutoRefresh(`/books/${bookId}/ai-requests/${requestId}/tts`, {
    accessToken,
    body: JSON.stringify({ voiceModel: options.voiceModel }),
    fallbackMessage: "No se pudo generar el audio de la respuesta.",
    headers: createHeaders({ accessToken, contentType: "application/json" }),
    method: "POST",
    signal: options.signal
  });

  if (!response.ok) {
    throw await createApiRequestError(response, "No se pudo generar el audio de la respuesta.");
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
