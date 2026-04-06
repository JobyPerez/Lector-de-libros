import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { deleteBookPage, fetchBookPage, fetchBookPageImage, fetchProgress, requestParagraphAudio, updateProgress, type ParagraphContent } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

const READER_VOICE_STORAGE_KEY = "lector.reader.voiceModel";
const READER_SPEED_STORAGE_KEY = "lector.reader.playbackRate";
const DEFAULT_VOICE_MODEL = "aura-2-diana-es";
const DEFAULT_PLAYBACK_RATE = 1.1;
const MIN_PLAYBACK_RATE = 0.8;
const MAX_PLAYBACK_RATE = 1.35;
const PLAYBACK_RATE_STEP = 0.05;
const PAGE_TURN_DURATION_MS = 760;

type PageTurnDirection = "forward" | "backward";

type PageTurnSnapshot = {
  activeParagraphNumber: number | null;
  htmlContent: string | null;
  pageNumber: number;
  paragraphs: ParagraphContent[];
};

type PrefetchedParagraphAudio = {
  blob?: Blob;
  controller?: AbortController;
  pageNumber: number;
  paragraphId: string;
  promise?: Promise<Blob>;
  voiceModel: string;
};

const TTS_VOICE_OPTIONS = [
  { description: "Femenina, expresiva, ideal para narración", label: "Diana", value: "aura-2-diana-es" },
  { description: "Femenina, cálida y natural", label: "Silvia", value: "aura-2-silvia-es" },
  { description: "Femenina, acento latino neutro", label: "Selena", value: "aura-2-selena-es" },
  { description: "Femenina, serena y pausada", label: "Estrella", value: "aura-2-estrella-es" },
  { description: "Masculina, voz actual del sistema", label: "Néstor", value: "aura-2-nestor-es" }
] as const;

function readStoredVoiceModel() {
  if (typeof window === "undefined") {
    return DEFAULT_VOICE_MODEL;
  }

  const storedVoiceModel = window.localStorage.getItem(READER_VOICE_STORAGE_KEY);
  if (!storedVoiceModel) {
    return DEFAULT_VOICE_MODEL;
  }

  return TTS_VOICE_OPTIONS.some((voice) => voice.value === storedVoiceModel)
    ? storedVoiceModel
    : DEFAULT_VOICE_MODEL;
}

function readStoredPlaybackRate() {
  if (typeof window === "undefined") {
    return DEFAULT_PLAYBACK_RATE;
  }

  const storedPlaybackRate = Number(window.localStorage.getItem(READER_SPEED_STORAGE_KEY));
  if (!Number.isFinite(storedPlaybackRate)) {
    return DEFAULT_PLAYBACK_RATE;
  }

  return Math.min(Math.max(storedPlaybackRate, MIN_PLAYBACK_RATE), MAX_PLAYBACK_RATE);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function setMediaSessionPlaybackState(state: MediaSessionPlaybackState) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = state;
}

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

function AudioSettingsIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5 8.5H11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M5 15.5H8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M13 15.5H19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M16 8.5H19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <circle cx="13" cy="8.5" fill="currentColor" r="1.6" />
      <circle cx="10" cy="15.5" fill="currentColor" r="1.6" />
    </ReaderControlIcon>
  );
}

function AddPagesIcon() {
  return (
    <ReaderControlIcon>
      <path d="M12 7V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M7 12H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M5.5 4.5H14.5C15.6046 4.5 16.5 5.39543 16.5 6.5V9.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M9.5 19.5H18.5C19.6046 19.5 20.5 18.6046 20.5 17.5V10.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </ReaderControlIcon>
  );
}

function DeletePageIcon() {
  return (
    <ReaderControlIcon>
      <path d="M6.5 8H17.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M9.5 4.75H14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M8 8V17C8 18.1046 8.89543 19 10 19H14C15.1046 19 16 18.1046 16 17V8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M10.5 10.5V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M13.5 10.5V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </ReaderControlIcon>
  );
}

function ShelfIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5 7.5C5 6.39543 5.89543 5.5 7 5.5H17C18.1046 5.5 19 6.39543 19 7.5V16.5C19 17.6046 18.1046 18.5 17 18.5H7C5.89543 18.5 5 17.6046 5 16.5V7.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8.5 8.5H15.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8.5 12H15.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8.5 15.5H13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

