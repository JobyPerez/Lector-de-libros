import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { deleteBookPage, fetchBookPage, fetchBookPageImage, fetchProgress, requestParagraphAudio, updateProgress, type ParagraphContent } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

function ReaderControlIcon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function PagePreviousIcon() {
  return (
    <ReaderControlIcon>
      <path d="M7 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M17 7L10 12L17 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function PageNextIcon() {
  return (
    <ReaderControlIcon>
      <path d="M17 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M7 7L14 12L7 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function ParagraphPreviousIcon() {
  return (
    <ReaderControlIcon>
      <path d="M15.5 7L9 12L15.5 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function ParagraphNextIcon() {
  return (
    <ReaderControlIcon>
      <path d="M8.5 7L15 12L8.5 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function PlayIcon() {
  return (
    <ReaderControlIcon>
      <path d="M9 7.5V16.5L16.5 12L9 7.5Z" fill="currentColor" />
    </ReaderControlIcon>
  );
}

function PauseIcon() {
  return (
    <ReaderControlIcon>
      <path d="M9 7H10.8V17H9V7Z" fill="currentColor" />
      <path d="M13.2 7H15V17H13.2V7Z" fill="currentColor" />
    </ReaderControlIcon>
  );
}

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [currentPageNumber, setCurrentPageNumber] = useState(1);
  const [currentParagraphNumber, setCurrentParagraphNumber] = useState(1);
  const [isSourcePanelVisible, setIsSourcePanelVisible] = useState(false);
  const [isSavingProgress, setIsSavingProgress] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [pendingAutoPlayNextPage, setPendingAutoPlayNextPage] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [isDeletingPage, setIsDeletingPage] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const progressHydratedRef = useRef(false);

  const progressQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["progress", bookId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchProgress(accessToken, bookId);
    }
  });

  const pageQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["book-page", bookId, currentPageNumber],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchBookPage(accessToken, bookId, currentPageNumber);
    }
  });

  useEffect(() => {
    const savedProgress = progressQuery.data?.progress;
    if (!savedProgress || progressHydratedRef.current) {
      return;
    }

    progressHydratedRef.current = true;
    setCurrentPageNumber(savedProgress.currentPageNumber);
    setCurrentParagraphNumber(savedProgress.currentParagraphNumber);
  }, [progressQuery.data?.progress]);

  useEffect(() => {
    const paragraphs = pageQuery.data?.page.paragraphs ?? [];
    if (paragraphs.length === 0) {
      return;
    }

    const matchingParagraph = paragraphs.find((paragraph) => paragraph.paragraphNumber === currentParagraphNumber);
    if (!matchingParagraph) {
      const firstParagraph = paragraphs[0];
      if (firstParagraph) {
        setCurrentParagraphNumber(firstParagraph.paragraphNumber);
      }
    }
  }, [currentParagraphNumber, pageQuery.data?.page.paragraphs]);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let nextObjectUrl: string | null = null;

    if (!accessToken || !pageQuery.data?.page.hasSourceImage) {
      setPageImageUrl(null);
      return () => {
        active = false;
      };
    }

    void fetchBookPageImage(accessToken, bookId, currentPageNumber)
      .then((imageBlob) => {
        if (!active) {
          return;
        }

        nextObjectUrl = URL.createObjectURL(imageBlob);
        setPageImageUrl(nextObjectUrl);
      })
      .catch(() => {
        if (active) {
          setPageImageUrl(null);
        }
      });

    return () => {
      active = false;
      if (nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
      }
    };
  }, [accessToken, bookId, currentPageNumber, pageQuery.data?.page.hasSourceImage]);

  const currentParagraphs = pageQuery.data?.page.paragraphs ?? [];
  const currentParagraph = currentParagraphs.find((paragraph) => paragraph.paragraphNumber === currentParagraphNumber) ?? currentParagraphs[0] ?? null;
  const hasOriginalPanelContent = Boolean(pageQuery.data?.page.hasSourceImage || pageQuery.data?.page.rawText);
  const appendPagesLink = {
    hash: "#append-pages",
    pathname: "/builder",
    search: `?appendBookId=${encodeURIComponent(bookId)}&insertAfterPage=${encodeURIComponent(String(currentPageNumber))}`
  };

  const readingPercentage = useMemo(() => {
    if (!pageQuery.data?.book.totalParagraphs || !currentParagraph) {
      return 0;
    }

    return Math.min((currentParagraph.sequenceNumber / pageQuery.data.book.totalParagraphs) * 100, 100);
  }, [currentParagraph, pageQuery.data?.book.totalParagraphs]);

  const readerSummary = useMemo(() => {
    if (!currentParagraph) {
      return "El libro todavía no tiene contenido legible para esta página.";
    }

    return `Página ${currentPageNumber}, avance ${readingPercentage.toFixed(1)}%.`;
  }, [currentPageNumber, currentParagraph, readingPercentage]);

  async function persistProgress(paragraph: ParagraphContent, pageNumber: number) {
    if (!accessToken) {
      return;
    }

    const totalParagraphs = pageQuery.data?.book.totalParagraphs ?? 0;
    const nextReadingPercentage = totalParagraphs > 0
      ? Math.min((paragraph.sequenceNumber / totalParagraphs) * 100, 100)
      : 0;

    setIsSavingProgress(true);

    try {
      await updateProgress(accessToken, bookId, {
        audioOffsetMs: 0,
        currentPageNumber: pageNumber,
        currentParagraphNumber: paragraph.paragraphNumber,
        currentSequenceNumber: paragraph.sequenceNumber,
        readingPercentage: nextReadingPercentage
      });
    } finally {
      setIsSavingProgress(false);
    }
  }

  function clearAudioResource() {
    audioRef.current?.pause();
    audioRef.current = null;
    setIsAudioPlaying(false);

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  async function advanceToNextParagraphAfterPlayback(finishedParagraph: ParagraphContent, pageNumber: number) {
    if (!pageQuery.data) {
      setAutoPlay(false);
      return;
    }

    const paragraphIndex = currentParagraphs.findIndex((paragraph) => paragraph.paragraphId === finishedParagraph.paragraphId);
    const nextParagraph = currentParagraphs[paragraphIndex + 1];

    if (nextParagraph) {
      setCurrentParagraphNumber(nextParagraph.paragraphNumber);
      await persistProgress(nextParagraph, pageNumber);
      await playParagraph(nextParagraph, pageNumber, true);
      return;
    }

    if (pageQuery.data.hasNextPage) {
      setPendingAutoPlayNextPage(true);
      setCurrentPageNumber((pageNumber) => pageNumber + 1);
      return;
    }

    setAutoPlay(false);
    setIsAudioPlaying(false);
  }

  async function playParagraph(paragraph: ParagraphContent, pageNumber: number, keepAutoPlay: boolean) {
    if (!accessToken) {
      return;
    }

    setReaderError(null);
    setIsAudioLoading(true);

    try {
      clearAudioResource();
      const audioBlob = await requestParagraphAudio(accessToken, bookId, paragraph.paragraphId);
      const audioUrl = URL.createObjectURL(audioBlob);
      audioUrlRef.current = audioUrl;

      const audioElement = new Audio(audioUrl);
      audioRef.current = audioElement;
      audioElement.onplay = () => {
        setIsAudioPlaying(true);
      };
      audioElement.onpause = () => {
        setIsAudioPlaying(false);
      };
      audioElement.onended = () => {
        setIsAudioPlaying(false);
        if (keepAutoPlay) {
          void advanceToNextParagraphAfterPlayback(paragraph, pageNumber);
        }
      };

      setCurrentParagraphNumber(paragraph.paragraphNumber);
      await persistProgress(paragraph, pageNumber);
      await audioElement.play();
    } catch (error) {
      setAutoPlay(false);
      setReaderError(error instanceof Error ? error.message : "No se pudo reproducir el párrafo seleccionado.");
    } finally {
      setIsAudioLoading(false);
    }
  }

  useEffect(() => {
    if (!pendingAutoPlayNextPage) {
      return;
    }

    const firstParagraph = pageQuery.data?.page.paragraphs[0];
    if (!firstParagraph) {
      return;
    }

    setPendingAutoPlayNextPage(false);
    setCurrentParagraphNumber(firstParagraph.paragraphNumber);
    void playParagraph(firstParagraph, currentPageNumber, true);
  }, [currentPageNumber, pageQuery.data?.page.paragraphs, pendingAutoPlayNextPage]);

  async function handlePlay() {
    if (!currentParagraph) {
      return;
    }

    setAutoPlay(true);

    if (audioRef.current?.paused && audioRef.current.src) {
      await audioRef.current.play();
      return;
    }

    await playParagraph(currentParagraph, currentPageNumber, true);
  }

  function handlePause() {
    setAutoPlay(false);
    audioRef.current?.pause();
    setIsAudioPlaying(false);
  }

  async function selectParagraph(paragraph: ParagraphContent) {
    setCurrentParagraphNumber(paragraph.paragraphNumber);
    clearAudioResource();
    await persistProgress(paragraph, currentPageNumber);
  }

  async function goToPage(nextPageNumber: number) {
    clearAudioResource();
    setAutoPlay(false);
    setCurrentPageNumber(nextPageNumber);
    setCurrentParagraphNumber(1);
  }

  async function goToParagraph(delta: -1 | 1) {
    if (!currentParagraph) {
      return;
    }

    const paragraphIndex = currentParagraphs.findIndex((paragraph) => paragraph.paragraphId === currentParagraph.paragraphId);
    const nextParagraph = currentParagraphs[paragraphIndex + delta];
    if (!nextParagraph) {
      return;
    }

    clearAudioResource();
    setAutoPlay(false);
    setCurrentParagraphNumber(nextParagraph.paragraphNumber);
    await persistProgress(nextParagraph, currentPageNumber);
  }

  async function handleDeleteCurrentPage() {
    if (!accessToken || !pageQuery.data || isDeletingPage) {
      return;
    }

    const confirmed = window.confirm(`Se borrará la página ${currentPageNumber} de este libro. Esta acción no se puede deshacer. ¿Continuar?`);
    if (!confirmed) {
      return;
    }

    setIsDeletingPage(true);
    setReaderError(null);
    clearAudioResource();
    setAutoPlay(false);

    try {
      const response = await deleteBookPage(accessToken, bookId, currentPageNumber);

      if (response.nextPageNumber === null) {
        navigate({
          hash: "#append-pages",
          pathname: "/builder",
          search: `?appendBookId=${encodeURIComponent(bookId)}&insertAfterPage=0`
        });
        return;
      }

      setCurrentPageNumber(response.nextPageNumber);
      setCurrentParagraphNumber(1);
      await progressQuery.refetch();
      if (response.nextPageNumber === currentPageNumber) {
        await pageQuery.refetch();
      }
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo borrar la página actual.");
    } finally {
      setIsDeletingPage(false);
    }
  }

  return (
    <div className="page-grid reader-layout reader-floating-layout">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Lectura</p>
            <h2>{pageQuery.data?.book.title ?? "Cargando libro..."}</h2>
          </div>
          <div className="reader-header-actions">
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <Link className="secondary-button link-button" to={appendPagesLink}>
                Añadir páginas
              </Link>
            ) : null}
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <button className="danger-button" disabled={isDeletingPage} onClick={() => void handleDeleteCurrentPage()} type="button">
                {isDeletingPage ? "Borrando página..." : "Borrar página"}
              </button>
            ) : null}
            <Link className="secondary-button link-button" to="/">
              Volver a la estantería
            </Link>
            {hasOriginalPanelContent ? (
              <button
                aria-expanded={isSourcePanelVisible}
                className="secondary-button"
                onClick={() => setIsSourcePanelVisible((current) => !current)}
                type="button"
              >
                {isSourcePanelVisible ? "Ocultar original" : "Página original"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="reader-canvas">
          <div className={isSourcePanelVisible ? "reader-split reader-split-expanded" : "reader-split"}>
            <div className="reader-page">
              <p className="page-label">Estado del lector</p>
              <p className="reader-copy">{readerSummary}</p>
              <p className="reader-copy subdued">
                La página muestra el texto listo para lectura y, si procede de imágenes, también conserva la fuente original para comparar el OCR.
              </p>

              {pageQuery.isLoading ? <p className="reader-copy subdued">Cargando página...</p> : null}
              {pageQuery.isError ? <p className="error-text">No se pudo cargar el contenido del libro.</p> : null}
              {readerError ? <p className="error-text">{readerError}</p> : null}

              <article className="reader-prose">
                {currentParagraphs.map((paragraph) => (
                  <p
                    className={paragraph.paragraphNumber === currentParagraph?.paragraphNumber ? "reader-paragraph active" : "reader-paragraph"}
                    key={paragraph.paragraphId}
                    onClick={() => void selectParagraph(paragraph)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void selectParagraph(paragraph);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    {paragraph.paragraphText}
                  </p>
                ))}
              </article>

              <footer className="reader-page-footer">
                <dl className="meta-list reader-meta-list">
                  <div>
                    <dt>Origen</dt>
                    <dd>{pageQuery.data?.book.sourceType ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Páginas</dt>
                    <dd>{pageQuery.data?.book.totalPages ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Párrafos</dt>
                    <dd>{pageQuery.data?.book.totalParagraphs ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Posición</dt>
                    <dd>{currentPageNumber}.{currentParagraph?.paragraphNumber ?? 1}</dd>
                  </div>
                </dl>
              </footer>
            </div>

            {isSourcePanelVisible ? (
              <aside className="reader-source-panel">
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">Página original</p>
                    <h3>Comparación OCR</h3>
                  </div>
                  <span className="tag-chip">{pageQuery.data?.page.ocrStatus ?? "-"}</span>
                </div>

                {pageImageUrl ? (
                  <img alt={`Página ${currentPageNumber} del libro`} className="preview-image" src={pageImageUrl} />
                ) : (
                  <div className="empty-state compact-state">
                    <p>Esta página no tiene imagen original adjunta.</p>
                  </div>
                )}

                {pageQuery.data?.page.rawText ? (
                  <details className="raw-text-panel">
                    <summary>Texto OCR base</summary>
                    <p>{pageQuery.data.page.rawText}</p>
                  </details>
                ) : null}
              </aside>
            ) : null}
          </div>
        </div>
      </section>

      <div aria-label="Controles flotantes del lector" className="reader-floating-controls" role="toolbar">
        <button
          aria-label="Página anterior"
          className="reader-float-button"
          disabled={!pageQuery.data?.hasPreviousPage}
          onClick={() => void goToPage(currentPageNumber - 1)}
          title="Página anterior"
          type="button"
        >
          <PagePreviousIcon />
        </button>
        <button
          aria-label="Párrafo anterior"
          className="reader-float-button"
          disabled={!currentParagraph || currentParagraph.paragraphNumber === currentParagraphs[0]?.paragraphNumber}
          onClick={() => void goToParagraph(-1)}
          title="Párrafo anterior"
          type="button"
        >
          <ParagraphPreviousIcon />
        </button>
        <button
          aria-label={isAudioLoading ? "Generando audio" : "Reproducir"}
          className="reader-float-button primary"
          disabled={!currentParagraph || isAudioLoading}
          onClick={() => void handlePlay()}
          title={isAudioLoading ? "Generando audio" : "Reproducir"}
          type="button"
        >
          <PlayIcon />
        </button>
        <button
          aria-label="Pausar"
          className="reader-float-button"
          disabled={!isAudioPlaying && !audioRef.current}
          onClick={() => handlePause()}
          title="Pausar"
          type="button"
        >
          <PauseIcon />
        </button>
        <button
          aria-label="Párrafo siguiente"
          className="reader-float-button"
          disabled={!currentParagraph || currentParagraph.paragraphNumber === currentParagraphs[currentParagraphs.length - 1]?.paragraphNumber}
          onClick={() => void goToParagraph(1)}
          title={isSavingProgress ? "Guardando progreso" : "Párrafo siguiente"}
          type="button"
        >
          <ParagraphNextIcon />
        </button>
        <button
          aria-label="Página siguiente"
          className="reader-float-button"
          disabled={!pageQuery.data?.hasNextPage}
          onClick={() => void goToPage(currentPageNumber + 1)}
          title="Página siguiente"
          type="button"
        >
          <PageNextIcon />
        </button>
      </div>
    </div>
  );
}