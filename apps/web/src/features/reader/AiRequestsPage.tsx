import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  createNote,
  createAiRequest,
  deleteBookmark,
  deleteHighlight,
  deleteAiRequest,
  deleteNote,
  fetchBook,
  fetchDeepgramBalance,
  fetchReaderNavigation,
  fetchAiRequests,
  isRetryableRateLimitError,
  requestAiResponseAudio,
  updateNote,
  type HighlightColor,
  type AiRequestRecord,
  type ReaderHighlight,
  type ReaderNote,
  type ReaderTocEntry
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { ReaderAudioSettingsContent, ReaderFloatingAudioPopover, ReaderNavigationPanelContent, ReaderNavigationPopover, type ReaderNavigationListItem } from "./ReaderFloatingPanels";

const DEFAULT_VOICE_MODEL = "aura-2-diana-es";
const READER_VOICE_STORAGE_KEY = "lector.reader.voiceModel";
const READER_TTS_ENGINE_STORAGE_KEY = "lector.reader.ttsEngine";
const READER_DEVICE_VOICE_STORAGE_KEY = "lector.reader.deviceVoiceUri";
const READER_SPEED_STORAGE_KEY = "lector.reader.playbackRate";
const DEFAULT_TTS_ENGINE = "deepgram";
const DEFAULT_DEVICE_VOICE_URI = "";
const DEFAULT_PLAYBACK_RATE = 1.1;
const MIN_PLAYBACK_RATE = 0.8;
const MAX_PLAYBACK_RATE = 1.35;
const PLAYBACK_RATE_STEP = 0.05;
const READER_NAVIGATION_PANEL_ANIMATION_MS = 220;
const USD_BALANCE_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency"
});

const TTS_ENGINE_OPTIONS: Array<{ description: string; label: string; value: "deepgram" | "device" }> = [
  { description: "Voz en la nube", label: "Deepgram", value: "deepgram" },
  { description: "Voz local del navegador", label: "Dispositivo", value: "device" }
];

const TTS_VOICE_OPTIONS = [
  { description: "Español peninsular natural", label: "Diana", value: "aura-2-diana-es" },
  { description: "Español peninsular natural", label: "Néstor", value: "aura-2-nestor-es" },
  { description: "Español peninsular natural", label: "Carina", value: "aura-2-carina-es" },
  { description: "Español peninsular natural", label: "Álvaro", value: "aura-2-alvaro-es" },
  { description: "Español peninsular natural", label: "Agustina", value: "aura-2-agustina-es" },
  { description: "Español peninsular natural", label: "Silvia", value: "aura-2-silvia-es" }
] as const;

type TtsEngine = "deepgram" | "device";

type DeviceVoiceOption = {
  description: string;
  label: string;
  value: string;
};

function excerptPreview(value: string | null | undefined, fallback: string) {
  const normalizedValue = value?.replace(/\s+/gu, " ").trim();
  if (!normalizedValue) {
    return fallback;
  }

  return normalizedValue.length > 120 ? `${normalizedValue.slice(0, 117).trimEnd()}...` : normalizedValue;
}

function tocEntryKey(entry: ReaderTocEntry) {
  return entry.chapterId ?? `${entry.pageNumber}:${entry.paragraphNumber}:${entry.sequenceNumber ?? "na"}:${entry.title}`;
}

function notePreview(note: Pick<ReaderNote, "highlightedText" | "noteText">) {
  return excerptPreview(note.highlightedText ?? note.noteText, "Nota sin extracto");
}

function highlightPreview(highlight: Pick<ReaderHighlight, "highlightedText">) {
  return excerptPreview(highlight.highlightedText, "Resaltado sin texto");
}

function readStoredTtsEngine(): TtsEngine {
  if (typeof window === "undefined") {
    return DEFAULT_TTS_ENGINE;
  }

  const storedEngine = window.localStorage.getItem(READER_TTS_ENGINE_STORAGE_KEY);
  return storedEngine === "device" || storedEngine === "deepgram"
    ? storedEngine
    : DEFAULT_TTS_ENGINE;
}

function readStoredDeviceVoiceUri() {
  if (typeof window === "undefined") {
    return DEFAULT_DEVICE_VOICE_URI;
  }

  return window.localStorage.getItem(READER_DEVICE_VOICE_STORAGE_KEY) ?? DEFAULT_DEVICE_VOICE_URI;
}

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

function formatUsdBalance(amount: number) {
  return USD_BALANCE_FORMATTER.format(amount);
}

function getSpeechSynthesisApi() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null;
  }

  return window.speechSynthesis;
}

function isPeninsularSpanishVoice(voice: SpeechSynthesisVoice) {
  const normalizedLanguage = voice.lang.trim().toLowerCase();
  return normalizedLanguage === "es-es" || normalizedLanguage.startsWith("es-es-");
}