function OriginalPageIcon() {
  return (
    <ReaderControlIcon>
      <rect height="13" rx="2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" width="13" x="5.5" y="5.5" />
      <path d="M8.5 14L10.7 11.8C11.0905 11.4095 11.7237 11.4095 12.1142 11.8L14.5 14.1858" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="10" cy="9.5" fill="currentColor" r="1.1" />
      <path d="M13.5 12.5L14.2 11.8C14.5905 11.4095 15.2237 11.4095 15.6142 11.8L18 14.1858" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
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
  const [isAudioSettingsVisible, setIsAudioSettingsVisible] = useState(false);
  const [isPageJumpActive, setIsPageJumpActive] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("1");
  const [selectedVoiceModel, setSelectedVoiceModel] = useState<string>(readStoredVoiceModel);
  const [playbackRate, setPlaybackRate] = useState<number>(readStoredPlaybackRate);
  const [pendingPageTurnDirection, setPendingPageTurnDirection] = useState<PageTurnDirection | null>(null);
  const [pageTurnDirection, setPageTurnDirection] = useState<PageTurnDirection | null>(null);
  const [pageTurnSnapshot, setPageTurnSnapshot] = useState<PageTurnSnapshot | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const activeAudioRequestRef = useRef<AbortController | null>(null);
  const prefetchedAudioRef = useRef<PrefetchedParagraphAudio | null>(null);
  const playbackAttemptRef = useRef(0);
  const progressHydratedRef = useRef(false);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const pageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const pageTurnTimeoutRef = useRef<number | null>(null);
  const paragraphRefs = useRef(new Map<number, HTMLParagraphElement>());
  const richContentRef = useRef<HTMLDivElement | null>(null);
  const requestedPageParam = searchParams.get("page")?.trim() ?? "";
  const requestedPageNumber = requestedPageParam ? Number(requestedPageParam) : Number.NaN;

  useEffect(() => {
    progressHydratedRef.current = false;
    setCurrentPageNumber(1);
    setCurrentParagraphNumber(1);
  }, [bookId]);

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
    if (Number.isInteger(requestedPageNumber) && requestedPageNumber >= 1) {
      progressHydratedRef.current = true;
      setCurrentPageNumber(requestedPageNumber);
      setCurrentParagraphNumber(1);
      navigate(`/books/${bookId}`, { replace: true });
      return;
    }

    const savedProgress = progressQuery.data?.progress;
    if (!savedProgress || progressHydratedRef.current) {
      return;
    }

    progressHydratedRef.current = true;
    setCurrentPageNumber(savedProgress.currentPageNumber);
    setCurrentParagraphNumber(savedProgress.currentParagraphNumber);
  }, [bookId, navigate, progressQuery.data?.progress, requestedPageNumber]);

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
    playbackAttemptRef.current += 1;
    activeAudioRequestRef.current?.abort();
    prefetchedAudioRef.current?.controller?.abort();
    audioRef.current?.pause();
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    if (pageTurnTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(READER_VOICE_STORAGE_KEY, selectedVoiceModel);
  }, [selectedVoiceModel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(READER_SPEED_STORAGE_KEY, playbackRate.toFixed(2));
  }, [playbackRate]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    clearPrefetchedAudio();
    clearAudioResource();
    setAutoPlay(false);
  }, [selectedVoiceModel]);

  useEffect(() => {
    clearPrefetchedAudio();
  }, [currentPageNumber]);

  useEffect(() => {
    if (isPageJumpActive) {
      return;
    }

    setPageJumpValue(String(currentPageNumber));
  }, [currentPageNumber, isPageJumpActive]);

  useEffect(() => {
    if (!isPageJumpActive || typeof window === "undefined") {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isPageJumpActive]);

  useEffect(() => {
    if (!isAudioSettingsVisible || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!audioSettingsRef.current?.contains(event.target as Node)) {
        setIsAudioSettingsVisible(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAudioSettingsVisible(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAudioSettingsVisible]);

  useEffect(() => {
    let active = true;
    let nextObjectUrl: string | null = null;

    if (!accessToken || !pageQuery.data?.page.hasSourceImage) {
      setPageImageUrl(null);
      return () => {
        active = false;
      };
    }

    void fetchBookPageImage(accessToken, bookId, currentPageNumber, pageQuery.data?.page.sourceFileId)
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
  }, [accessToken, bookId, currentPageNumber, pageQuery.data?.page.hasSourceImage, pageQuery.data?.page.sourceFileId]);

  const currentParagraphs = pageQuery.data?.page.paragraphs ?? [];
  const currentHtmlContent = pageQuery.data?.page.htmlContent ?? null;
  const currentParagraph = currentParagraphs.find((paragraph) => paragraph.paragraphNumber === currentParagraphNumber) ?? currentParagraphs[0] ?? null;
  const totalPages = pageQuery.data?.book.totalPages ?? 0;
  const hasOriginalPanelContent = Boolean(pageQuery.data?.page.hasSourceImage || pageQuery.data?.page.rawText);
  const isRichEpubPage = pageQuery.data?.book.sourceType === "EPUB" && Boolean(currentHtmlContent);
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

  useEffect(() => {
    if (typeof window === "undefined" || pageTurnDirection || !currentParagraph) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const paragraphElement = paragraphRefs.current.get(currentParagraph.paragraphNumber);
      if (!paragraphElement) {
        return;
      }

      const paragraphBounds = paragraphElement.getBoundingClientRect();
      const controlsElement = document.querySelector<HTMLElement>(".reader-floating-controls");
      const controlsHeight = controlsElement?.getBoundingClientRect().height ?? 0;
      const viewportTargetCenter = (window.innerHeight - controlsHeight - 24) / 2;
      const paragraphCenter = paragraphBounds.top + (paragraphBounds.height / 2);
      const nextScrollTop = window.scrollY + paragraphCenter - viewportTargetCenter;

      if (Math.abs(nextScrollTop - window.scrollY) < 4) {
        return;
      }

      window.scrollTo({
        behavior: "smooth",
        top: Math.max(0, nextScrollTop)
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [currentPageNumber, currentParagraph, pageTurnDirection]);

  const isPageTurningBackward = pageTurnDirection === "backward";
  const baseParagraphs = isPageTurningBackward && pageTurnSnapshot
    ? pageTurnSnapshot.paragraphs
    : currentParagraphs;
  const baseHtmlContent = isPageTurningBackward && pageTurnSnapshot
    ? pageTurnSnapshot.htmlContent
    : currentHtmlContent;
  const baseActiveParagraphNumber = isPageTurningBackward && pageTurnSnapshot
    ? pageTurnSnapshot.activeParagraphNumber
    : (currentParagraph?.paragraphNumber ?? null);
  const overlayParagraphs = isPageTurningBackward
    ? currentParagraphs
    : (pageTurnSnapshot?.paragraphs ?? []);
  const overlayHtmlContent = isPageTurningBackward
    ? currentHtmlContent
    : (pageTurnSnapshot?.htmlContent ?? null);
  const overlayActiveParagraphNumber = isPageTurningBackward
    ? (currentParagraph?.paragraphNumber ?? null)
    : (pageTurnSnapshot?.activeParagraphNumber ?? null);

  useEffect(() => {
    if (!isRichEpubPage || !richContentRef.current) {
      return;
    }

    paragraphRefs.current.clear();

    const paragraphNodes = richContentRef.current.querySelectorAll<HTMLElement>("[data-paragraph-number]");
    paragraphNodes.forEach((node) => {
      const paragraphNumber = Number.parseInt(node.dataset.paragraphNumber ?? "", 10);
      if (!Number.isInteger(paragraphNumber)) {
        return;
      }

      node.classList.toggle("active", paragraphNumber === currentParagraphNumber);
      paragraphRefs.current.set(paragraphNumber, node as HTMLParagraphElement);
    });
  }, [currentHtmlContent, currentPageNumber, currentParagraphNumber, isRichEpubPage]);

  useEffect(() => {
    if (!pendingPageTurnDirection || pageQuery.data?.page.pageNumber !== currentPageNumber) {
      return;
    }

    setPageTurnDirection(pendingPageTurnDirection);
    setPendingPageTurnDirection(null);

    if (pageTurnTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(pageTurnTimeoutRef.current);
    }

    if (typeof window === "undefined") {
      return;
    }

    pageTurnTimeoutRef.current = window.setTimeout(() => {
      setPageTurnDirection(null);
      setPageTurnSnapshot(null);
      pageTurnTimeoutRef.current = null;
    }, PAGE_TURN_DURATION_MS);
  }, [currentPageNumber, pageQuery.data?.page.pageNumber, pendingPageTurnDirection]);

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

  function matchesPrefetchedAudio(entry: PrefetchedParagraphAudio | null, paragraph: ParagraphContent, pageNumber: number, voiceModel: string) {
    return Boolean(
      entry
      && entry.pageNumber === pageNumber
      && entry.paragraphId === paragraph.paragraphId
      && entry.voiceModel === voiceModel
    );
  }

  function clearPrefetchedAudio() {
    prefetchedAudioRef.current?.controller?.abort();
    prefetchedAudioRef.current = null;
  }

  function clearAudioResource(options: { invalidatePlayback?: boolean } = {}) {
    if (options.invalidatePlayback ?? true) {
      playbackAttemptRef.current += 1;
    }

    activeAudioRequestRef.current?.abort();
    activeAudioRequestRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    setIsAudioPlaying(false);

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  async function resolveParagraphAudio(paragraph: ParagraphContent, pageNumber: number, voiceModel: string) {
    if (!accessToken) {
      throw new Error("Missing access token.");
    }

    const prefetchedAudio = prefetchedAudioRef.current;

    if (matchesPrefetchedAudio(prefetchedAudio, paragraph, pageNumber, voiceModel)) {
      prefetchedAudioRef.current = null;

      if (prefetchedAudio?.blob) {
        return prefetchedAudio.blob;
      }

      if (prefetchedAudio?.promise) {
        activeAudioRequestRef.current = prefetchedAudio.controller ?? null;

        try {
          return await prefetchedAudio.promise;
        } finally {
          if (activeAudioRequestRef.current === prefetchedAudio.controller) {
            activeAudioRequestRef.current = null;
          }
        }
      }
    }

    const controller = new AbortController();
    activeAudioRequestRef.current = controller;

    try {
      return await requestParagraphAudio(accessToken, bookId, paragraph.paragraphId, {
        signal: controller.signal,
        voiceModel
      });
    } finally {
      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }
    }
  }

  function prefetchParagraphAudio(paragraph: ParagraphContent, pageNumber: number, voiceModel: string) {
    if (!accessToken) {
      return;
    }

    const existingPrefetch = prefetchedAudioRef.current;
    if (matchesPrefetchedAudio(existingPrefetch, paragraph, pageNumber, voiceModel)) {
      return;
    }

    clearPrefetchedAudio();

    const controller = new AbortController();
    const nextPrefetch: PrefetchedParagraphAudio = {
      controller,
      pageNumber,
      paragraphId: paragraph.paragraphId,
      voiceModel
    };

    nextPrefetch.promise = requestParagraphAudio(accessToken, bookId, paragraph.paragraphId, {
      signal: controller.signal,
      voiceModel
    })
      .then((audioBlob) => {
        if (prefetchedAudioRef.current === nextPrefetch) {
          prefetchedAudioRef.current = {
            blob: audioBlob,
            pageNumber,
            paragraphId: paragraph.paragraphId,
            voiceModel
          };
        }

        return audioBlob;
      })
      .catch((error: unknown) => {
        if (prefetchedAudioRef.current === nextPrefetch) {
          prefetchedAudioRef.current = null;
        }

        if (!isAbortError(error)) {
          console.warn("No se pudo precargar el audio del siguiente párrafo.", error);
        }

        throw error;
      });

    prefetchedAudioRef.current = nextPrefetch;
    void nextPrefetch.promise.catch(() => undefined);
  }

  function prefetchNextParagraph(paragraph: ParagraphContent, pageNumber: number, voiceModel: string) {
    const paragraphIndex = currentParagraphs.findIndex((current) => current.paragraphId === paragraph.paragraphId);
    const nextParagraph = currentParagraphs[paragraphIndex + 1];

    if (!nextParagraph) {
      clearPrefetchedAudio();
      return;
    }

    prefetchParagraphAudio(nextParagraph, pageNumber, voiceModel);
  }

  function preparePageTurn(nextPageNumber: number) {
    if (nextPageNumber === currentPageNumber) {
      return;
    }

    if (pageTurnTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }

    setPageTurnDirection(null);
    setPendingPageTurnDirection(nextPageNumber > currentPageNumber ? "forward" : "backward");
    setPageTurnSnapshot({
      activeParagraphNumber: currentParagraph?.paragraphNumber ?? null,
      htmlContent: currentHtmlContent,
      pageNumber: currentPageNumber,
      paragraphs: currentParagraphs
    });
  }

  function findParagraphFromNode(target: EventTarget | null) {
    if (!(target instanceof Element)) {
      return null;
    }

    const paragraphElement = target.closest<HTMLElement>("[data-paragraph-number]");
    const paragraphNumber = Number.parseInt(paragraphElement?.dataset.paragraphNumber ?? "", 10);
    if (!Number.isInteger(paragraphNumber)) {
      return null;
    }

    return currentParagraphs.find((paragraph) => paragraph.paragraphNumber === paragraphNumber) ?? null;
  }

  function renderRichContent(htmlContent: string, interactive: boolean) {
    return (
      <article className="reader-prose reader-prose-rich">
        <div
          className="reader-rich-content"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
          onClick={interactive
            ? (event) => {
                const paragraph = findParagraphFromNode(event.target);
                if (paragraph) {
                  void selectParagraph(paragraph);
                }
              }
            : undefined}
          onKeyDown={interactive
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }

                const paragraph = findParagraphFromNode(event.target);
                if (!paragraph) {
                  return;
                }

                event.preventDefault();
                void selectParagraph(paragraph);
              }
            : undefined}
          ref={interactive ? richContentRef : undefined}
        />
      </article>
    );
  }

  function renderPageContent(paragraphs: ParagraphContent[], htmlContent: string | null, activeParagraphNumber: number | null, interactive: boolean) {
    if (htmlContent) {
      return renderRichContent(htmlContent, interactive);
    }

    return renderParagraphs(paragraphs, activeParagraphNumber, interactive);
  }

  function renderParagraphs(paragraphs: ParagraphContent[], activeParagraphNumber: number | null, interactive: boolean) {
    if (paragraphs.length === 0) {
      return null;
    }

    return (
      <article className="reader-prose">
        {paragraphs.map((paragraph) => {
          const isActive = paragraph.paragraphNumber === activeParagraphNumber;

          return (
            <p
              className={isActive ? "reader-paragraph active" : "reader-paragraph"}
              key={paragraph.paragraphId}
              ref={interactive
                ? (element) => {
                    if (element) {
                      paragraphRefs.current.set(paragraph.paragraphNumber, element);
                      return;
                    }

                    paragraphRefs.current.delete(paragraph.paragraphNumber);
                  }
                : undefined}
              onClick={interactive ? () => void selectParagraph(paragraph) : undefined}
              onKeyDown={interactive
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void selectParagraph(paragraph);
                    }
                  }
                : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
            >
              {paragraph.paragraphText}
            </p>
          );
        })}
      </article>
    );
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
      preparePageTurn(pageNumber + 1);
      setCurrentPageNumber(pageNumber + 1);
      return;
    }

    setAutoPlay(false);
    setIsAudioPlaying(false);
  }

  async function playParagraph(paragraph: ParagraphContent, pageNumber: number, keepAutoPlay: boolean) {
    if (!accessToken) {
      return;
    }

    const playbackAttempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = playbackAttempt;

    setReaderError(null);
    setIsAudioLoading(true);

    try {
      clearAudioResource({ invalidatePlayback: false });
      const audioBlob = await resolveParagraphAudio(paragraph, pageNumber, selectedVoiceModel);
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      audioUrlRef.current = audioUrl;

      const audioElement = new Audio(audioUrl);
      audioRef.current = audioElement;
      audioElement.playbackRate = playbackRate;
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

      if (keepAutoPlay) {
        prefetchNextParagraph(paragraph, pageNumber, selectedVoiceModel);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setAutoPlay(false);
      setReaderError(error instanceof Error ? error.message : "No se pudo reproducir el párrafo seleccionado.");
    } finally {
      if (playbackAttempt === playbackAttemptRef.current) {
        setIsAudioLoading(false);
      }
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

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }

    const mediaSession = navigator.mediaSession;
    const artwork = [
      {
        sizes: "192x192",
        src: `${import.meta.env.BASE_URL}pwa-192x192.png`,
        type: "image/png"
      },
      {
        sizes: "512x512",
        src: `${import.meta.env.BASE_URL}pwa-512x512.png`,
        type: "image/png"
      }
    ];

    if (typeof MediaMetadata !== "undefined" && currentParagraph) {
      mediaSession.metadata = new MediaMetadata({
        album: pageQuery.data?.book.title ?? "Lector de libros",
        artist: "El conejo lector",
        artwork,
        title: currentParagraph.paragraphText.slice(0, 96)
      });
    }

    setMediaSessionPlaybackState(isAudioPlaying ? "playing" : "paused");
  }, [currentParagraph, isAudioPlaying, pageQuery.data?.book.title]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }

    const mediaSession = navigator.mediaSession;
    const safeSetActionHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Algunos navegadores exponen mediaSession sin soportar todas las acciones.
      }
    };

    safeSetActionHandler("play", () => {
      void handlePlay();
    });
    safeSetActionHandler("pause", () => {
      handlePause();
    });
    safeSetActionHandler("previoustrack", () => {
      void goToParagraph(-1);
    });
    safeSetActionHandler("nexttrack", () => {
      void goToParagraph(1);
    });

    return () => {
      safeSetActionHandler("play", null);
      safeSetActionHandler("pause", null);
      safeSetActionHandler("previoustrack", null);
      safeSetActionHandler("nexttrack", null);
    };
  });

  async function selectParagraph(paragraph: ParagraphContent) {
    setCurrentParagraphNumber(paragraph.paragraphNumber);
    clearAudioResource();
    clearPrefetchedAudio();
    await persistProgress(paragraph, currentPageNumber);
  }

  async function goToPage(nextPageNumber: number) {
    const boundedPageNumber = totalPages > 0
      ? Math.min(Math.max(nextPageNumber, 1), totalPages)
      : nextPageNumber;

    if (!Number.isInteger(boundedPageNumber) || boundedPageNumber < 1 || boundedPageNumber === currentPageNumber) {
      return;
    }

    clearAudioResource();
    clearPrefetchedAudio();
    setAutoPlay(false);
    setIsPageJumpActive(false);
    preparePageTurn(boundedPageNumber);
    setCurrentPageNumber(boundedPageNumber);
    setCurrentParagraphNumber(1);
  }

  function parsePageJumpValue() {
    if (totalPages <= 0) {
      return null;
    }

    const parsedValue = Number.parseInt(pageJumpValue.trim(), 10);
    if (!Number.isInteger(parsedValue)) {
      return null;
    }

    return Math.min(Math.max(parsedValue, 1), totalPages);
  }

  function cancelPageJump() {
    setIsPageJumpActive(false);
    setPageJumpValue(String(currentPageNumber));
  }

  async function handlePageJumpSubmit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const nextPageNumber = parsePageJumpValue();
    if (nextPageNumber === null) {
      cancelPageJump();
      return;
    }

    await goToPage(nextPageNumber);
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
    clearPrefetchedAudio();
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
    clearPrefetchedAudio();
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
    <div className="page-grid reader-layout reader-floating-layout reader-full-bleed-layout">
      <section className="panel wide-panel reader-full-bleed-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Lectura</p>
            <h2>{pageQuery.data?.book.title ?? "Cargando libro..."}</h2>
          </div>
          <div className="reader-header-actions">
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <Link aria-label="Añadir páginas" className="secondary-button link-button reader-header-icon-button" title="Añadir páginas" to={appendPagesLink}>
                <AddPagesIcon />
              </Link>
            ) : null}
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <button
                aria-label={isDeletingPage ? "Borrando página" : "Borrar página"}
                className="danger-button reader-header-icon-button"
                disabled={isDeletingPage}
                onClick={() => void handleDeleteCurrentPage()}
                title={isDeletingPage ? "Borrando página..." : "Borrar página"}
                type="button"
              >
                <DeletePageIcon />
              </button>
            ) : null}
            <Link aria-label="Volver a la estantería" className="secondary-button link-button reader-header-icon-button" title="Volver a la estantería" to="/">
              <ShelfIcon />
            </Link>
            {hasOriginalPanelContent ? (
              <button
                aria-expanded={isSourcePanelVisible}
                aria-label={isSourcePanelVisible ? "Ocultar página original" : "Mostrar página original"}
                className="secondary-button reader-header-icon-button"
                onClick={() => setIsSourcePanelVisible((current) => !current)}
                title={isSourcePanelVisible ? "Ocultar página original" : "Página original"}
                type="button"
              >
                <OriginalPageIcon />
              </button>
            ) : null}
          </div>
        </div>

        <div className="reader-canvas">
          <div className={isSourcePanelVisible ? "reader-split reader-split-expanded" : "reader-split"}>
            <div className={pageTurnDirection ? `reader-page-turn reader-page-turn-${pageTurnDirection}` : "reader-page-turn"}>
              <div className={pageTurnDirection === "forward" ? "reader-page reader-page-live reader-page-live-animating" : "reader-page reader-page-live"}>
                {pageQuery.isLoading ? <p className="reader-copy subdued">Cargando página...</p> : null}
                {pageQuery.isError ? <p className="error-text">No se pudo cargar el contenido del libro.</p> : null}
                {readerError ? <p className="error-text">{readerError}</p> : null}
                {renderPageContent(baseParagraphs, baseHtmlContent, baseActiveParagraphNumber, !pageTurnDirection)}
              </div>

              {pageTurnSnapshot && overlayParagraphs.length > 0 ? (
                <div
                  aria-hidden="true"
                  className={pageTurnDirection
                    ? `reader-page reader-page-overlay reader-page-overlay-${pageTurnDirection}`
                    : "reader-page reader-page-overlay"}
                >
                  {renderPageContent(overlayParagraphs, overlayHtmlContent, overlayActiveParagraphNumber, false)}
                </div>
              ) : null}
            </div>

            {isSourcePanelVisible ? (
              <aside className="reader-source-panel">
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">Página original</p>
                  </div>
                </div>

                {pageImageUrl ? (
                  <img alt={`Página ${currentPageNumber} del libro`} className="preview-image" src={pageImageUrl} />
                ) : (
                  <div className="empty-state compact-state">
                    <p>Esta página no tiene imagen original adjunta.</p>
                  </div>
                )}

                <Link
                  className="secondary-button link-button"
                  to={`/builder?reviewBookId=${encodeURIComponent(bookId)}&reviewPage=${encodeURIComponent(String(currentPageNumber))}#review-ocr`}
                >
                  Editar OCR de esta página
                </Link>
              </aside>
            ) : null}
          </div>
        </div>
      </section>

      <div aria-label="Controles flotantes del lector" className="reader-floating-controls" role="toolbar">
        <div className="reader-floating-audio-menu" ref={audioSettingsRef}>
          <button
            aria-controls="reader-audio-settings-panel"
            aria-expanded={isAudioSettingsVisible}
            aria-label="Opciones de audio"
            className={isAudioSettingsVisible ? "reader-float-button active" : "reader-float-button"}
            onClick={() => setIsAudioSettingsVisible((current) => !current)}
            title="Opciones de audio"
            type="button"
          >
            <AudioSettingsIcon />
          </button>

          {isAudioSettingsVisible ? (
            <section aria-label="Opciones de audio" className="reader-floating-audio-panel" id="reader-audio-settings-panel">
              <label className="reader-audio-field">
                <span>Voz</span>
                <select onChange={(event) => setSelectedVoiceModel(event.target.value)} value={selectedVoiceModel}>
                  {TTS_VOICE_OPTIONS.map((voice) => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label} · {voice.description}
                    </option>
                  ))}
                </select>
              </label>

              <label className="reader-audio-field reader-audio-field-range">
                <span>
                  Velocidad
                  <strong className="reader-audio-inline-value">{playbackRate.toFixed(2)}x</strong>
                </span>
                <input
                  max={MAX_PLAYBACK_RATE}
                  min={MIN_PLAYBACK_RATE}
                  onChange={(event) => setPlaybackRate(Number(event.target.value))}
                  step={PLAYBACK_RATE_STEP}
                  type="range"
                  value={playbackRate}
                />
              </label>
            </section>
          ) : null}
        </div>
        <div aria-live="polite" className="reader-floating-status">
          <form className="reader-page-jump-form" onSubmit={(event) => void handlePageJumpSubmit(event)}>
            <label className="reader-page-jump-label">
              <input
                aria-label="Página actual"
                className="reader-page-jump-input"
                inputMode="numeric"
                max={totalPages || undefined}
                min={1}
                onBlur={() => {
                  void handlePageJumpSubmit();
                }}
                onChange={(event) => setPageJumpValue(event.target.value.replace(/[^\d]/gu, ""))}
                onFocus={() => setIsPageJumpActive(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelPageJump();
                  }
                }}
                onPointerDown={() => setIsPageJumpActive(true)}
                ref={pageJumpInputRef}
                size={Math.max(String(totalPages || currentPageNumber).length, 2)}
                type="text"
                value={isPageJumpActive ? pageJumpValue : String(currentPageNumber)}
              />
              <strong>/ {totalPages}</strong>
            </label>
          </form>
          <span>{readingPercentage.toFixed(1)}%</span>
        </div>
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