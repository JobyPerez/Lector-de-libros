import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  createNote,
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  fetchBook,
  fetchDeepgramBalance,
  fetchReaderNavigation,
  fetchSectionSummary,
  generateSectionSummary,
  requestSectionSummaryAudio,
  updateNote,
  type HighlightColor,
  type ReaderHighlight,
  type ReaderNote,
  type ReaderTocEntry
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { ReaderAudioSettingsContent, ReaderFloatingAudioPopover, ReaderNavigationPanelContent, ReaderNavigationPopover, type ReaderNavigationListItem } from "./ReaderFloatingPanels";

const READER_VOICE_STORAGE_KEY = "lector.reader.voiceModel";
const READER_TTS_ENGINE_STORAGE_KEY = "lector.reader.ttsEngine";
const READER_DEVICE_VOICE_STORAGE_KEY = "lector.reader.deviceVoiceUri";
const READER_SPEED_STORAGE_KEY = "lector.reader.playbackRate";
const DEFAULT_TTS_ENGINE = "deepgram";
const DEFAULT_DEVICE_VOICE_URI = "";
const DEFAULT_VOICE_MODEL = "aura-2-diana-es";
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

function ReaderControlIcon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function BackIcon() {
  return (
    <ReaderControlIcon>
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function ForwardIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5 12H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L17 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
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

function LoadingAudioIcon() {
  return (
    <span aria-hidden="true" className="reader-loading-bars">
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
    </span>
  );
}

function SummaryIcon() {
  return (
    <ReaderControlIcon>
      <path d="M7 6.5H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7 11H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7 15.5H13.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M16.25 14L17 15.5L18.5 16.25L17 17L16.25 18.5L15.5 17L14 16.25L15.5 15.5L16.25 14Z" fill="currentColor" />
    </ReaderControlIcon>
  );
}

function paragraphizeSummary(summaryText: string) {
  return summaryText
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function sectionSummaryHref(bookId: string, targetChapterId: string) {
  return `/books/${bookId}/sections/${encodeURIComponent(targetChapterId)}/summary`;
}

export function SectionSummaryPage() {
  const { bookId = "", chapterId = "" } = useParams();
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
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
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [selectedTtsEngine, setSelectedTtsEngine] = useState<TtsEngine>(readStoredTtsEngine);
  const [selectedVoiceModel, setSelectedVoiceModel] = useState<string>(readStoredVoiceModel);
  const [selectedDeviceVoiceUri, setSelectedDeviceVoiceUri] = useState<string>(readStoredDeviceVoiceUri);
  const [playbackRate, setPlaybackRate] = useState<number>(readStoredPlaybackRate);
  const [availableDeviceVoices, setAvailableDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isDevicePaused, setIsDevicePaused] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const activeAudioRequestRef = useRef<AbortController | null>(null);
  const deviceUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelCloseTimeoutRef = useRef<number | null>(null);
  const activeNavigationItemRef = useRef<HTMLButtonElement | null>(null);

  const summaryQuery = useQuery({
    enabled: Boolean(accessToken && bookId && chapterId),
    queryKey: ["section-summary", bookId, chapterId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchSectionSummary(accessToken, bookId, chapterId);
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

  const navigationQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["reader-navigation", bookId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchReaderNavigation(accessToken, bookId);
    }
  });

  const bookQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["book", bookId],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchBook(accessToken, bookId);
    }
  });

  const isDeviceTtsSupported = Boolean(getSpeechSynthesisApi());
  const deviceVoiceOptions = useMemo(() => buildDeviceVoiceOptions(availableDeviceVoices), [availableDeviceVoices]);
  const selectedDeviceVoice = useMemo(
    () => findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri),
    [availableDeviceVoices, selectedDeviceVoiceUri]
  );
  const summaryText = summaryQuery.data?.summary?.summaryText?.trim() ?? "";
  const summaryParagraphs = useMemo(() => paragraphizeSummary(summaryText), [summaryText]);
  const bookTitle = bookQuery.data?.book.title ?? "Cargando libro...";
  const deepgramBalanceErrorMessage = deepgramBalanceQuery.error instanceof Error
    ? deepgramBalanceQuery.error.message
    : "No se pudo consultar el saldo de Deepgram.";

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

  useEffect(() => {
    const audioElement = new Audio();

    const handlePlay = () => {
      setIsAudioLoading(false);
      setIsAudioPlaying(true);
      setHasActivePlaybackSession(true);
      setAudioError(null);
    };

    const handlePause = () => {
      setIsAudioPlaying(false);
    };

    const handleEnded = () => {
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);
    };

    const handleError = () => {
      setIsAudioLoading(false);
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);
      setAudioError("No se pudo reproducir el audio del resumen.");
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("ended", handleEnded);
    audioElement.addEventListener("error", handleError);
    audioRef.current = audioElement;

    return () => {
      audioElement.pause();
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
      audioElement.removeEventListener("ended", handleEnded);
      audioElement.removeEventListener("error", handleError);
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
    return () => {
      if (navigationPanelCloseTimeoutRef.current !== null) {
        window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      }

      activeAudioRequestRef.current?.abort();
      getSpeechSynthesisApi()?.cancel();
      deviceUtteranceRef.current = null;
      audioRef.current?.pause();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    activeAudioRequestRef.current?.abort();
    setIsAudioLoading(false);
    setIsAudioPlaying(false);
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
  }, [selectedDeviceVoiceUri, selectedTtsEngine, selectedVoiceModel, summaryText]);

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

  const sectionEntries = useMemo(
    () => (navigationQuery.data?.toc ?? []).flatMap((entry) => entry.chapterId ? [{ ...entry, chapterId: entry.chapterId }] : []),
    [navigationQuery.data?.toc]
  );
  const currentSectionIndex = useMemo(
    () => sectionEntries.findIndex((entry) => entry.chapterId === chapterId),
    [chapterId, sectionEntries]
  );
  const previousSection = currentSectionIndex > 0 ? sectionEntries[currentSectionIndex - 1] ?? null : null;
  const nextSection = currentSectionIndex >= 0 ? sectionEntries[currentSectionIndex + 1] ?? null : null;

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

  function goToSection(targetChapterId: string) {
    closeNavigationPanel();
    navigate(sectionSummaryHref(bookId, targetChapterId));
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
      const { note } = await createNote(accessToken, bookId, {
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

  async function handleGenerateSummary() {
    if (!accessToken) {
      return;
    }

    setIsGenerating(true);
    setGenerationError(null);

    try {
      const response = await generateSectionSummary(accessToken, bookId, chapterId);
      queryClient.setQueryData(["section-summary", bookId, chapterId], response);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "No se pudo generar el resumen.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handlePlay() {
    if (!summaryText) {
      return;
    }

    setAudioError(null);

    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (!speechSynthesisApi) {
        setAudioError("Este navegador no soporta lectura en voz del dispositivo.");
        return;
      }

      if (speechSynthesisApi.paused && deviceUtteranceRef.current) {
        speechSynthesisApi.resume();
        setIsAudioPlaying(true);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(false);
        return;
      }

      speechSynthesisApi.cancel();

      const utterance = new SpeechSynthesisUtterance(summaryText);
      utterance.lang = "es-ES";
      utterance.rate = playbackRate;
      utterance.voice = selectedDeviceVoice ?? pickFallbackDeviceVoice(availableDeviceVoices);
      utterance.onstart = () => {
        setIsAudioLoading(false);
        setIsAudioPlaying(true);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(false);
      };
      utterance.onend = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
        deviceUtteranceRef.current = null;
      };
      utterance.onerror = () => {
        setIsAudioLoading(false);
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
        setAudioError("No se pudo reproducir el resumen con la voz del dispositivo.");
        deviceUtteranceRef.current = null;
      };
      utterance.onpause = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(true);
      };
      utterance.onresume = () => {
        setIsAudioPlaying(true);
        setHasActivePlaybackSession(true);
        setIsDevicePaused(false);
      };

      deviceUtteranceRef.current = utterance;
      setIsAudioLoading(true);
      speechSynthesisApi.speak(utterance);
      return;
    }

    if (!accessToken) {
      return;
    }

    const controller = new AbortController();
    activeAudioRequestRef.current?.abort();
    activeAudioRequestRef.current = controller;
    setIsAudioLoading(true);

    try {
      const blob = await requestSectionSummaryAudio(accessToken, bookId, chapterId, {
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

      const audioElement = audioRef.current;
      if (!audioElement) {
        throw new Error("No se pudo preparar el reproductor de audio.");
      }

      audioElement.src = audioUrl;
      audioElement.playbackRate = playbackRate;
      await audioElement.play();
      setHasActivePlaybackSession(true);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setIsAudioLoading(false);
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);
      setAudioError(error instanceof Error ? error.message : "No se pudo reproducir el resumen.");
    }
  }

  function handlePause() {
    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (!speechSynthesisApi) {
        return;
      }

      if (speechSynthesisApi.speaking && !speechSynthesisApi.paused) {
        speechSynthesisApi.pause();
      }
      return;
    }

    audioRef.current?.pause();
  }

  const section = summaryQuery.data?.section ?? null;
  const backToReaderPath = section ? `/books/${bookId}?page=${section.startPageNumber}` : `/books/${bookId}`;

  return (
    <section className="reader-section-summary-page">
      <header className="reader-section-summary-hero">
        <div className="reader-section-summary-hero-main">
          <p className="eyebrow">Resumen por sección</p>
          <h2>{section?.title ?? "Cargando sección..."}</h2>
          <p className="reader-section-summary-intro">
            Genera un resumen desde el comienzo de esta entrada del índice hasta la siguiente y reprodúcelo desde la barra flotante.
          </p>
          {section ? (
            <div className="reader-section-summary-meta">
              <span>Inicio: pág. {section.startPageNumber}</span>
              <span>Fin: pág. {section.endPageNumber}</span>
              <span>{section.isGenerated ? "Índice derivado" : "Índice del libro"}</span>
            </div>
          ) : null}
        </div>

        <div className="reader-section-summary-actions">
          <Link className="ghost-button reader-section-summary-link" to={backToReaderPath}>
            <BackIcon />
            <span>Volver al lector</span>
          </Link>
          <button
            className="primary-button reader-section-summary-generate"
            disabled={isGenerating || summaryQuery.isLoading || !section}
            onClick={() => void handleGenerateSummary()}
            type="button"
          >
            <SummaryIcon />
            <span>{summaryQuery.data?.summary ? "Regenerar resumen" : "Generar resumen"}</span>
          </button>
        </div>
      </header>

      {summaryQuery.isLoading ? (
        <section className="panel reader-section-summary-panel">
          <p className="subdued">Cargando sección...</p>
        </section>
      ) : null}

      {summaryQuery.isError ? (
        <section className="panel reader-section-summary-panel">
          <p className="error-text">{summaryQuery.error instanceof Error ? summaryQuery.error.message : "No se pudo cargar la sección."}</p>
        </section>
      ) : null}

      {generationError ? (
        <section className="panel reader-section-summary-panel">
          <p className="error-text">{generationError}</p>
        </section>
      ) : null}

      {!summaryQuery.isLoading && !summaryQuery.isError && !summaryQuery.data?.summary ? (
        <section className="panel reader-section-summary-panel reader-section-summary-empty">
          <h3>No hay resumen generado todavía</h3>
          <p className="subdued">Cuando lo generes, aquí aparecerá una síntesis de esta parte del libro y podrás escucharla desde la barra flotante.</p>
        </section>
      ) : null}

      {summaryQuery.data?.summary ? (
        <article className="panel reader-section-summary-panel reader-section-summary-card">
          <div className="reader-section-summary-card-header">
            <div>
              <p className="eyebrow">Resumen de la sección</p>
              <h3>{section?.title}</h3>
            </div>
            <div className="reader-section-summary-card-badges">
              {summaryQuery.data.summary.isStale ? <span className="reader-section-summary-badge warning">Necesita regenerarse</span> : null}
              <span className="reader-section-summary-badge">Actualizado</span>
            </div>
          </div>

          <div className="reader-section-summary-copy">
            {summaryParagraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </article>
      ) : null}

      {audioError ? (
        <section className="panel reader-section-summary-panel">
          <p className="error-text">{audioError}</p>
        </section>
      ) : null}

      {navigationError ? (
        <section className="panel reader-section-summary-panel">
          <p className="error-text">{navigationError}</p>
        </section>
      ) : null}

      {section ? (
        <div className="reader-floating-controls reader-section-summary-floating-controls">
          <ReaderFloatingAudioPopover
            buttonLabel="Ajustes de audio"
            isOpen={isAudioSettingsVisible}
            menuRef={audioSettingsRef}
            onToggle={() => setIsAudioSettingsVisible((current) => !current)}
            panelId="section-summary-audio-settings-panel"
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

          <div className="reader-floating-status">
            <strong>Resumen</strong>
            <span>Págs. {section?.startPageNumber} a {section?.endPageNumber}</span>
          </div>

          <ReaderNavigationPopover
            buttonLabel="Abrir panel de índice, marcadores y notas"
            closeLabel="Cerrar panel de navegación"
            eyebrow={bookTitle}
            isOpen={isNavigationPanelVisible}
            isRendered={isNavigationPanelRendered}
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
              onDeleteBookmark={(bookmarkId) => void handleDeleteSavedBookmark(bookmarkId)}
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
              summaryHrefBuilder={(targetChapterId) => sectionSummaryHref(bookId, targetChapterId)}
            />
          </ReaderNavigationPopover>

          <button
            aria-label="Sección anterior"
            className="reader-float-button"
            disabled={!previousSection?.chapterId}
            onClick={() => {
              if (previousSection?.chapterId) {
                navigate(sectionSummaryHref(bookId, previousSection.chapterId));
              }
            }}
            type="button"
          >
            <BackIcon />
          </button>

          <button
            aria-label={isAudioLoading ? "Generando audio" : isDevicePaused ? "Reanudar resumen" : "Leer resumen"}
            className={isAudioLoading ? "reader-float-button primary is-loading" : "reader-float-button primary"}
            disabled={isAudioLoading || !summaryText}
            onClick={() => void handlePlay()}
            type="button"
          >
            {isAudioLoading ? <LoadingAudioIcon /> : <PlayIcon />}
          </button>

          <button
            aria-label="Pausar resumen"
            className="reader-float-button"
            disabled={!hasActivePlaybackSession || (!isAudioPlaying && !isDevicePaused)}
            onClick={handlePause}
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
                navigate(sectionSummaryHref(bookId, nextSection.chapterId));
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