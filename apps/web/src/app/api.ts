import type { SessionUser } from "./auth-store";

const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type ApiOptions = {
  accessToken?: string | null;
  body?: unknown;
  method?: "GET" | "POST" | "PUT" | "DELETE";
};

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const requestInit: RequestInit = {
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
    },
    method: options.method ?? "GET"
  };

  if (options.body) {
    requestInit.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, requestInit);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "La solicitud no se pudo completar.");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, accessToken: string): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    method: "GET"
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "La solicitud no se pudo completar.");
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
  sourceType: "PDF" | "EPUB" | "IMAGES";
  status: string;
  title: string;
  totalPages: number;
  totalParagraphs: number;
  updatedAt?: string;
};

export type ParagraphContent = {
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

export type BookPageResponse = {
  book: BookSummary & { synopsis?: string | null };
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  page: {
    editedText: string | null;
    hasSourceImage: boolean;
    ocrStatus: string;
    pageNumber: number;
    paragraphs: ParagraphContent[];
    rawText: string | null;
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
  const response = await fetch(`${apiBaseUrl}/books/import`, {
    body: payload,
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorPayload?.message ?? "No se pudo importar el libro.");
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export async function createImageBook(accessToken: string, payload: FormData) {
  const response = await fetch(`${apiBaseUrl}/books/from-images`, {
    body: payload,
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorPayload?.message ?? "No se pudo crear el libro desde imágenes.");
  }

  return response.json() as Promise<{ book: BookSummary }>;
}

export async function appendImagesToBook(accessToken: string, bookId: string, payload: FormData) {
  const response = await fetch(`${apiBaseUrl}/books/${bookId}/import-images`, {
    body: payload,
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorPayload?.message ?? "No se pudieron añadir imágenes al libro.");
  }

  return response.json() as Promise<{ addedPages: number; addedParagraphs: number; book: BookSummary }>;
}

export function fetchBook(accessToken: string, bookId: string) {
  return request<{ book: BookSummary & { synopsis?: string | null } }>(`/books/${bookId}`, { accessToken });
}

export function fetchBookPage(accessToken: string, bookId: string, pageNumber: number) {
  return request<BookPageResponse>(`/books/${bookId}/pages/${pageNumber}`, { accessToken });
}

export function fetchBookPageImage(accessToken: string, bookId: string, pageNumber: number) {
  return requestBlob(`/books/${bookId}/pages/${pageNumber}/image`, accessToken);
}

export function updateOcrPage(accessToken: string, bookId: string, pageNumber: number, payload: { editedText: string }) {
  return request<void>(`/books/${bookId}/pages/${pageNumber}/ocr`, {
    accessToken,
    body: payload,
    method: "PUT"
  });
}

export function fetchProgress(accessToken: string, bookId: string) {
  return request<{ progress: ReadingProgress | null }>(`/books/${bookId}/progress`, { accessToken });
}

export function updateProgress(accessToken: string, bookId: string, payload: Omit<ReadingProgress, "lastOpenedAt" | "progressId" | "updatedAt">) {
  return request<void>(`/books/${bookId}/progress`, { accessToken, body: payload, method: "PUT" });
}

export async function requestParagraphAudio(accessToken: string, bookId: string, paragraphId: string) {
  const response = await fetch(`${apiBaseUrl}/books/${bookId}/tts`, {
    body: JSON.stringify({ paragraphId }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorPayload?.message ?? "No se pudo generar el audio del párrafo.");
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