function buildDeviceVoiceOptions(voices: SpeechSynthesisVoice[]): DeviceVoiceOption[] {
  const uniqueVoices = new Map<string, DeviceVoiceOption>();

  for (const voice of voices) {
    if (!voice.voiceURI || uniqueVoices.has(voice.voiceURI) || !isPeninsularSpanishVoice(voice)) {
      continue;
    }

    const language = voice.lang.trim() || "Sin idioma";
    const descriptionParts = [language];
    if (voice.default) {
      descriptionParts.push("predeterminada");
    }
    if (voice.localService) {
      descriptionParts.push("local");
    }

    uniqueVoices.set(voice.voiceURI, {
      description: descriptionParts.join(" · "),
      label: voice.name,
      value: voice.voiceURI
    });
  }

  return [
    {
      description: "Usa la voz predeterminada del dispositivo",
      label: "Predeterminada",
      value: DEFAULT_DEVICE_VOICE_URI
    },
    ...Array.from(uniqueVoices.values()).sort((left, right) => left.label.localeCompare(right.label, "es"))
  ];
}

function findDeviceVoice(voices: SpeechSynthesisVoice[], voiceUri: string) {
  if (!voiceUri) {
    return null;
  }

  return voices.find((voice) => voice.voiceURI === voiceUri && isPeninsularSpanishVoice(voice)) ?? null;
}

function pickFallbackDeviceVoice(voices: SpeechSynthesisVoice[]) {
  return voices.find((voice) => isPeninsularSpanishVoice(voice)) ?? null;
}

function RequestIcon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function BackIcon() {
  return (
    <RequestIcon>
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </RequestIcon>
  );
}

function ForwardIcon() {
  return (
    <RequestIcon>
      <path d="M5 12H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L17 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </RequestIcon>
  );
}

function PlayIcon() {
  return (
    <RequestIcon>
      <path d="M9 7.5V16.5L16.5 12L9 7.5Z" fill="currentColor" />
    </RequestIcon>
  );
}

function PauseIcon() {
  return (
    <RequestIcon>
      <path d="M9 7H10.8V17H9V7Z" fill="currentColor" />
      <path d="M13.2 7H15V17H13.2V7Z" fill="currentColor" />
    </RequestIcon>
  );
}

function DeleteIcon() {
  return (
    <RequestIcon>
      <path d="M6.5 7.5H17.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10 10.5V16.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M14 10.5V16.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8 7.5L8.6 19H15.4L16 7.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10 7.5V5.5H14V7.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </RequestIcon>
  );
}

