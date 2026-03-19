import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchBookPage, fetchProgress, requestParagraphAudio, updateProgress, type ParagraphContent } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [currentPageNumber, setCurrentPageNumber] = useState(1);
  const [currentParagraphNumber, setCurrentParagraphNumber] = useState(1);
  const [isSavingProgress, setIsSavingProgress] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [pendingAutoPlayNextPage, setPendingAutoPlayNextPage] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
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

  const currentParagraphs = pageQuery.data?.page.paragraphs ?? [];
  const currentParagraph = currentParagraphs.find((paragraph) => paragraph.paragraphNumber === currentParagraphNumber) ?? currentParagraphs[0] ?? null;

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

    return `Página ${currentPageNumber}, párrafo ${currentParagraph.paragraphNumber}, avance ${readingPercentage.toFixed(1)}%.`;
  }, [currentPageNumber, currentParagraph, readingPercentage]);

  async function persistProgress(paragraph: ParagraphContent, pageNumber: number) {
    if (!accessToken) {
      return;
    }

    setIsSavingProgress(true);

    try {
      await updateProgress(accessToken, bookId, {
        audioOffsetMs: 0,
        currentPageNumber: pageNumber,
        currentParagraphNumber: paragraph.paragraphNumber,
        currentSequenceNumber: paragraph.sequenceNumber,
        readingPercentage
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

  async function advanceToNextParagraphAfterPlayback() {
    if (!currentParagraph || !pageQuery.data) {
      setAutoPlay(false);
      return;
    }

    const paragraphIndex = currentParagraphs.findIndex((paragraph) => paragraph.paragraphId === currentParagraph.paragraphId);
    const nextParagraph = currentParagraphs[paragraphIndex + 1];

    if (nextParagraph) {
      setCurrentParagraphNumber(nextParagraph.paragraphNumber);
      await persistProgress(nextParagraph, currentPageNumber);
      await playParagraph(nextParagraph, currentPageNumber, true);
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
          void advanceToNextParagraphAfterPlayback();
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

  return (
    <div className="page-grid reader-layout">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Lectura</p>
            <h2>{pageQuery.data?.book.title ?? "Cargando libro..."}</h2>
          </div>
          <Link className="secondary-button link-button" to="/">
            Volver a la estantería
          </Link>
        </div>

        <div className="reader-canvas">
          <div className="reader-page">
            <p className="page-label">Estado del lector</p>
            <p className="reader-copy">{readerSummary}</p>
            <p className="reader-copy subdued">
              El lector ya navega por páginas y párrafos extraídos del archivo importado, guarda la posición y sintetiza el párrafo actual con Deepgram cuando pulsas reproducir.
            </p>

            {pageQuery.isLoading ? <p className="reader-copy subdued">Cargando página...</p> : null}
            {pageQuery.isError ? <p className="error-text">No se pudo cargar el contenido del libro.</p> : null}
            {readerError ? <p className="error-text">{readerError}</p> : null}

            <div className="paragraph-list">
              {currentParagraphs.map((paragraph) => (
                <button
                  className={paragraph.paragraphNumber === currentParagraph?.paragraphNumber ? "paragraph-card active" : "paragraph-card"}
                  key={paragraph.paragraphId}
                  onClick={() => void selectParagraph(paragraph)}
                  type="button"
                >
                  <span className="paragraph-label">Párrafo {paragraph.paragraphNumber}</span>
                  <span>{paragraph.paragraphText}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <aside className="panel controls-panel">
        <p className="eyebrow">Controles</p>
        <div className="controls-grid">
          <button className="secondary-button" disabled={!pageQuery.data?.hasPreviousPage} onClick={() => void goToPage(currentPageNumber - 1)} type="button">
            Página anterior
          </button>
          <button className="primary-button" disabled={!currentParagraph || isAudioLoading} onClick={() => void handlePlay()} type="button">
            {isAudioLoading ? "Generando audio..." : isAudioPlaying ? "Reproduciendo" : "Reproducir"}
          </button>
          <button className="secondary-button" disabled={!isAudioPlaying && !audioRef.current} onClick={() => handlePause()} type="button">
            Pausar
          </button>
          <button className="secondary-button" disabled={!pageQuery.data?.hasNextPage} onClick={() => void goToPage(currentPageNumber + 1)} type="button">
            Página siguiente
          </button>
          <button className="secondary-button" disabled={!currentParagraph || currentParagraph.paragraphNumber === currentParagraphs[0]?.paragraphNumber} onClick={() => void goToParagraph(-1)} type="button">
            Párrafo anterior
          </button>
          <button className="secondary-button" disabled={!currentParagraph || currentParagraph.paragraphNumber === currentParagraphs[currentParagraphs.length - 1]?.paragraphNumber} onClick={() => void goToParagraph(1)} type="button">
            {isSavingProgress ? "Guardando..." : "Párrafo siguiente"}
          </button>
        </div>

        <dl className="meta-list">
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
      </aside>
    </div>
  );
}