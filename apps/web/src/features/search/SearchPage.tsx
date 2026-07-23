import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { fetchBookSearch, fetchGlobalBookSearch, type BookSearchResult } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

const SEARCH_DEBOUNCE_MS = 260;
const SEARCH_PAGE_SIZE = 25;
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
    .filter((token) => token.length >= 1);

  return Array.from(new Set(
    normalizedQuery.length >= 1
      ? [normalizedQuery, ...tokens]
      : tokens
  )).sort((left, right) => right.length - left.length);
}

function renderHighlightedExcerpt(text: string, query: string, caseSensitive: boolean): ReactNode {
  const patterns = buildSearchPatterns(query);
  if (patterns.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${patterns.map((entry) => escapeRegExp(entry)).join("|")})`, caseSensitive ? "gu" : "giu");
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (!part) {
      return null;
    }

    const comparedPart = caseSensitive ? part : part.toLocaleLowerCase("es");
    const isMatch = patterns.some((entry) => (caseSensitive ? entry : entry.toLocaleLowerCase("es")) === comparedPart);
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

function buildResultExcerpt(text: string, query: string, caseSensitive: boolean) {
  const normalizedText = text.replace(/\s+/gu, " ").trim();
  if (!normalizedText) {
    return "";
  }

  if (normalizedText.length <= LONG_PARAGRAPH_EXCERPT_LENGTH) {
    return normalizedText;
  }

  const patterns = buildSearchPatterns(query);
  const haystack = caseSensitive ? normalizedText : normalizedText.toLocaleLowerCase("es");
  const matchIndex = patterns
    .map((entry) => ({ entry, index: haystack.indexOf(caseSensitive ? entry : entry.toLocaleLowerCase("es")) }))
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
  const urlCaseSensitive = searchParams.get("caseSensitive") === "true";
  const isBookScopedSearch = Boolean(filterBookId);
  const [searchQuery, setSearchQuery] = useState(urlQuery);
  const [executedSearchQuery, setExecutedSearchQuery] = useState(urlQuery);
  const [caseSensitiveSearch, setCaseSensitiveSearch] = useState(urlCaseSensitive);
  const [executedCaseSensitiveSearch, setExecutedCaseSensitiveSearch] = useState(urlCaseSensitive);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchResults, setSearchResults] = useState<BookSearchResult[]>([]);
  const [hasMoreSearchResults, setHasMoreSearchResults] = useState(false);
  const pendingSearchUrlStateRef = useRef<string | null>(null);
  const navigationState = (location.state as { returnTo?: string } | null) ?? null;

  function updateSearchUrl(normalizedQuery: string, caseSensitive: boolean) {
    if (normalizedQuery === urlQuery && caseSensitive === urlCaseSensitive) {
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
    if (caseSensitive) {
      nextSearchParams.set("caseSensitive", "true");
    }

    pendingSearchUrlStateRef.current = JSON.stringify([normalizedQuery, caseSensitive]);
    setSearchParams(nextSearchParams, { replace: true });
  }

  function executeSearch(normalizedQuery: string, caseSensitive = caseSensitiveSearch) {
    setSearchOffset(0);
    setSearchResults([]);
    setHasMoreSearchResults(false);
    setExecutedSearchQuery(normalizedQuery);
    setExecutedCaseSensitiveSearch(caseSensitive);
    updateSearchUrl(normalizedQuery, caseSensitive);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    executeSearch(searchQuery.trim());
  }

  useEffect(() => {
    const currentSearchUrlState = JSON.stringify([urlQuery, urlCaseSensitive]);
    if (pendingSearchUrlStateRef.current === currentSearchUrlState) {
      pendingSearchUrlStateRef.current = null;
      return;
    }

    pendingSearchUrlStateRef.current = null;
    setSearchQuery(urlQuery);
    setCaseSensitiveSearch(urlCaseSensitive);
    setExecutedSearchQuery(urlQuery);
    setExecutedCaseSensitiveSearch(urlCaseSensitive);
    setSearchOffset(0);
    setSearchResults([]);
    setHasMoreSearchResults(false);
  }, [urlCaseSensitive, urlQuery]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const normalizedQuery = searchQuery.trim();
      if (normalizedQuery.length >= 3 || normalizedQuery.length === 0) {
        if (normalizedQuery === executedSearchQuery && caseSensitiveSearch === executedCaseSensitiveSearch) {
          return;
        }

        executeSearch(normalizedQuery);
        return;
      }

      if (executedSearchQuery && executedSearchQuery !== normalizedQuery) {
        executeSearch("");
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [caseSensitiveSearch, executedCaseSensitiveSearch, executedSearchQuery, filterBookId, filterBookTitle, searchQuery, setSearchParams, urlCaseSensitive, urlQuery]);

  const globalSearchQuery = useQuery({
    enabled: Boolean(accessToken && executedSearchQuery.length >= 1),
    queryKey: ["books-search", filterBookId || "all", executedSearchQuery, executedCaseSensitiveSearch, searchOffset],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      if (filterBookId) {
        return fetchBookSearch(accessToken, filterBookId, executedSearchQuery, { caseSensitive: executedCaseSensitiveSearch, limit: SEARCH_PAGE_SIZE, offset: searchOffset });
      }

      return fetchGlobalBookSearch(accessToken, executedSearchQuery, { caseSensitive: executedCaseSensitiveSearch, limit: SEARCH_PAGE_SIZE, offset: searchOffset });
    },
    staleTime: 30_000
  });

  useEffect(() => {
    if (!globalSearchQuery.data) {
      return;
    }

    setHasMoreSearchResults(globalSearchQuery.data.hasMore);
    setSearchResults((current) => searchOffset === 0
      ? globalSearchQuery.data.results
      : [...current, ...globalSearchQuery.data.results]);
  }, [globalSearchQuery.data, searchOffset]);

  function handleLoadMoreSearchResults() {
    setSearchOffset((current) => current + SEARCH_PAGE_SIZE);
  }

  const returnSearchParams = new URLSearchParams();
  if (filterBookId) {
    returnSearchParams.set("bookId", filterBookId);
  }
  if (filterBookTitle) {
    returnSearchParams.set("bookTitle", filterBookTitle);
  }
  if (executedSearchQuery) {
    returnSearchParams.set("q", executedSearchQuery);
  }
  if (executedCaseSensitiveSearch) {
    returnSearchParams.set("caseSensitive", "true");
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
    ? "Hay más coincidencias dentro del libro."
    : "Hay más coincidencias en tu biblioteca.";

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

        <form className="shelf-search-field search-page-field" onSubmit={handleSearchSubmit}>
          <input
            aria-label="Buscar"
            autoFocus
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={helperPlaceholder}
            value={searchQuery}
          />
          <button className="primary-button" disabled={!searchQuery.trim()} type="submit">Buscar</button>
        </form>
        <label className="search-page-case-sensitive-toggle">
          <input
            checked={caseSensitiveSearch}
            onChange={(event) => {
              const isChecked = event.target.checked;
              setCaseSensitiveSearch(isChecked);
              if (searchQuery.trim()) {
                executeSearch(searchQuery.trim(), isChecked);
              } else {
                updateSearchUrl("", isChecked);
              }
            }}
            type="checkbox"
          />
          Distinguir mayúsculas y minúsculas
        </label>

        {searchQuery.trim().length > 0 && searchQuery.trim().length < 3 ? <p className="subdued search-page-status">Pulsa Buscar para ejecutar búsquedas cortas. La búsqueda automática empieza con 3 caracteres.</p> : null}
        {executedSearchQuery.length >= 1 && searchOffset === 0 && globalSearchQuery.isLoading ? <p className="search-page-status">{loadingLabel}</p> : null}
        {executedSearchQuery.length >= 1 && globalSearchQuery.isError ? <p className="error-text search-page-status">{errorLabel}</p> : null}

        {executedSearchQuery.length >= 1 ? (
          <div className="shelf-search-results search-page-results">
            {searchResults.length ? searchResults.map((result) => (
              <Link
                className="book-card shelf-search-result search-page-result"
                key={`${result.bookId}:${result.pageNumber}:${result.paragraphNumber}:${result.paragraphId}`}
                state={{ returnTo }}
                to={`/books/${result.bookId}?page=${encodeURIComponent(String(result.pageNumber))}&paragraph=${encodeURIComponent(String(result.paragraphNumber))}&search=${encodeURIComponent(executedSearchQuery)}${executedCaseSensitiveSearch ? "&searchCaseSensitive=true" : ""}`}
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
                  <p className="search-page-result-excerpt">{renderHighlightedExcerpt(buildResultExcerpt(result.paragraphText, executedSearchQuery, executedCaseSensitiveSearch), executedSearchQuery, executedCaseSensitiveSearch)}</p>
                </div>
              </Link>
            )) : null}

            {!globalSearchQuery.isLoading && !globalSearchQuery.isError && globalSearchQuery.data && searchResults.length === 0 ? (
              <p className="subdued search-page-status">{noResultsLabel}</p>
            ) : null}

            {hasMoreSearchResults ? (
              <div className="search-page-load-more">
                <p className="subdued search-page-status">{moreResultsLabel}</p>
                <button className="secondary-button" disabled={globalSearchQuery.isFetching} onClick={handleLoadMoreSearchResults} type="button">
                  {globalSearchQuery.isFetching && searchOffset > 0 ? "Buscando más..." : "Buscar más"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