function LoadingAudioIcon() {
  return (
    <span aria-hidden="true" className="reader-loading-bars">
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
    </span>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Fecha no disponible";
  }

  return date.toLocaleString("es-ES", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function paragraphize(value: string) {
  return value
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function AiRequestsPage() {
  const { bookId = "", chapterId } = useParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const activeAudioRequestRef = useRef<AbortController | null>(null);
  const deviceUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelCloseTimeoutRef = useRef<number | null>(null);
  const activeNavigationItemRef = useRef<HTMLButtonElement | null>(null);
  const [promptText, setPromptText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
  const [loadingAudioRequestId, setLoadingAudioRequestId] = useState<string | null>(null);
  const [playingRequestId, setPlayingRequestId] = useState<string | null>(null);
  const [hasActivePlaybackSession, setHasActivePlaybackSession] = useState(false);
  const [isAudioSettingsVisible, setIsAudioSettingsVisible] = useState(false);
  const [isNavigationPanelRendered, setIsNavigationPanelRendered] = useState(false);
  const [isNavigationPanelVisible, setIsNavigationPanelVisible] = useState(false);
  const [expandedNavigationNoteId, setExpandedNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteId, setEditingNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteColor, setEditingNavigationNoteColor] = useState<HighlightColor | null>(null);
  const [editingNavigationNoteText, setEditingNavigationNoteText] = useState("");
  const [editingNavigationHighlightId, setEditingNavigationHighlightId] = useState<string | null>(null);
  const [editingNavigationHighlightText, setEditingNavigationHighlightText] = useState("");
  const [isUpdatingNote, setIsUpdatingNote] = useState(false);
  const [selectedTtsEngine, setSelectedTtsEngine] = useState<TtsEngine>(readStoredTtsEngine);
  const [selectedVoiceModel, setSelectedVoiceModel] = useState<string>(readStoredVoiceModel);
  const [selectedDeviceVoiceUri, setSelectedDeviceVoiceUri] = useState<string>(readStoredDeviceVoiceUri);
  const [playbackRate, setPlaybackRate] = useState<number>(readStoredPlaybackRate);
  const [availableDeviceVoices, setAvailableDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isDevicePaused, setIsDevicePaused] = useState(false);

  const requestsQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["ai-requests", bookId, chapterId ?? "book"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchAiRequests(accessToken, bookId, chapterId);
    }
  });

  const navigationQuery = useQuery({
    enabled: Boolean(accessToken && bookId && chapterId),
    queryKey: ["reader-navigation", bookId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchReaderNavigation(accessToken, bookId);
    }
  });

  const bookQuery = useQuery({
    enabled: Boolean(accessToken && bookId && chapterId),
    queryKey: ["book", bookId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchBook(accessToken, bookId);
    }
  });

  const deepgramBalanceQuery = useQuery({
    enabled: Boolean(accessToken && isAudioSettingsVisible && selectedTtsEngine === "deepgram"),
    queryKey: ["deepgram-balance"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchDeepgramBalance(accessToken);
    },
    staleTime: 60_000
  });

  useEffect(() => {
    if (requestsQuery.data?.prompt && !promptText) {
      setPromptText(requestsQuery.data.prompt);
    }
  }, [promptText, requestsQuery.data?.prompt]);

  useEffect(() => {
    if (retryAfterSeconds <= 0 || typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRetryAfterSeconds((current) => Math.max(0, current - 1));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [retryAfterSeconds]);

  useEffect(() => {
    const audioElement = new Audio();

    const handlePlay = () => {
      setLoadingAudioRequestId(null);
      setHasActivePlaybackSession(true);
      setIsDevicePaused(false);
      setAudioError(null);
    };
    const handlePause = () => {
      setPlayingRequestId(null);
    };
    const handleEnded = () => {
      setPlayingRequestId(null);
      setHasActivePlaybackSession(false);
    };
    const handleError = () => {
      setLoadingAudioRequestId(null);
      setPlayingRequestId(null);
      setHasActivePlaybackSession(false);
      setAudioError("No se pudo reproducir el audio de la respuesta.");
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("ended", handleEnded);
    audioElement.addEventListener("error", handleError);
    audioRef.current = audioElement;

    return () => {
      activeAudioRequestRef.current?.abort();
      getSpeechSynthesisApi()?.cancel();
      deviceUtteranceRef.current = null;
      audioElement.pause();
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
      audioElement.removeEventListener("ended", handleEnded);
      audioElement.removeEventListener("error", handleError);
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      if (navigationPanelCloseTimeoutRef.current !== null) {
        window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const speechSynthesisApi = getSpeechSynthesisApi();
    if (!speechSynthesisApi) {
      setAvailableDeviceVoices([]);
      return;
    }

    let isMounted = true;
    let firstRefreshTimeoutId: number | null = null;
    let secondRefreshTimeoutId: number | null = null;

    const refreshVoices = () => {
      if (!isMounted) {
        return;
      }

      setAvailableDeviceVoices(speechSynthesisApi.getVoices());
    };

    refreshVoices();
    speechSynthesisApi.addEventListener("voiceschanged", refreshVoices);

    if (typeof window !== "undefined") {
      firstRefreshTimeoutId = window.setTimeout(refreshVoices, 250);
      secondRefreshTimeoutId = window.setTimeout(refreshVoices, 1000);
    }

    return () => {
      isMounted = false;
      speechSynthesisApi.removeEventListener("voiceschanged", refreshVoices);

      if (typeof window !== "undefined") {
        if (firstRefreshTimeoutId !== null) {
          window.clearTimeout(firstRefreshTimeoutId);
        }
        if (secondRefreshTimeoutId !== null) {
          window.clearTimeout(secondRefreshTimeoutId);
        }
      }
    };
  }, []);

  const isDeviceTtsSupported = Boolean(getSpeechSynthesisApi());
  const deviceVoiceOptions = useMemo(() => buildDeviceVoiceOptions(availableDeviceVoices), [availableDeviceVoices]);
  const selectedDeviceVoice = useMemo(
    () => findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri),
    [availableDeviceVoices, selectedDeviceVoiceUri]
  );

  useEffect(() => {
    if (!isDeviceTtsSupported && selectedTtsEngine === "device") {
      setSelectedTtsEngine("deepgram");
    }
  }, [isDeviceTtsSupported, selectedTtsEngine]);

  useEffect(() => {
    if (selectedDeviceVoiceUri && !findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri)) {
      setSelectedDeviceVoiceUri(DEFAULT_DEVICE_VOICE_URI);
    }
  }, [availableDeviceVoices, selectedDeviceVoiceUri]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(READER_TTS_ENGINE_STORAGE_KEY, selectedTtsEngine);
  }, [selectedTtsEngine]);

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

    window.localStorage.setItem(READER_DEVICE_VOICE_STORAGE_KEY, selectedDeviceVoiceUri);
  }, [selectedDeviceVoiceUri]);

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
    activeAudioRequestRef.current?.abort();
    setLoadingAudioRequestId(null);
    setPlayingRequestId(null);
    setHasActivePlaybackSession(false);
    setIsDevicePaused(false);
    getSpeechSynthesisApi()?.cancel();
    deviceUtteranceRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, [chapterId, selectedDeviceVoiceUri, selectedTtsEngine, selectedVoiceModel]);

  useEffect(() => {
    if (navigationPanelCloseTimeoutRef.current !== null) {
      window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      navigationPanelCloseTimeoutRef.current = null;
    }

    setIsNavigationPanelRendered(false);
    setIsNavigationPanelVisible(false);
    setExpandedNavigationNoteId(null);
    setEditingNavigationNoteId(null);
    setEditingNavigationNoteColor(null);
    setEditingNavigationNoteText("");
    setEditingNavigationHighlightId(null);
    setEditingNavigationHighlightText("");
    setNavigationError(null);
  }, [chapterId]);

  useEffect(() => {
    if ((!isAudioSettingsVisible && !isNavigationPanelVisible) || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const targetNode = event.target as Node;

      if (isAudioSettingsVisible && !audioSettingsRef.current?.contains(targetNode)) {
        setIsAudioSettingsVisible(false);
      }

      if (isNavigationPanelVisible && !navigationPanelRef.current?.contains(targetNode)) {
        setIsNavigationPanelVisible(false);

        if (navigationPanelCloseTimeoutRef.current !== null) {
          window.clearTimeout(navigationPanelCloseTimeoutRef.current);
        }

        navigationPanelCloseTimeoutRef.current = window.setTimeout(() => {
          setIsNavigationPanelRendered(false);
          navigationPanelCloseTimeoutRef.current = null;
        }, READER_NAVIGATION_PANEL_ANIMATION_MS);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isAudioSettingsVisible, isNavigationPanelVisible]);

  const contextTitle = requestsQuery.data?.section?.title ?? requestsQuery.data?.book.title ?? "Peticiones IA";
  const isSectionScope = Boolean(chapterId);
  const backToReaderPath = requestsQuery.data?.section
    ? `/books/${bookId}?page=${requestsQuery.data.section.startPageNumber}`
    : `/books/${bookId}`;
  const requests = requestsQuery.data?.requests ?? [];
  const bookTitle = bookQuery.data?.book.title ?? requestsQuery.data?.book.title ?? "Cargando libro...";
  const deepgramBalanceErrorMessage = deepgramBalanceQuery.error instanceof Error
    ? deepgramBalanceQuery.error.message
    : "No se pudo consultar el saldo de Deepgram.";

  const groupedRequests = useMemo(
    () => requests.map((request) => ({
      ...request,
      responseParagraphs: paragraphize(request.responseText)
    })),
    [requests]
  );
  const latestRequest = groupedRequests[0] ?? null;
  const orderedNavigationItems = useMemo<ReaderNavigationListItem[]>(() => {
    const tocItems: ReaderNavigationListItem[] = (navigationQuery.data?.toc ?? []).map((entry) => ({
      chapterId: entry.chapterId ?? null,
      isActive: entry.chapterId === chapterId,
      key: `toc:${tocEntryKey(entry)}`,
      level: entry.level,
      pageNumber: entry.pageNumber,
      paragraphNumber: entry.paragraphNumber,
      title: entry.title,
      type: "toc"
    }));

    const bookmarkItems: ReaderNavigationListItem[] = (navigationQuery.data?.bookmarks ?? []).map((bookmark) => ({
      bookmarkId: bookmark.bookmarkId,
      isActive: false,
      key: `bookmark:${bookmark.bookmarkId}`,
      pageNumber: bookmark.pageNumber,
      paragraphNumber: bookmark.paragraphNumber,
      title: "Marcador guardado",
      type: "bookmark"
    }));

    const noteItems: ReaderNavigationListItem[] = (navigationQuery.data?.notes ?? []).map((note) => ({
      color: note.highlightColor,
      excerpt: notePreview(note),
      isActive: false,
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      noteText: note.noteText,
      pageNumber: note.pageNumber,
      paragraphNumber: note.paragraphNumber ?? 1,
      type: "note"
    }));

    const notedHighlightIds = new Set(
      (navigationQuery.data?.notes ?? [])
        .map((note) => note.highlightId)
        .filter((highlightId): highlightId is string => Boolean(highlightId))
    );

    const standaloneHighlightItems: ReaderNavigationListItem[] = (navigationQuery.data?.highlights ?? [])
      .filter((highlight) => !notedHighlightIds.has(highlight.highlightId))
      .map((highlight) => ({
        color: highlight.color,
        excerpt: highlightPreview(highlight),
        highlightId: highlight.highlightId,
        isActive: false,
        key: `highlight:${highlight.highlightId}`,
        pageNumber: highlight.pageNumber,
        paragraphNumber: highlight.paragraphNumber,
        type: "highlight"
      }));

    const sortWeight = { bookmark: 1, highlight: 2, note: 3, toc: 0 } as const;

    return [...tocItems, ...bookmarkItems, ...standaloneHighlightItems, ...noteItems].sort((left, right) => {
      if (left.pageNumber !== right.pageNumber) {
        return left.pageNumber - right.pageNumber;
      }

      if (left.paragraphNumber !== right.paragraphNumber) {
        return left.paragraphNumber - right.paragraphNumber;
      }

      return sortWeight[left.type] - sortWeight[right.type];
    });
  }, [chapterId, navigationQuery.data?.bookmarks, navigationQuery.data?.highlights, navigationQuery.data?.notes, navigationQuery.data?.toc]);
  const sectionEntries = useMemo(
    () => (navigationQuery.data?.toc ?? []).flatMap((entry) => entry.chapterId ? [{ ...entry, chapterId: entry.chapterId }] : []),
    [navigationQuery.data?.toc]
  );
  const currentSectionIndex = useMemo(
    () => sectionEntries.findIndex((entry) => entry.chapterId === chapterId),
    [chapterId, sectionEntries]
  );
  const currentSectionCounter = currentSectionIndex >= 0 && sectionEntries.length > 0
    ? `${currentSectionIndex + 1}/${sectionEntries.length}`
    : null;
  const previousSection = currentSectionIndex > 0 ? sectionEntries[currentSectionIndex - 1] ?? null : null;
  const nextSection = currentSectionIndex >= 0 ? sectionEntries[currentSectionIndex + 1] ?? null : null;

  function sectionAiRequestsHref(targetChapterId: string) {
    return `/books/${bookId}/sections/${encodeURIComponent(targetChapterId)}/ai-requests`;
  }

  function openNavigationPanel() {
    if (navigationPanelCloseTimeoutRef.current !== null) {
      window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      navigationPanelCloseTimeoutRef.current = null;
    }

    setIsNavigationPanelRendered(true);
    setIsNavigationPanelVisible(true);
  }

  function closeNavigationPanel() {
    setIsNavigationPanelVisible(false);

    if (navigationPanelCloseTimeoutRef.current !== null) {
      window.clearTimeout(navigationPanelCloseTimeoutRef.current);
    }

    navigationPanelCloseTimeoutRef.current = window.setTimeout(() => {
      setIsNavigationPanelRendered(false);
      navigationPanelCloseTimeoutRef.current = null;
    }, READER_NAVIGATION_PANEL_ANIMATION_MS);
  }

  function toggleNavigationPanel() {
    if (isNavigationPanelVisible) {
      closeNavigationPanel();
      return;
    }

    openNavigationPanel();
  }

  async function refreshNavigationMetadata() {
    await navigationQuery.refetch();
  }

  function goToReaderLocation(pageNumber: number) {
    closeNavigationPanel();
    navigate(`/books/${bookId}?page=${encodeURIComponent(String(pageNumber))}`);
  }

  function beginNavigationNoteEditing(note: { color: HighlightColor | null; noteId: string; noteText: string }) {
    setExpandedNavigationNoteId(note.noteId);
    setEditingNavigationHighlightId(null);
    setEditingNavigationHighlightText("");
    setEditingNavigationNoteId(note.noteId);
    setEditingNavigationNoteColor(note.color);
    setEditingNavigationNoteText(note.noteText);
  }

  function beginNavigationHighlightEditing(highlightId: string) {
    setExpandedNavigationNoteId(null);
    setEditingNavigationNoteId(null);
    setEditingNavigationNoteColor(null);
    setEditingNavigationNoteText("");
    setEditingNavigationHighlightId(highlightId);
    setEditingNavigationHighlightText("");
  }

  async function handleDeleteSavedBookmark(bookmarkId: string) {
    if (!accessToken) {
      return;
    }

    try {
      await deleteBookmark(accessToken, bookId, bookmarkId);
      await refreshNavigationMetadata();
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "No se pudo borrar el marcador.");
    }
  }

  async function handleDeleteSavedHighlight(highlightId: string) {
    if (!accessToken) {
      return;
    }

    try {
      await deleteHighlight(accessToken, bookId, highlightId);
      setEditingNavigationHighlightId((current) => current === highlightId ? null : current);
      await refreshNavigationMetadata();
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "No se pudo borrar el resaltado.");
    }
  }

  async function handleDeleteSavedNote(noteId: string) {
    if (!accessToken) {
      return;
    }

    try {
      await deleteNote(accessToken, bookId, noteId);
      setExpandedNavigationNoteId((current) => current === noteId ? null : current);
      setEditingNavigationNoteId((current) => current === noteId ? null : current);
      if (editingNavigationNoteId === noteId) {
        setEditingNavigationNoteColor(null);
      }
      await refreshNavigationMetadata();
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "No se pudo borrar la nota.");
    }
  }

  async function handleCreateNoteForHighlight(highlightId: string, noteText: string) {
    if (!accessToken || !noteText.trim()) {
      return;
    }

    setIsUpdatingNote(true);
    setNavigationError(null);

    try {
      const trimmedNoteText = noteText.trim();
      await createNote(accessToken, bookId, {
        highlightId,
        noteText: trimmedNoteText
      });
      await refreshNavigationMetadata();
      setEditingNavigationHighlightId(null);
      setEditingNavigationHighlightText("");
      setExpandedNavigationNoteId(null);
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "No se pudo guardar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
  }

  async function handleUpdateExistingNote(noteId: string, noteText: string, highlightColor?: HighlightColor) {
    if (!accessToken || !noteText.trim()) {
      return;
    }

    setIsUpdatingNote(true);
    setNavigationError(null);

    try {
      const trimmedNoteText = noteText.trim();
      await updateNote(accessToken, bookId, noteId, {
        ...(highlightColor ? { highlightColor } : {}),
        noteText: trimmedNoteText
      });
      await refreshNavigationMetadata();
      setEditingNavigationNoteId(null);
      setEditingNavigationNoteColor(null);
      setEditingNavigationNoteText("");
      setExpandedNavigationNoteId(null);
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "No se pudo actualizar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
  }

  async function handleCreateRequest() {
    if (!accessToken || !promptText.trim() || retryAfterSeconds > 0) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await createAiRequest(accessToken, bookId, {
        ...(chapterId ? { chapterId } : {}),
        promptText: promptText.trim()
      });
      await queryClient.invalidateQueries({ queryKey: ["ai-requests", bookId, chapterId ?? "book"] });
    } catch (error) {
      if (isRetryableRateLimitError(error)) {
        setRetryAfterSeconds(error.retryAfterSeconds);
        setSubmitError(`GitHub Models está limitando temporalmente las peticiones. Espera ${error.retryAfterSeconds} segundos antes de volver a intentarlo.`);
      } else {
        setSubmitError(error instanceof Error ? error.message : "No se pudo crear la petición IA.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteRequest(request: AiRequestRecord) {
    if (!accessToken || deletingRequestId) {
      return;
    }

    setDeletingRequestId(request.requestId);
    setDeleteError(null);

    try {
      if (playingRequestId === request.requestId || loadingAudioRequestId === request.requestId) {
        audioRef.current?.pause();
        activeAudioRequestRef.current?.abort();
        getSpeechSynthesisApi()?.cancel();
        deviceUtteranceRef.current = null;
        setPlayingRequestId(null);
        setLoadingAudioRequestId(null);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
      }

      await deleteAiRequest(accessToken, bookId, request.requestId);
      await queryClient.invalidateQueries({ queryKey: ["ai-requests", bookId, chapterId ?? "book"] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "No se pudo borrar la petición IA.");
    } finally {
      setDeletingRequestId(null);
    }
  }

  async function handlePlayRequest(request: AiRequestRecord) {
    const audioElement = audioRef.current;
    if (!accessToken || !audioElement || !request.responseText.trim()) {
      return;
    }

    if (playingRequestId === request.requestId) {
      handlePauseRequest();
      setPlayingRequestId(null);
      return;
    }

    activeAudioRequestRef.current?.abort();
    audioElement.pause();
    getSpeechSynthesisApi()?.cancel();
    deviceUtteranceRef.current = null;
    setAudioError(null);
    setLoadingAudioRequestId(request.requestId);
    setPlayingRequestId(null);
    setHasActivePlaybackSession(false);
    setIsDevicePaused(false);

    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (!speechSynthesisApi) {
        setLoadingAudioRequestId(null);
        setAudioError("Este navegador no soporta lectura en voz del dispositivo.");
        return;
      }

      const utterance = new SpeechSynthesisUtterance(request.responseText);
      utterance.lang = "es-ES";
      utterance.rate = playbackRate;
      utterance.voice = selectedDeviceVoice ?? pickFallbackDeviceVoice(availableDeviceVoices);
      utterance.onstart = () => {
        setLoadingAudioRequestId(null);
        setPlayingRequestId(request.requestId);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(false);
      };
      utterance.onend = () => {
        setPlayingRequestId(null);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
        deviceUtteranceRef.current = null;
      };
      utterance.onerror = () => {
        setLoadingAudioRequestId(null);
        setPlayingRequestId(null);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
        setAudioError("No se pudo reproducir la respuesta con la voz del dispositivo.");
        deviceUtteranceRef.current = null;
      };
      utterance.onpause = () => {
        setPlayingRequestId(null);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(true);
      };
      utterance.onresume = () => {
        setPlayingRequestId(request.requestId);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(false);
      };

      deviceUtteranceRef.current = utterance;
      speechSynthesisApi.speak(utterance);
      return;
    }

    const controller = new AbortController();
    activeAudioRequestRef.current = controller;

    try {
      const blob = await requestAiResponseAudio(accessToken, bookId, request.requestId, {
        signal: controller.signal,
        voiceModel: selectedVoiceModel
      });

      if (controller.signal.aborted) {
        return;
      }

      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }

      const audioUrl = URL.createObjectURL(blob);
      audioUrlRef.current = audioUrl;
      audioElement.src = audioUrl;
      audioElement.playbackRate = playbackRate;
      await audioElement.play();
      setPlayingRequestId(request.requestId);
    } catch (error) {
      if (!controller.signal.aborted) {
        setAudioError(error instanceof Error ? error.message : "No se pudo reproducir la respuesta.");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoadingAudioRequestId(null);
      }
    }
  }

  function handlePauseRequest() {
    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (speechSynthesisApi?.speaking && !speechSynthesisApi.paused) {
        speechSynthesisApi.pause();
      }
      return;
    }

    audioRef.current?.pause();
  }

  function handlePlayLatestRequest() {
    if (!latestRequest) {
      return;
    }

    if (selectedTtsEngine === "device" && isDevicePaused && playingRequestId === null) {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (speechSynthesisApi?.paused && deviceUtteranceRef.current) {
        speechSynthesisApi.resume();
        return;
      }
    }

    void handlePlayRequest(latestRequest);
  }

  return (
    <section className="reader-section-summary-page ai-requests-page">
      <header className="reader-section-summary-hero">
        <Link
          aria-label="Volver al lector"
          className="secondary-button link-button reader-header-icon-button reader-section-summary-back-button"
          title="Volver al lector"
          to={backToReaderPath}
        >
          <BackIcon />
        </Link>

        <div className="reader-section-summary-hero-main">
          <p className="eyebrow">{isSectionScope ? "Peticiones IA de sección" : "Peticiones IA del libro"}</p>
          <h2>{contextTitle}</h2>
          {requestsQuery.data?.section ? (
            <div className="reader-section-summary-meta">
              <span>Inicio: pág. {requestsQuery.data.section.startPageNumber}</span>
              <span>Fin: pág. {requestsQuery.data.section.endPageNumber}</span>
            </div>
          ) : null}
        </div>
      </header>

      <section className="panel reader-section-summary-panel ai-request-form-panel">
        <label className="reader-note-composer">
          <span>Petición</span>
          <textarea
            disabled={isSubmitting || requestsQuery.isLoading}
            onChange={(event) => setPromptText(event.target.value)}
            rows={6}
            value={promptText}
          />
        </label>
        {submitError ? <p className="error-text">{submitError}</p> : null}
        <div className="reader-note-editor-actions">
          <button
            className="primary-button"
            disabled={isSubmitting || retryAfterSeconds > 0 || requestsQuery.isLoading || !promptText.trim()}
            onClick={() => void handleCreateRequest()}
            type="button"
          >
            {isSubmitting ? "Enviando..." : retryAfterSeconds > 0 ? `Reintentar en ${retryAfterSeconds}s` : "Enviar petición"}
          </button>
        </div>
      </section>

      {requestsQuery.isLoading ? (
        <section className="panel reader-section-summary-panel">
          <p className="subdued">Cargando peticiones...</p>
        </section>
      ) : null}

      {requestsQuery.isError ? (
        <section className="panel reader-section-summary-panel">
          <p className="error-text">{requestsQuery.error instanceof Error ? requestsQuery.error.message : "No se pudieron cargar las peticiones IA."}</p>
        </section>
      ) : null}

      {deleteError || audioError || navigationError ? (
        <section className="panel reader-section-summary-panel">
          {deleteError ? <p className="error-text">{deleteError}</p> : null}
          {audioError ? <p className="error-text">{audioError}</p> : null}
          {navigationError ? <p className="error-text">{navigationError}</p> : null}
        </section>
      ) : null}

      {!requestsQuery.isLoading && !requestsQuery.isError && groupedRequests.length === 0 ? (
        <section className="panel reader-section-summary-panel reader-section-summary-empty">
          <h3>No hay peticiones todavía</h3>
        </section>
      ) : null}

      {groupedRequests.map((request) => {
        const isAudioLoading = loadingAudioRequestId === request.requestId;
        const isPlaying = playingRequestId === request.requestId;
        return (
          <article className="panel reader-section-summary-panel reader-section-summary-card ai-request-card" key={request.requestId}>
            <div className="reader-section-summary-card-header">
              <div>
                <p className="eyebrow">{formatDate(request.createdAt)}</p>
                <h3>{request.scopeType === "BOOK" ? "Petición al libro" : request.sectionTitle ?? "Petición a la sección"}</h3>
              </div>
              <div className="reader-section-summary-card-badges">
                <button
                  aria-label={isPlaying ? "Pausar respuesta" : "Reproducir respuesta"}
                  className="reader-note-icon-button"
                  disabled={isAudioLoading}
                  onClick={() => void handlePlayRequest(request)}
                  title={isPlaying ? "Pausar respuesta" : "Reproducir respuesta"}
                  type="button"
                >
                  {isAudioLoading ? <LoadingAudioIcon /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  aria-label="Borrar petición"
                  className="reader-note-icon-button danger-icon-button"
                  disabled={deletingRequestId === request.requestId}
                  onClick={() => void handleDeleteRequest(request)}
                  title="Borrar petición"
                  type="button"
                >
                  <DeleteIcon />
                </button>
              </div>
            </div>

            <details className="ai-request-prompt-details">
              <summary>Ver petición enviada</summary>
              <p>{request.promptText}</p>
            </details>

            <div className="reader-section-summary-copy">
              {request.responseParagraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </article>
        );
      })}

      {requestsQuery.data?.section ? (
        <div className="reader-floating-controls reader-section-summary-floating-controls">
          <ReaderFloatingAudioPopover
            buttonLabel="Ajustes de audio"
            isOpen={isAudioSettingsVisible}
            menuRef={audioSettingsRef}
            onToggle={() => setIsAudioSettingsVisible((current) => !current)}
            panelId="ai-requests-audio-settings-panel"
          >
            <ReaderAudioSettingsContent
              deepgramBalanceErrorMessage={deepgramBalanceQuery.isError ? deepgramBalanceErrorMessage : null}
              deepgramBalanceLoading={deepgramBalanceQuery.isLoading}
              deepgramBalanceLabel="Saldo disponible en Deepgram"
              deepgramBalanceValue={deepgramBalanceQuery.data ? formatUsdBalance(deepgramBalanceQuery.data.balance_usd) : null}
              deviceVoiceNote={selectedTtsEngine === "device" && selectedDeviceVoice ? `Voz activa: ${selectedDeviceVoice.name} · ${selectedDeviceVoice.lang}` : null}
              deviceVoiceOptions={deviceVoiceOptions}
              engineOptions={TTS_ENGINE_OPTIONS}
              isDeviceTtsSupported={isDeviceTtsSupported}
              maxPlaybackRate={MAX_PLAYBACK_RATE}
              minPlaybackRate={MIN_PLAYBACK_RATE}
              onDeviceVoiceChange={setSelectedDeviceVoiceUri}
              onPlaybackRateChange={setPlaybackRate}
              onTtsEngineChange={(value) => setSelectedTtsEngine(value as TtsEngine)}
              onVoiceModelChange={setSelectedVoiceModel}
              playbackRate={playbackRate}
              playbackRateStep={PLAYBACK_RATE_STEP}
              selectedDeviceVoiceUri={selectedDeviceVoiceUri}
              selectedTtsEngine={selectedTtsEngine}
              selectedVoiceModel={selectedVoiceModel}
              voiceOptions={TTS_VOICE_OPTIONS}
            />
          </ReaderFloatingAudioPopover>

          <div
            aria-label={currentSectionCounter ? `Sección ${currentSectionIndex + 1} de ${sectionEntries.length}` : "Contador de secciones"}
            className="reader-floating-status"
          >
            <strong>{currentSectionCounter ?? "-/-"}</strong>
          </div>

          <ReaderNavigationPopover
            aiRequestsHref={`/books/${bookId}/ai-requests`}
            aiRequestsLabel="Peticiones IA del libro"
            buttonLabel="Abrir panel de índice, marcadores y notas"
            closeLabel="Cerrar panel de navegación"
            eyebrow={bookTitle}
            isOpen={isNavigationPanelVisible}
            isRendered={isNavigationPanelRendered}
            onAiRequestsClick={closeNavigationPanel}
            onClose={closeNavigationPanel}
            onToggle={toggleNavigationPanel}
            panelAriaLabel="Índice, marcadores y notas"
            panelRef={navigationPanelRef}
            title="Índice y notas"
          >
            <ReaderNavigationPanelContent
              activeItemRef={activeNavigationItemRef}
              editingHighlightId={editingNavigationHighlightId}
              editingHighlightText={editingNavigationHighlightText}
              editingNoteId={editingNavigationNoteId}
              editingNoteColor={editingNavigationNoteColor}
              editingNoteText={editingNavigationNoteText}
              expandedNoteId={expandedNavigationNoteId}
              isUpdatingNote={isUpdatingNote}
              items={orderedNavigationItems}
              outlineSource={navigationQuery.data?.tocSource ?? "NONE"}
              onBeginHighlightEditing={beginNavigationHighlightEditing}
              onBeginNoteEditing={beginNavigationNoteEditing}
              onCancelHighlightEditing={() => {
                setEditingNavigationHighlightId(null);
                setEditingNavigationHighlightText("");
              }}
              onCancelNoteEditing={() => {
                setEditingNavigationNoteId(null);
                setEditingNavigationNoteColor(null);
                setEditingNavigationNoteText("");
              }}
              onDeleteBookmark={(bookmarkId) => handleDeleteSavedBookmark(bookmarkId)}
              onDeleteHighlight={(highlightId) => void handleDeleteSavedHighlight(highlightId)}
              onDeleteNote={(noteId) => void handleDeleteSavedNote(noteId)}
              onEditingHighlightTextChange={setEditingNavigationHighlightText}
              onEditingNoteColorChange={setEditingNavigationNoteColor}
              onEditingNoteTextChange={setEditingNavigationNoteText}
              onSaveHighlightNote={(highlightId, noteText) => void handleCreateNoteForHighlight(highlightId, noteText)}
              onSaveNote={(noteId, noteText, color) => void handleUpdateExistingNote(noteId, noteText, color ?? undefined)}
              onSelectBookmark={(item) => goToReaderLocation(item.pageNumber)}
              onSelectHighlight={(item) => goToReaderLocation(item.pageNumber)}
              onSelectNote={(item) => goToReaderLocation(item.pageNumber)}
              onSelectToc={(item) => goToReaderLocation(item.pageNumber)}
              onSummaryClick={closeNavigationPanel}
              onToggleNoteExpansion={(noteId) => setExpandedNavigationNoteId((current) => current === noteId ? null : noteId)}
              summaryHrefBuilder={(targetChapterId) => sectionAiRequestsHref(targetChapterId)}
            />
          </ReaderNavigationPopover>

          <button
            aria-label="Sección anterior"
            className="reader-float-button"
            disabled={!previousSection?.chapterId}
            onClick={() => {
              if (previousSection?.chapterId) {
                navigate(sectionAiRequestsHref(previousSection.chapterId));
              }
            }}
            type="button"
          >
            <BackIcon />
          </button>

          <button
            aria-label={loadingAudioRequestId === latestRequest?.requestId ? "Generando audio" : isDevicePaused ? "Reanudar respuesta" : "Leer respuesta más reciente"}
            className={loadingAudioRequestId === latestRequest?.requestId ? "reader-float-button primary is-loading" : "reader-float-button primary"}
            disabled={!latestRequest || loadingAudioRequestId === latestRequest.requestId}
            onClick={handlePlayLatestRequest}
            type="button"
          >
            {loadingAudioRequestId === latestRequest?.requestId ? <LoadingAudioIcon /> : <PlayIcon />}
          </button>

          <button
            aria-label="Pausar respuesta"
            className="reader-float-button"
            disabled={!hasActivePlaybackSession || (!playingRequestId && !isDevicePaused)}
            onClick={handlePauseRequest}
            type="button"
          >
            <PauseIcon />
          </button>

          <button
            aria-label="Sección siguiente"
            className="reader-float-button"
            disabled={!nextSection?.chapterId}
            onClick={() => {
              if (nextSection?.chapterId) {
                navigate(sectionAiRequestsHref(nextSection.chapterId));
              }
            }}
            type="button"
          >
            <ForwardIcon />
          </button>
        </div>
      ) : null}
    </section>
  );
}
