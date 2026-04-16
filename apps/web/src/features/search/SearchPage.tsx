import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { fetchBookSearch, fetchGlobalBookSearch } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

const SEARCH_DEBOUNCE_MS = 260;
const LONG_PARAGRAPH_EXCERPT_LENGTH = 340;

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildSearchPatterns(query: string) {
  const normalizedQuery = query.trim();
  const tokens = normalizedQuery
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  return Array.from(new Set(
    normalizedQuery.length >= 2
      ? [normalizedQuery, ...tokens]
      : tokens
  )).sort((left, right) => right.length - left.length);
}

function renderHighlightedExcerpt(text: string, query: string): ReactNode {
  const patterns = buildSearchPatterns(query);
  if (patterns.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${patterns.map((entry) => escapeRegExp(entry)).join("|")})`, "giu");
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (!part) {
      return null;
    }

    const partLower = part.toLocaleLowerCase("es");
    const isMatch = patterns.some((entry) => entry.toLocaleLowerCase("es") === partLower);
    if (!isMatch) {
      return <span key={`excerpt-${index}`}>{part}</span>;
    }

    return <mark className="shelf-search-highlight" key={`excerpt-${index}`}>{part}</mark>;
  });
}

function clampToWordBoundary(text: string, index: number, direction: "start" | "end") {
  if (direction === "start") {
    const boundary = text.lastIndexOf(" ", index);
    return boundary === -1 ? 0 : boundary + 1;
  }

  const boundary = text.indexOf(" ", index);
  return boundary === -1 ? text.length : boundary;
}

function buildResultExcerpt(text: string, query: string) {
  const normalizedText = text.replace(/\s+/gu, " ").trim();
  if (!normalizedText) {
    return "";
  }

  if (normalizedText.length <= LONG_PARAGRAPH_EXCERPT_LENGTH) {
    return normalizedText;
  }

  const patterns = buildSearchPatterns(query);
  const haystack = normalizedText.toLocaleLowerCase("es");
  const matchIndex = patterns
    .map((entry) => ({ entry, index: haystack.indexOf(entry.toLocaleLowerCase("es")) }))
    .find((candidate) => candidate.index >= 0);

  if (!matchIndex) {
    return `${normalizedText.slice(0, LONG_PARAGRAPH_EXCERPT_LENGTH).trimEnd()}...`;
  }

  const contextBefore = 130;
  const contextAfter = 190;
  const roughStart = Math.max(0, matchIndex.index - contextBefore);
  const roughEnd = Math.min(normalizedText.length, matchIndex.index + matchIndex.entry.length + contextAfter);
  const start = roughStart === 0 ? 0 : clampToWordBoundary(normalizedText, roughStart, "start");
  const end = roughEnd === normalizedText.length ? normalizedText.length : clampToWordBoundary(normalizedText, roughEnd, "end");
  const excerpt = normalizedText.slice(start, end).trim();

  return `${start > 0 ? "..." : ""}${excerpt}${end < normalizedText.length ? "..." : ""}`;
}

export function SearchPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q")?.trim() ?? "";
  const filterBookId = searchParams.get("bookId")?.trim() ?? "";
  const filterBookTitle = searchParams.get("bookTitle")?.trim() ?? "";
  const isBookScopedSearch = Boolean(filterBookId);
  const [searchQuery, setSearchQuery] = useState(urlQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(urlQuery);
  const navigationState = (location.state as { returnTo?: string } | null) ?? null;

  useEffect(() => {
    if (urlQuery === debouncedSearchQuery) {
      return;
    }

    setSearchQuery(urlQuery);
    setDebouncedSearchQuery(urlQuery);
  }, [debouncedSearchQuery, urlQuery]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const normalizedQuery = searchQuery.trim();
      setDebouncedSearchQuery(normalizedQuery);

      if (normalizedQuery === urlQuery) {
        return;
      }

      const nextSearchParams = new URLSearchParams();
      if (filterBookId) {
        nextSearchParams.set("bookId", filterBookId);
      }
      if (filterBookTitle) {
        nextSearchParams.set("bookTitle", filterBookTitle);
      }
      if (normalizedQuery) {
        nextSearchParams.set("q", normalizedQuery);
      }

      setSearchParams(nextSearchParams, { replace: true });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [filterBookId, filterBookTitle, searchQuery, setSearchParams, urlQuery]);

  const globalSearchQuery = useQuery({
    enabled: Boolean(accessToken && debouncedSearchQuery.length >= 2),
    queryKey: ["books-search", filterBookId || "all", debouncedSearchQuery],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      if (filterBookId) {
        return fetchBookSearch(accessToken, filterBookId, debouncedSearchQuery, { limit: 24, offset: 0 });
      }

      return fetchGlobalBookSearch(accessToken, debouncedSearchQuery, { limit: 24, offset: 0 });
    },
    staleTime: 30_000
  });

  const returnSearchParams = new URLSearchParams();
  if (filterBookId) {
    returnSearchParams.set("bookId", filterBookId);
  }
  if (filterBookTitle) {
    returnSearchParams.set("bookTitle", filterBookTitle);
  }
  if (debouncedSearchQuery) {
    returnSearchParams.set("q", debouncedSearchQuery);
  }

  const returnTo = returnSearchParams.toString() ? `/search?${returnSearchParams.toString()}` : "/search";
  const backTo = navigationState?.returnTo?.trim() || (filterBookId ? `/books/${filterBookId}` : "/");
  const backLabel = filterBookId ? "Volver al libro" : "Volver a la estantería";
  const heading = filterBookId ? filterBookTitle || "Libro" : null;
  const eyebrow = filterBookId ? "BÚSQUEDA EN EL LIBRO" : "BÚSQUEDA GLOBAL";
  const helperPlaceholder = filterBookId ? "Busca palabras o frases en este libro" : "Busca palabras o frases en toda tu biblioteca";
  const loadingLabel = filterBookId ? "Buscando coincidencias en este libro..." : "Buscando coincidencias en tu biblioteca...";
  const errorLabel = filterBookId ? "No se pudo completar la búsqueda en este libro." : "No se pudo completar la búsqueda global.";
  const noResultsLabel = filterBookId ? "No se encontraron coincidencias en este libro." : "No se encontraron coincidencias en tus libros.";
  const moreResultsLabel = filterBookId
    ? "Se muestran las primeras coincidencias. Refina la búsqueda para acotar resultados dentro del libro."
    : "Se muestran las primeras coincidencias. Refina la búsqueda para acotar resultados.";

  return (
    <div className="page-stack shelf-layout search-layout">
      <section className="panel wide-panel search-page-panel">
        <div className="panel-header compact-header search-page-header">
          <div className="search-page-copy">
            <p className="eyebrow">{eyebrow}</p>
            {heading ? <h2>{heading}</h2> : null}
          </div>
          <Link
            aria-label={backLabel}
            className="secondary-button link-button reader-header-icon-button"
            title={backLabel}
            to={backTo}
          >
            <BackIcon />
          </Link>
        </div>

        <div className="shelf-search-field search-page-field">
          <input
            aria-label="Buscar"
            autoFocus
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={helperPlaceholder}
            value={searchQuery}
          />
        </div>

        {searchQuery.trim().length === 1 ? <p className="subdued search-page-status">Escribe al menos 2 caracteres para buscar en el contenido.</p> : null}
        {debouncedSearchQuery.length >= 2 && globalSearchQuery.isLoading ? <p className="search-page-status">{loadingLabel}</p> : null}
        {debouncedSearchQuery.length >= 2 && globalSearchQuery.isError ? <p className="error-text search-page-status">{errorLabel}</p> : null}

        {debouncedSearchQuery.length >= 2 ? (
          <div className="shelf-search-results search-page-results">
            {globalSearchQuery.data?.results.length ? globalSearchQuery.data.results.map((result) => (
              <Link
                className="book-card shelf-search-result search-page-result"
                key={`${result.bookId}:${result.pageNumber}:${result.paragraphNumber}:${result.paragraphId}`}
                state={{ returnTo }}
                to={`/books/${result.bookId}?page=${encodeURIComponent(String(result.pageNumber))}&paragraph=${encodeURIComponent(String(result.paragraphNumber))}&search=${encodeURIComponent(debouncedSearchQuery)}`}
              >
                <div className="book-card-copy shelf-search-result-copy search-page-result-copy">
                  <strong className="search-page-result-book-title">{result.title}</strong>
                  <div className="search-page-result-meta-line">
                    <span className="search-page-result-section">Sección: {result.sectionTitle ?? "Sin sección"}</span>
                    <span aria-hidden="true" className="search-page-result-separator">·</span>
                    <span className="search-page-result-location">Página: {result.pageNumber}</span>
                    <span aria-hidden="true" className="search-page-result-separator">·</span>
                    <span className="search-page-result-paragraph">Párrafo: {result.paragraphNumber}</span>
                  </div>
                  <p className="search-page-result-excerpt">{renderHighlightedExcerpt(buildResultExcerpt(result.paragraphText, debouncedSearchQuery), debouncedSearchQuery)}</p>
                </div>
              </Link>
            )) : null}

            {!globalSearchQuery.isLoading && !globalSearchQuery.isError && globalSearchQuery.data && globalSearchQuery.data.results.length === 0 ? (
              <p className="subdued search-page-status">{noResultsLabel}</p>
            ) : null}

            {globalSearchQuery.data?.hasMore ? (
              <p className="subdued search-page-status">{moreResultsLabel}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}