import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import notionIconUrl from "../../assets/notion.svg";

import {
  createBookmark,
  createHighlight,
  createNote,
  deleteBookmark,
  deleteBookPage,
  deleteHighlight,
  deleteNote,
  fetchBookPage,
  fetchDeepgramBalance,
  fetchPageAnnotations,
  fetchProgress,
  fetchReaderNavigation,
  requestParagraphAudio,
  requestParagraphAudioBlock,
  updateNote,
  updateProgress,
  type HighlightColor,
  type ParagraphContent,
  type ReaderAudioBlockParagraph,
  type ReaderHighlight,
  type ReaderNote,
  type ReaderTocEntry
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { ReaderAudioSettingsContent, ReaderFloatingAudioPopover, ReaderNavigationPanelContent, ReaderNavigationPopover } from "./ReaderFloatingPanels";

const READER_VOICE_STORAGE_KEY = "lector.reader.voiceModel";
const READER_TTS_ENGINE_STORAGE_KEY = "lector.reader.ttsEngine";
const READER_DEVICE_VOICE_STORAGE_KEY = "lector.reader.deviceVoiceUri";
const READER_SPEED_STORAGE_KEY = "lector.reader.playbackRate";
const DEFAULT_TTS_ENGINE = "deepgram";
const DEFAULT_DEVICE_VOICE_URI = "";
const DEFAULT_VOICE_MODEL = "aura-2-diana-es";
const DEFAULT_PLAYBACK_RATE = 1.1;
const USD_BALANCE_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency"
});
const MIN_PLAYBACK_RATE = 0.8;
const MAX_PLAYBACK_RATE = 1.35;
const PLAYBACK_RATE_STEP = 0.05;
const PAGE_TURN_DURATION_MS = 720;
const AUDIO_BLOCK_PARAGRAPH_COUNT = 5;
const AUDIO_BLOCK_QUEUE_SIZE = 3;
const AUDIO_RAMP_FIRST_BLOCK_PARAGRAPH_COUNT = 2;
const AUDIO_BLOCK_FALLBACK_DURATION_MS = 18_000;
const AUDIO_BLOCK_HANDOFF_PRIME_THRESHOLD_MS = 12_000;
const READER_POPOVER_HEIGHT_ESTIMATE_PX = 340;
const READER_POPOVER_WIDTH_ESTIMATE_PX = 432;
const READER_POPOVER_VIEWPORT_MARGIN_PX = 12;
const READER_POPOVER_GAP_PX = 14;
const READER_SELECTION_DEBOUNCE_MS = 80;
const READER_NAVIGATION_PANEL_ANIMATION_MS = 220;
const READER_BOOKMARK_ANIMATION_MS = 420;

const HIGHLIGHT_OPTIONS: Array<{ color: HighlightColor; label: string }> = [
  { color: "YELLOW", label: "Amarillo" },
  { color: "GREEN", label: "Verde" },
  { color: "BLUE", label: "Azul" },
  { color: "PINK", label: "Rosa" }
];

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

type PageTurnDirection = "forward" | "backward";

type TtsEngine = "deepgram" | "device";

type DeviceVoiceOption = {
  description: string;
  label: string;
  value: string;
};

type TimedAudioBlockParagraph = ReaderAudioBlockParagraph & {
  endMs: number;
  startMs: number;
};

type PlainTextSegment = {
  highlight: {
    color: HighlightColor;
    highlightId: string;
    text: string;
  } | null;
  text: string;
};

type SelectionDraft = {
  charEnd: number;
  charStart: number;
  paragraph: ParagraphContent;
  rect: {
    left: number;
    maxHeight: number;
    placement: "above" | "below";
    top: number;
  };
  selectedText: string;
};

type QueuedAudioBlock = {
  audioElement?: HTMLAudioElement;
  audioUrl?: string;
  blob?: Blob;
  controller?: AbortController;
  metadataPromise?: Promise<void>;
  paragraphCount: number;
  paragraphs: ReaderAudioBlockParagraph[];
  promise?: Promise<{ blob: Blob; paragraphs: ReaderAudioBlockParagraph[] }>;
  startSequenceNumber: number;
  voiceModel: string;
};

type ActiveAudioBlock = {
  activeParagraphIndex: number;
  paragraphCount: number;
  paragraphTimings: TimedAudioBlockParagraph[];
  startSequenceNumber: number;
  voiceModel: string;
};

type NavigationListItem =
  | {
  chapterId: string | null;
      isActive: boolean;
      key: string;
      level: number;
      pageNumber: number;
      paragraphNumber: number;
      title: string;
      type: "toc";
    }
  | {
      bookmarkId: string;
      isActive: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      title: string;
      type: "bookmark";
    }
  | {
      color: HighlightColor;
      excerpt: string;
      highlightId: string;
      isActive: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      type: "highlight";
    }
  | {
      color: HighlightColor | null;
      excerpt: string;
      isActive: boolean;
      key: string;
      noteId: string;
      noteText: string;
      pageNumber: number;
      paragraphNumber: number;
      type: "note";
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

function formatPageAnchor(pageNumber: number) {
  return `Pág. ${pageNumber}`;
}

function formatRelativeAnchor(pageNumber: number, paragraphNumber: number) {
  return `Pág. ${pageNumber} · párr. ${paragraphNumber}`;
}

function sectionSummaryHref(bookId: string, targetChapterId: string) {
  return `/books/${bookId}/sections/${encodeURIComponent(targetChapterId)}/summary`;
}

type PersistedParagraphProgress = Pick<ParagraphContent, "paragraphNumber" | "sequenceNumber">;

type PageTurnSnapshot = {
  activeParagraphNumber: number | null;
  htmlContent: string | null;
  pageNumber: number;
  paragraphs: ParagraphContent[];
};

type ReaderWakeLockSentinel = {
  addEventListener?: (type: "release", listener: () => void) => void;
  release: () => Promise<void>;
  released?: boolean;
};

type ReaderWakeLockApi = {
  request: (type: "screen") => Promise<ReaderWakeLockSentinel>;
};

type ReaderNotePopoverState = {
  color: HighlightColor | null;
  highlightId: string;
  noteId: string | null;
  rect: {
    left: number;
    maxHeight: number;
    placement: "above" | "below";
    top: number;
  };
  selectedText: string;
};

type ReaderBookmarkAnimationState = "adding" | "removing" | null;

type ActiveSearchTarget = {
  pageNumber: number;
  paragraphNumber: number;
  query: string;
};

type ReaderNavigationState = {
  returnTo?: string;
};

function createPageTurnSnapshot(pageNumber: number, paragraphs: ParagraphContent[], htmlContent: string | null, activeParagraphNumber: number | null): PageTurnSnapshot {
  return {
    activeParagraphNumber,
    htmlContent,
    pageNumber,
    paragraphs
  };
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

function getWakeLockApi() {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
    return null;
  }

  return (navigator as Navigator & { wakeLock?: ReaderWakeLockApi }).wakeLock ?? null;
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

  const sortedOptions = Array.from(uniqueVoices.values()).sort((left, right) => left.label.localeCompare(right.label, "es"));

  return [
    {
      description: "Usa la voz predeterminada del dispositivo",
      label: "Predeterminada",
      value: DEFAULT_DEVICE_VOICE_URI
    },
    ...sortedOptions
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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isMissingAudioBlockRouteError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();
  return normalizedMessage.includes("/tts/block") && normalizedMessage.includes("not found");
}

function setMediaSessionPlaybackState(state: MediaSessionPlaybackState) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = state;
}

function waitForAudioMetadata(audioElement: HTMLAudioElement) {
  if (audioElement.readyState >= 1) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const handleLoadedMetadata = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("No se pudieron leer los metadatos del bloque de audio."));
    };

    const cleanup = () => {
      audioElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audioElement.removeEventListener("error", handleError);
    };

    audioElement.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
    audioElement.addEventListener("error", handleError, { once: true });
  });
}

function buildAudioBlockTimings(paragraphs: ReaderAudioBlockParagraph[], durationMs: number): TimedAudioBlockParagraph[] {
  if (paragraphs.length === 0) {
    return [];
  }

  const paragraphDurationWeights = paragraphs.map((paragraph) => {
    const paragraphDurationMs = typeof paragraph.durationMs === "number" && Number.isFinite(paragraph.durationMs)
      ? paragraph.durationMs
      : 0;

    return paragraphDurationMs > 0 ? paragraphDurationMs : 0;
  });
  const hasDurationWeights = paragraphDurationWeights.every((weight) => weight > 0);
  const knownDurationMs = hasDurationWeights
    ? paragraphDurationWeights.reduce((sum, weight) => sum + weight, 0)
    : 0;
  const safeDurationMs = hasDurationWeights
    ? knownDurationMs
    : Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : AUDIO_BLOCK_FALLBACK_DURATION_MS;
  const paragraphWeights = paragraphs.map((paragraph, index) => {
    if (hasDurationWeights) {
      return paragraphDurationWeights[index] ?? 0;
    }

    const audioByteLength = typeof paragraph.audioByteLength === "number" && Number.isFinite(paragraph.audioByteLength)
      ? paragraph.audioByteLength
      : 0;

    if (audioByteLength > 0) {
      return Math.max(audioByteLength, 256);
    }

    return Math.max(paragraph.textLength, 48);
  });
  const totalWeight = paragraphWeights.reduce((sum, weight) => sum + weight, 0);
  let cursorMs = 0;

  return paragraphs.map((paragraph, index) => {
    const isLastParagraph = index === paragraphs.length - 1;
    const paragraphDurationMs = isLastParagraph
      ? Math.max(safeDurationMs - cursorMs, 0)
      : Math.round((safeDurationMs * (paragraphWeights[index] ?? 48)) / totalWeight);
    const nextTiming: TimedAudioBlockParagraph = {
      ...paragraph,
      endMs: cursorMs + paragraphDurationMs,
      startMs: cursorMs
    };

    cursorMs = nextTiming.endMs;
    return nextTiming;
  });
}

function findParagraphTimingForTime(paragraphTimings: TimedAudioBlockParagraph[], currentTimeMs: number) {
  if (paragraphTimings.length === 0) {
    return null;
  }

  return paragraphTimings.find((paragraphTiming) => currentTimeMs < paragraphTiming.endMs)
    ?? paragraphTimings[paragraphTimings.length - 1]
    ?? null;
}

function normalizeRichTextForComparison(value: string) {
  return value.replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

type RichParagraphTextSegment =
  | {
      kind: "break";
      node: HTMLBRElement;
    }
  | {
      kind: "text";
      node: Text;
      text: string;
    };

function getRichParagraphTextSegments(paragraphNode: HTMLElement): RichParagraphTextSegment[] {
  if (typeof NodeFilter === "undefined") {
    return [];
  }

  const paragraphDocument = paragraphNode.ownerDocument;
  const segments: RichParagraphTextSegment[] = [];
  const walker = paragraphDocument.createTreeWalker(
    paragraphNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node instanceof Text) {
          return node.data.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }

        if (node instanceof HTMLBRElement) {
          return NodeFilter.FILTER_ACCEPT;
        }

        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof Text) {
      segments.push({ kind: "text", node: currentNode, text: currentNode.data });
    } else if (currentNode instanceof HTMLBRElement) {
      segments.push({ kind: "break", node: currentNode });
    }

    currentNode = walker.nextNode();
  }

  return segments;
}

function extractRichParagraphText(paragraphNode: HTMLElement) {
  return getRichParagraphTextSegments(paragraphNode)
    .map((segment) => segment.kind === "break" ? "\n" : segment.text)
    .join("");
}

function renderTextWithLineBreaks(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split(/\n/u);

  return lines.flatMap((line, index) => {
    const nodes: ReactNode[] = [<span key={`${keyPrefix}-line-${index}`}>{line}</span>];
    if (index < lines.length - 1) {
      nodes.push(<br key={`${keyPrefix}-break-${index}`} />);
    }
    return nodes;
  });
}

function getSynchronizedRichHtmlContent(htmlContent: string | null, paragraphs: ParagraphContent[]) {
  if (!htmlContent || typeof DOMParser === "undefined") {
    return htmlContent;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const richParagraphs = Array.from(document.querySelectorAll<HTMLElement>("[data-paragraph-number]"))
    .map((node) => normalizeRichTextForComparison(extractRichParagraphText(node)))
    .filter(Boolean);
  const plainParagraphs = paragraphs
    .map((paragraph) => normalizeRichTextForComparison(paragraph.paragraphText))
    .filter(Boolean);

  if (richParagraphs.length !== plainParagraphs.length) {
    return null;
  }

  for (let index = 0; index < plainParagraphs.length; index += 1) {
    if (richParagraphs[index] !== plainParagraphs[index]) {
      return null;
    }
  }

  return htmlContent;
}

function highlightRichParagraphSearchMatches(paragraphNode: HTMLElement, query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || typeof NodeFilter === "undefined") {
    return;
  }

  const paragraphDocument = paragraphNode.ownerDocument;
  if (!paragraphDocument) {
    return;
  }

  const textNodes: Text[] = [];
  const walker = paragraphDocument.createTreeWalker(
    paragraphNode,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!(node instanceof Text)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (!node.nodeValue?.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        const parentElement = node.parentElement;
        if (!parentElement) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parentElement.closest("mark.reader-search-match-inline")) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) {
      textNodes.push(walker.currentNode);
    }
  }

  const loweredQuery = normalizedQuery.toLocaleLowerCase("es");

  textNodes.forEach((textNode) => {
    const textValue = textNode.nodeValue ?? "";
    const loweredText = textValue.toLocaleLowerCase("es");
    if (!loweredText.includes(loweredQuery)) {
      return;
    }

    const fragment = paragraphDocument.createDocumentFragment();
    let cursor = 0;
    let matchIndex = loweredText.indexOf(loweredQuery, cursor);

    while (matchIndex !== -1) {
      if (matchIndex > cursor) {
        fragment.append(textValue.slice(cursor, matchIndex));
      }

      const mark = paragraphDocument.createElement("mark");
      mark.className = "reader-search-match-inline";
      mark.textContent = textValue.slice(matchIndex, matchIndex + normalizedQuery.length);
      fragment.append(mark);

      cursor = matchIndex + normalizedQuery.length;
      matchIndex = loweredText.indexOf(loweredQuery, cursor);
    }

    if (cursor < textValue.length) {
      fragment.append(textValue.slice(cursor));
    }

    textNode.replaceWith(fragment);
  });
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

function SearchIcon() {
  return (
    <ReaderControlIcon>
      <circle cx="11" cy="11" r="5.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M15 15L19 19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

function NotionIcon() {
  return (
    <img alt="" aria-hidden="true" className="reader-float-button-icon reader-float-button-icon-notion" src={notionIconUrl} />
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

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

function ShelfIcon() {
  return (
    <ReaderControlIcon>
      <path d="M18.5 12H7.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M11.75 7.5L7.25 12L11.75 16.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function AddPagesIcon() {
  return (
    <ReaderControlIcon>
      <path d="M12 6.75V17.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M6.75 12H17.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function OriginalPageIcon() {
  return (
    <ReaderControlIcon>
      <path d="M4.75 19.25L8.35 18.45L17.55 9.25C18.12 8.68 18.12 7.76 17.55 7.19L16.81 6.45C16.24 5.88 15.32 5.88 14.75 6.45L5.55 15.65L4.75 19.25Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.9 7.3L16.7 10.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

function DeletePageIcon() {
  return (
    <ReaderControlIcon>
      <path d="M8 7.25H16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 7.25V5.75C9 5.34 9.34 5 9.75 5H14.25C14.66 5 15 5.34 15 5.75V7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7.25 7.25L8 18.25C8.03 18.67 8.38 19 8.8 19H15.2C15.62 19 15.97 18.67 16 18.25L16.75 7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10.25 10.25V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.75 10.25V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

function LoadingAudioIcon() {
  return (
    <span aria-hidden="true" className="reader-loading-bars">
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
      <span className="reader-loading-bar" />
    </span>
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

function BookmarkIcon() {
  return (
    <ReaderControlIcon>
      <path d="M7 5.5H17C17.5523 5.5 18 5.94772 18 6.5V19L12 15.25L6 19V6.5C6 5.94772 6.44772 5.5 7 5.5Z" fill="currentColor" />
    </ReaderControlIcon>
  );
}

function BookmarkOutlineIcon() {
  return (
    <ReaderControlIcon>
      <path d="M7 5.5H17C17.5523 5.5 18 5.94772 18 6.5V19L12 15.25L6 19V6.5C6 5.94772 6.44772 5.5 7 5.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

function CloseIcon() {
  return (
    <ReaderControlIcon>
      <path d="M8 8L16 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M16 8L8 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function ActionsMenuIcon() {
  return (
    <ReaderControlIcon>
      <circle cx="6.5" cy="12" fill="currentColor" r="1.5" />
      <circle cx="12" cy="12" fill="currentColor" r="1.5" />
      <circle cx="17.5" cy="12" fill="currentColor" r="1.5" />
    </ReaderControlIcon>
  );
}

function EyeIcon() {
  return (
    <ReaderControlIcon>
      <path d="M2.75 12C4.82 8.66 8.11 6.75 12 6.75C15.89 6.75 19.18 8.66 21.25 12C19.18 15.34 15.89 17.25 12 17.25C8.11 17.25 4.82 15.34 2.75 12Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="12" cy="12" fill="currentColor" r="2.2" />
    </ReaderControlIcon>
  );
}

function EditIcon() {
  return (
    <ReaderControlIcon>
      <path d="M4.75 19.25L8.35 18.45L17.55 9.25C18.12 8.68 18.12 7.76 17.55 7.19L16.81 6.45C16.24 5.88 15.32 5.88 14.75 6.45L5.55 15.65L4.75 19.25Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.9 7.3L16.7 10.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

function SaveIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5 12.5L9.25 16.75L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function highlightClassName(color: HighlightColor) {
  return `reader-text-highlight reader-text-highlight-${color.toLowerCase()}`;
}

function buildTextSegments(
  sourceText: string,
  highlights: Array<Pick<ReaderHighlight, "charEnd" | "charStart" | "color" | "highlightId">>
): PlainTextSegment[] {
  if (highlights.length === 0 || sourceText.length === 0) {
    return [{ highlight: null, text: sourceText }];
  }

  const boundaries = new Set<number>([0, sourceText.length]);
  for (const highlight of highlights) {
    boundaries.add(Math.max(0, Math.min(sourceText.length, highlight.charStart)));
    boundaries.add(Math.max(0, Math.min(sourceText.length, highlight.charEnd)));
  }

  const orderedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
  const segments: PlainTextSegment[] = [];

  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const start = orderedBoundaries[index] ?? 0;
    const end = orderedBoundaries[index + 1] ?? 0;
    if (end <= start) {
      continue;
    }

    const matchingHighlight = [...highlights]
      .reverse()
      .find((highlight) => highlight.charStart < end && highlight.charEnd > start)
      ?? null;

    segments.push({
      highlight: matchingHighlight
        ? {
            color: matchingHighlight.color,
            highlightId: matchingHighlight.highlightId,
            text: sourceText.slice(start, end)
          }
        : null,
      text: sourceText.slice(start, end)
    });
  }

  return segments;
}

function applyHighlightsToRichParagraph(
  paragraphNode: HTMLElement,
  highlights: Array<Pick<ReaderHighlight, "charEnd" | "charStart" | "color" | "highlightId">>
) {
  if (highlights.length === 0) {
    return;
  }

  const orderedHighlights = [...highlights].sort((left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd);
  const segments = getRichParagraphTextSegments(paragraphNode);

  let paragraphOffset = 0;

  for (const segment of segments) {
    if (segment.kind === "break") {
      paragraphOffset += 1;
      continue;
    }

    const textNode = segment.node;
    const textContent = segment.text;
    const nodeStart = paragraphOffset;
    const nodeEnd = nodeStart + textContent.length;
    paragraphOffset = nodeEnd;

    const overlappingHighlights = orderedHighlights.filter((highlight) => highlight.charStart < nodeEnd && highlight.charEnd > nodeStart);
    if (overlappingHighlights.length === 0) {
      continue;
    }

    const boundaries = new Set<number>([0, textContent.length]);
    for (const highlight of overlappingHighlights) {
      boundaries.add(Math.max(0, highlight.charStart - nodeStart));
      boundaries.add(Math.min(textContent.length, highlight.charEnd - nodeStart));
    }

    const orderedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
    const fragment = paragraphNode.ownerDocument.createDocumentFragment();

    for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
      const segmentStart = orderedBoundaries[index] ?? 0;
      const segmentEnd = orderedBoundaries[index + 1] ?? 0;
      if (segmentEnd <= segmentStart) {
        continue;
      }

      const segmentText = textContent.slice(segmentStart, segmentEnd);
      const matchingHighlight = [...overlappingHighlights]
        .reverse()
        .find((highlight) => highlight.charStart < nodeStart + segmentEnd && highlight.charEnd > nodeStart + segmentStart)
        ?? null;

      if (!matchingHighlight) {
        fragment.append(segmentText);
        continue;
      }

      const highlightElement = paragraphNode.ownerDocument.createElement("span");
      highlightElement.className = highlightClassName(matchingHighlight.color);
      highlightElement.dataset.highlightId = matchingHighlight.highlightId;
      highlightElement.textContent = segmentText;
      fragment.append(highlightElement);
    }

    textNode.replaceWith(fragment);
  }
}

function findParagraphElement(target: Node | null): HTMLElement | null {
  if (!target) {
    return null;
  }

  if (target instanceof HTMLElement) {
    return target.closest<HTMLElement>("[data-paragraph-id]");
  }

  return target.parentElement?.closest<HTMLElement>("[data-paragraph-id]") ?? null;
}

function buildSelectionDraft(
  selection: Selection,
  paragraphsById: Map<string, ParagraphContent>,
  container: HTMLElement
): SelectionDraft | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) {
    return null;
  }

  const startParagraphElement = findParagraphElement(range.startContainer);
  const endParagraphElement = findParagraphElement(range.endContainer);
  if (!startParagraphElement || !endParagraphElement || startParagraphElement !== endParagraphElement) {
    return null;
  }

  const paragraphId = startParagraphElement.dataset.paragraphId;
  if (!paragraphId) {
    return null;
  }

  const paragraph = paragraphsById.get(paragraphId);
  if (!paragraph) {
    return null;
  }

  const startRange = document.createRange();
  startRange.selectNodeContents(startParagraphElement);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(startParagraphElement);
  endRange.setEnd(range.endContainer, range.endOffset);

  const charStart = startRange.toString().length;
  const charEnd = endRange.toString().length;
  const selectedText = selection.toString().trim();
  const rect = getSelectionAnchorRect(range);

  if (charEnd <= charStart || !selectedText || rect.width === 0) {
    return null;
  }

  const popoverLayout = resolveReaderPopoverLayout(rect);

  return {
    charEnd,
    charStart,
    paragraph,
    rect: {
      left: popoverLayout.left,
      maxHeight: popoverLayout.maxHeight,
      placement: popoverLayout.placement,
      top: popoverLayout.top
    },
    selectedText
  };
}

function getSelectionAnchorRect(range: Range) {
  const rangeRect = range.getBoundingClientRect();
  if (rangeRect.width > 0 || rangeRect.height > 0) {
    return rangeRect;
  }

  const clientRects = Array.from(range.getClientRects());
  const firstVisibleRect = clientRects.find((rect) => rect.width > 0 || rect.height > 0);
  return firstVisibleRect ?? rangeRect;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function resolveReaderPopoverLayout(anchorRect: DOMRect) {
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const anchorCenter = anchorRect.left + (anchorRect.width / 2);
  const minLeft = (READER_POPOVER_WIDTH_ESTIMATE_PX / 2) + READER_POPOVER_VIEWPORT_MARGIN_PX;
  const maxLeft = viewportWidth > 0
    ? Math.max(minLeft, viewportWidth - minLeft)
    : anchorCenter;
  const left = viewportWidth > 0
    ? clamp(anchorCenter, minLeft, maxLeft)
    : anchorCenter;

  if (viewportHeight <= 0) {
    return {
      left,
      maxHeight: READER_POPOVER_HEIGHT_ESTIMATE_PX,
      placement: "below" as const,
      top: anchorRect.bottom
    };
  }

  const spaceAbove = Math.max(0, anchorRect.top - READER_POPOVER_VIEWPORT_MARGIN_PX - READER_POPOVER_GAP_PX);
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - READER_POPOVER_VIEWPORT_MARGIN_PX - READER_POPOVER_GAP_PX);
  const placement = spaceBelow > spaceAbove ? "below" as const : "above" as const;
  const maxHeight = placement === "below" ? spaceBelow : spaceAbove;

  return {
    left,
    maxHeight,
    placement,
    top: placement === "below"
      ? anchorRect.bottom
      : Math.max(READER_POPOVER_VIEWPORT_MARGIN_PX + READER_POPOVER_GAP_PX, anchorRect.top)
  };
}

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [currentPageNumber, setCurrentPageNumber] = useState(1);
  const [currentParagraphNumber, setCurrentParagraphNumber] = useState(1);
  const [isSavingProgress, setIsSavingProgress] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [pendingAutoPlayNextPage, setPendingAutoPlayNextPage] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [isDeletingPage, setIsDeletingPage] = useState(false);
  const [isAudioSettingsVisible, setIsAudioSettingsVisible] = useState(false);
  const [isPageJumpActive, setIsPageJumpActive] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("1");
  const [selectedTtsEngine, setSelectedTtsEngine] = useState<TtsEngine>(readStoredTtsEngine);
  const [selectedVoiceModel, setSelectedVoiceModel] = useState<string>(readStoredVoiceModel);
  const [selectedDeviceVoiceUri, setSelectedDeviceVoiceUri] = useState<string>(readStoredDeviceVoiceUri);
  const [availableDeviceVoices, setAvailableDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [playbackRate, setPlaybackRate] = useState<number>(readStoredPlaybackRate);
  const [hasActivePlaybackSession, setHasActivePlaybackSession] = useState(false);
  const [pendingPageTurnDirection, setPendingPageTurnDirection] = useState<PageTurnDirection | null>(null);
  const [pageTurnDirection, setPageTurnDirection] = useState<PageTurnDirection | null>(null);
  const [pageTurnSnapshot, setPageTurnSnapshot] = useState<PageTurnSnapshot | null>(null);
  const [bookmarkAnimationState, setBookmarkAnimationState] = useState<ReaderBookmarkAnimationState>(null);
  const [isNavigationPanelRendered, setIsNavigationPanelRendered] = useState(false);
  const [isNavigationPanelVisible, setIsNavigationPanelVisible] = useState(false);
  const [isFloatingHeaderActionsVisible, setIsFloatingHeaderActionsVisible] = useState(false);
  const [isFloatingHeaderActionsExpanded, setIsFloatingHeaderActionsExpanded] = useState(false);
  const [floatingHeaderDockStyle, setFloatingHeaderDockStyle] = useState<CSSProperties | null>(null);
  const [activeSearchTarget, setActiveSearchTarget] = useState<ActiveSearchTarget | null>(null);
  const [expandedNavigationNoteId, setExpandedNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteId, setEditingNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteColor, setEditingNavigationNoteColor] = useState<HighlightColor | null>(null);
  const [editingNavigationNoteText, setEditingNavigationNoteText] = useState("");
  const [editingNavigationHighlightId, setEditingNavigationHighlightId] = useState<string | null>(null);
  const [editingNavigationHighlightText, setEditingNavigationHighlightText] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [selectionColor, setSelectionColor] = useState<HighlightColor>("YELLOW");
  const [selectionNoteText, setSelectionNoteText] = useState("");
  const [isSavingSelection, setIsSavingSelection] = useState(false);
  const [activeReaderNote, setActiveReaderNote] = useState<ReaderNotePopoverState | null>(null);
  const [activeReaderNoteText, setActiveReaderNoteText] = useState("");
  const [isUpdatingNote, setIsUpdatingNote] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const activeAudioRequestRef = useRef<AbortController | null>(null);
  const audioBlockQueueRef = useRef<QueuedAudioBlock[]>([]);
  const activeAudioBlockRef = useRef<ActiveAudioBlock | null>(null);
  const audioBlockModeAvailableRef = useRef(true);
  const currentPageNumberRef = useRef(1);
  const currentParagraphNumberRef = useRef(1);
  const lastPersistedProgressRef = useRef<string | null>(null);
  const deviceUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playbackAttemptRef = useRef(0);
  const progressHydratedRef = useRef(false);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const pageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const pageTurnTimeoutRef = useRef<number | null>(null);
  const bookmarkAnimationTimeoutRef = useRef<number | null>(null);
  const navigationPanelCloseTimeoutRef = useRef<number | null>(null);
  const selectionUpdateTimeoutRef = useRef<number | null>(null);
  const paragraphRefs = useRef(new Map<number, HTMLParagraphElement>());
  const richContentRef = useRef<HTMLDivElement | null>(null);
  const livePageRef = useRef<HTMLDivElement | null>(null);
  const readerPanelRef = useRef<HTMLElement | null>(null);
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  const floatingHeaderActionsRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelRef = useRef<HTMLDivElement | null>(null);
  const selectionPopoverRef = useRef<HTMLDivElement | null>(null);
  const readerNotePopoverRef = useRef<HTMLDivElement | null>(null);
  const activeNavigationItemRef = useRef<HTMLButtonElement | null>(null);
  const pendingParagraphTargetRef = useRef<number | "last" | null>(null);
  const pendingParagraphScrollRef = useRef<number | null>(null);
  const pendingRouteNavigationRef = useRef<{ pageNumber: number; paragraphNumber: number; query: string | null } | null>(null);
  const deviceAdvanceTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<ReaderWakeLockSentinel | null>(null);
  const requestedPageParam = searchParams.get("page")?.trim() ?? "";
  const requestedParagraphParam = searchParams.get("paragraph")?.trim() ?? "";
  const requestedSearchParam = searchParams.get("search")?.trim() ?? "";
  const requestedPageNumber = requestedPageParam ? Number(requestedPageParam) : Number.NaN;
  const requestedParagraphNumber = requestedParagraphParam ? Number(requestedParagraphParam) : Number.NaN;
  const navigationState = (location.state as ReaderNavigationState | null) ?? null;
  const readerReturnTo = navigationState?.returnTo?.trim() ?? "";
  const isReturningToGlobalSearch = readerReturnTo.startsWith("/search");

  useEffect(() => {
    progressHydratedRef.current = false;
    audioBlockModeAvailableRef.current = true;
    lastPersistedProgressRef.current = null;
    currentPageNumberRef.current = 1;
    currentParagraphNumberRef.current = 1;
    pendingRouteNavigationRef.current = null;
    setPendingPageTurnDirection(null);
    setPageTurnDirection(null);
    setPageTurnSnapshot(null);
    setCurrentPageNumber(1);
    setCurrentParagraphNumber(1);
    setActiveSearchTarget(null);
  }, [bookId]);

  useEffect(() => {
    currentPageNumberRef.current = currentPageNumber;
  }, [currentPageNumber]);

  useEffect(() => {
    currentParagraphNumberRef.current = currentParagraphNumber;
  }, [currentParagraphNumber]);

  useEffect(() => {
    return () => {
      if (bookmarkAnimationTimeoutRef.current !== null) {
        window.clearTimeout(bookmarkAnimationTimeoutRef.current);
      }

      if (navigationPanelCloseTimeoutRef.current !== null) {
        window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      }

      if (selectionUpdateTimeoutRef.current !== null) {
        window.clearTimeout(selectionUpdateTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function updateFloatingHeaderActionsVisibility() {
      const shouldFloat = true;
      const panelRect = readerPanelRef.current?.getBoundingClientRect();
      const viewportPadding = 12;
      const panelInset = 10;

      if (shouldFloat && panelRect) {
        const nextTop = Math.max(viewportPadding, panelRect.top + panelInset);
        const nextRight = Math.max(viewportPadding, window.innerWidth - panelRect.right + panelInset);
        setFloatingHeaderDockStyle((current) => {
          const top = `${nextTop}px`;
          const right = `${nextRight}px`;
          if (current?.top === top && current?.right === right) {
            return current;
          }

          return { right, top };
        });
      } else {
        setFloatingHeaderDockStyle(null);
      }

      setIsFloatingHeaderActionsVisible((current) => current !== shouldFloat ? shouldFloat : current);
      if (!shouldFloat) {
        setIsFloatingHeaderActionsExpanded(false);
      }
    }

    updateFloatingHeaderActionsVisibility();
    window.addEventListener("resize", updateFloatingHeaderActionsVisibility);
    window.addEventListener("scroll", updateFloatingHeaderActionsVisibility, { passive: true });

    return () => {
      window.removeEventListener("resize", updateFloatingHeaderActionsVisibility);
      window.removeEventListener("scroll", updateFloatingHeaderActionsVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isFloatingHeaderActionsExpanded || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const targetNode = event.target as Node;
      if (floatingHeaderActionsRef.current?.contains(targetNode)) {
        return;
      }

      setIsFloatingHeaderActionsExpanded(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFloatingHeaderActionsExpanded(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFloatingHeaderActionsExpanded]);

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

  const annotationsQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["reader-annotations", bookId, currentPageNumber],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      return fetchPageAnnotations(accessToken, bookId, currentPageNumber);
    }
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

  const isDeviceTtsSupported = Boolean(getSpeechSynthesisApi());
  const deviceVoiceOptions = useMemo(() => buildDeviceVoiceOptions(availableDeviceVoices), [availableDeviceVoices]);
  const selectedDeviceVoice = useMemo(
    () => findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri),
    [availableDeviceVoices, selectedDeviceVoiceUri]
  );

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
    if (Number.isInteger(requestedPageNumber) && requestedPageNumber >= 1) {
      progressHydratedRef.current = true;
      const nextParagraphNumber = Number.isInteger(requestedParagraphNumber) && requestedParagraphNumber >= 1
        ? requestedParagraphNumber
        : 1;
      pendingRouteNavigationRef.current = {
        pageNumber: requestedPageNumber,
        paragraphNumber: nextParagraphNumber,
        query: requestedSearchParam || null
      };
      if (requestedSearchParam) {
        setActiveSearchTarget({
          pageNumber: requestedPageNumber,
          paragraphNumber: nextParagraphNumber,
          query: requestedSearchParam
        });
      }
      pendingParagraphTargetRef.current = nextParagraphNumber;
      setCurrentPageNumber(requestedPageNumber);
      setCurrentParagraphNumber(nextParagraphNumber);
      return;
    }

    const savedProgress = progressQuery.data?.progress;
    if (!savedProgress || progressHydratedRef.current) {
      return;
    }

    progressHydratedRef.current = true;
    setCurrentPageNumber(savedProgress.currentPageNumber);
    setCurrentParagraphNumber(savedProgress.currentParagraphNumber);
  }, [bookId, navigate, progressQuery.data?.progress, requestedPageNumber, requestedParagraphNumber, requestedSearchParam]);

  useEffect(() => {
    if (!Number.isInteger(requestedPageNumber) || requestedPageNumber < 1) {
      return;
    }

    const targetParagraphNumber = Number.isInteger(requestedParagraphNumber) && requestedParagraphNumber >= 1
      ? requestedParagraphNumber
      : 1;

    if (requestedSearchParam) {
      setActiveSearchTarget((current) => {
        if (
          current
          && current.pageNumber === requestedPageNumber
          && current.paragraphNumber === targetParagraphNumber
          && current.query === requestedSearchParam
        ) {
          return current;
        }

        return {
          pageNumber: requestedPageNumber,
          paragraphNumber: targetParagraphNumber,
          query: requestedSearchParam
        };
      });
    }

    if (currentPageNumber !== requestedPageNumber) {
      pendingParagraphTargetRef.current = targetParagraphNumber;
      setCurrentPageNumber(requestedPageNumber);
      setCurrentParagraphNumber(targetParagraphNumber);
      return;
    }

    if (pageQuery.data?.page.pageNumber !== requestedPageNumber) {
      return;
    }

    const targetParagraph = pageQuery.data.page.paragraphs.find((paragraph) => paragraph.paragraphNumber === targetParagraphNumber)
      ?? pageQuery.data.page.paragraphs[0]
      ?? null;

    if (!targetParagraph) {
      return;
    }

    if (currentParagraphNumber !== targetParagraph.paragraphNumber) {
      pendingParagraphScrollRef.current = targetParagraph.paragraphNumber;
      setCurrentParagraphNumber(targetParagraph.paragraphNumber);
      return;
    }

    if (pendingRouteNavigationRef.current) {
      pendingRouteNavigationRef.current = null;
      navigate(`/books/${bookId}`, { replace: true, state: location.state });
    }
  }, [
    bookId,
    currentPageNumber,
    currentParagraphNumber,
    location.state,
    navigate,
    pageQuery.data?.page.pageNumber,
    pageQuery.data?.page.paragraphs,
    requestedPageNumber,
    requestedParagraphNumber,
    requestedSearchParam
  ]);

  useEffect(() => {
    if (!activeSearchTarget) {
      return;
    }

    const clearTimeoutId = window.setTimeout(() => {
      setActiveSearchTarget((current) => current === activeSearchTarget ? null : current);
    }, 7000);

    return () => {
      window.clearTimeout(clearTimeoutId);
    };
  }, [activeSearchTarget]);

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
    audioBlockQueueRef.current.forEach((entry) => {
      entry.controller?.abort();
      releaseQueuedAudioBlockMedia(entry);
    });
    getSpeechSynthesisApi()?.cancel();
    deviceUtteranceRef.current = null;
    audioRef.current?.pause();
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    void releaseScreenWakeLock();

    if (pageTurnTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }
  }, []);

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
    audioBlockQueueRef.current.forEach((entry) => {
      entry.controller?.abort();
      releaseQueuedAudioBlockMedia(entry);
    });
    audioBlockQueueRef.current = [];
    activeAudioBlockRef.current = null;
    clearAudioResource();
    setAutoPlay(false);
  }, [selectedDeviceVoiceUri, selectedTtsEngine, selectedVoiceModel]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (!isAudioPlaying && !isAudioLoading && !hasActivePlaybackSession && !autoPlay) {
        return;
      }

      void ensureScreenWakeLock();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoPlay, hasActivePlaybackSession, isAudioLoading, isAudioPlaying]);

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

  const currentParagraphs = pageQuery.data?.page.paragraphs ?? [];
  const currentHtmlContent = useMemo(
    () => getSynchronizedRichHtmlContent(pageQuery.data?.page.htmlContent ?? null, currentParagraphs),
    [currentParagraphs, pageQuery.data?.page.htmlContent]
  );
  const currentParagraph = currentParagraphs.find((paragraph) => paragraph.paragraphNumber === currentParagraphNumber) ?? currentParagraphs[0] ?? null;
  const currentParagraphIndex = currentParagraph
    ? currentParagraphs.findIndex((paragraph) => paragraph.paragraphId === currentParagraph.paragraphId)
    : -1;
  const canGoToPreviousParagraph = Boolean(currentParagraph) && (currentParagraphIndex > 0 || Boolean(pageQuery.data?.hasPreviousPage));
  const canGoToNextParagraph = Boolean(currentParagraph)
    && (currentParagraphIndex < currentParagraphs.length - 1 || Boolean(pageQuery.data?.hasNextPage));
  const currentBookmarks = annotationsQuery.data?.bookmarks ?? [];
  const currentHighlights = annotationsQuery.data?.highlights ?? [];
  const currentNotes = annotationsQuery.data?.notes ?? [];
  const deepgramBalanceErrorMessage = deepgramBalanceQuery.error instanceof Error
    ? deepgramBalanceQuery.error.message
    : "No se pudo consultar el saldo de Deepgram.";
  const totalPages = pageQuery.data?.book.totalPages ?? 0;
  const hasRichPageContent = Boolean(currentHtmlContent);

  useEffect(() => {
    if (!accessToken || !bookId) {
      return;
    }

    const pagesToPrefetch = [currentPageNumber - 1, currentPageNumber + 1]
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && (totalPages === 0 || pageNumber <= totalPages));

    pagesToPrefetch.forEach((pageNumber) => {
      void queryClient.prefetchQuery({
        queryKey: ["book-page", bookId, pageNumber],
        queryFn: () => fetchBookPage(accessToken, bookId, pageNumber)
      });
    });
  }, [accessToken, bookId, currentPageNumber, queryClient, totalPages]);

  function getLiveParagraphElement(paragraphNumber: number) {
    return livePageRef.current?.querySelector<HTMLElement>(`[data-paragraph-number="${paragraphNumber}"]`)
      ?? paragraphRefs.current.get(paragraphNumber)
      ?? null;
  }

  const appendPagesLink = {
    hash: "#append-pages",
    pathname: "/builder",
    search: `?appendBookId=${encodeURIComponent(bookId)}&insertAfterPage=${encodeURIComponent(String(currentPageNumber))}`
  };
  const reviewOcrLink = {
    hash: "#review-ocr",
    pathname: "/builder",
    search: `?reviewBookId=${encodeURIComponent(bookId)}&reviewPage=${encodeURIComponent(String(currentPageNumber))}`
  };

  const readingPercentage = useMemo(() => {
    if (!pageQuery.data?.book.totalParagraphs || !currentParagraph) {
      return 0;
    }

    return Math.min((currentParagraph.sequenceNumber / pageQuery.data.book.totalParagraphs) * 100, 100);
  }, [currentParagraph, pageQuery.data?.book.totalParagraphs]);

  const paragraphsById = useMemo(
    () => new Map(currentParagraphs.map((paragraph) => [paragraph.paragraphId, paragraph])),
    [currentParagraphs]
  );

  const highlightsByParagraphId = useMemo(() => {
    const nextMap = new Map<string, ReaderHighlight[]>();

    for (const highlight of currentHighlights) {
      const bucket = nextMap.get(highlight.paragraphId) ?? [];
      bucket.push(highlight);
      nextMap.set(highlight.paragraphId, bucket);
    }

    for (const [paragraphId, bucket] of nextMap) {
      bucket.sort((left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd);
      nextMap.set(paragraphId, bucket);
    }

    return nextMap;
  }, [currentHighlights]);

  const noteCountsByParagraphId = useMemo(() => {
    const nextMap = new Map<string, number>();

    for (const note of currentNotes) {
      if (!note.paragraphId) {
        continue;
      }

      nextMap.set(note.paragraphId, (nextMap.get(note.paragraphId) ?? 0) + 1);
    }

    return nextMap;
  }, [currentNotes]);

  const notesByHighlightId = useMemo(() => {
    const nextMap = new Map<string, ReaderNote>();

    for (const note of currentNotes) {
      if (!note.highlightId || nextMap.has(note.highlightId)) {
        continue;
      }

      nextMap.set(note.highlightId, note);
    }

    return nextMap;
  }, [currentNotes]);

  const highlightsById = useMemo(() => {
    const nextMap = new Map<string, ReaderHighlight>();

    for (const highlight of currentHighlights) {
      nextMap.set(highlight.highlightId, highlight);
    }

    return nextMap;
  }, [currentHighlights]);

  const currentPageBookmark = useMemo(() => currentBookmarks[0] ?? null, [currentBookmarks]);
  const isCurrentPageBookmarked = currentBookmarks.length > 0;
  const shouldRenderPageCornerBookmark = isCurrentPageBookmarked || bookmarkAnimationState === "adding" || bookmarkAnimationState === "removing";

  function triggerBookmarkAnimation(nextState: Exclude<ReaderBookmarkAnimationState, null>) {
    setBookmarkAnimationState(nextState);

    if (bookmarkAnimationTimeoutRef.current !== null) {
      window.clearTimeout(bookmarkAnimationTimeoutRef.current);
    }

    bookmarkAnimationTimeoutRef.current = window.setTimeout(() => {
      setBookmarkAnimationState(null);
      bookmarkAnimationTimeoutRef.current = null;
    }, READER_BOOKMARK_ANIMATION_MS);
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

  const activeTocEntry = useMemo(() => {
    const tocEntries = navigationQuery.data?.toc ?? [];
    let activeEntry: ReaderTocEntry | null = null;

    for (const entry of tocEntries) {
      const isBeforeCurrentPage = entry.pageNumber < currentPageNumber;
      const isCurrentPageEntry = entry.pageNumber === currentPageNumber && entry.paragraphNumber <= currentParagraphNumber;
      if (isBeforeCurrentPage || isCurrentPageEntry) {
        activeEntry = entry;
      }
    }

    return activeEntry;
  }, [currentPageNumber, currentParagraphNumber, navigationQuery.data?.toc]);

  const activeTocEntryKey = activeTocEntry ? tocEntryKey(activeTocEntry) : null;
  const activeChapterTitle = activeTocEntry?.title ?? null;

  const orderedNavigationItems = useMemo<NavigationListItem[]>(() => {
    const tocItems: NavigationListItem[] = (navigationQuery.data?.toc ?? []).map((entry) => ({
      chapterId: entry.chapterId ?? null,
      isActive: activeTocEntryKey === tocEntryKey(entry),
      key: `toc:${tocEntryKey(entry)}`,
      level: entry.level,
      pageNumber: entry.pageNumber,
      paragraphNumber: entry.paragraphNumber,
      title: entry.title,
      type: "toc"
    }));

    const bookmarkItems: NavigationListItem[] = (navigationQuery.data?.bookmarks ?? []).map((bookmark) => ({
      bookmarkId: bookmark.bookmarkId,
      isActive: bookmark.pageNumber === currentPageNumber && bookmark.paragraphNumber === currentParagraphNumber,
      key: `bookmark:${bookmark.bookmarkId}`,
      pageNumber: bookmark.pageNumber,
      paragraphNumber: bookmark.paragraphNumber,
      title: "Marcador guardado",
      type: "bookmark"
    }));

    const noteItems: NavigationListItem[] = (navigationQuery.data?.notes ?? []).map((note) => ({
      color: note.highlightColor,
      excerpt: notePreview(note),
      isActive: note.pageNumber === currentPageNumber && (note.paragraphNumber ?? currentParagraphNumber) === currentParagraphNumber,
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

    const standaloneHighlightItems: NavigationListItem[] = (navigationQuery.data?.highlights ?? [])
      .filter((highlight) => !notedHighlightIds.has(highlight.highlightId))
      .map((highlight) => ({
        color: highlight.color,
        excerpt: highlightPreview(highlight),
        highlightId: highlight.highlightId,
        isActive: highlight.pageNumber === currentPageNumber && highlight.paragraphNumber === currentParagraphNumber,
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
  }, [activeTocEntryKey, currentPageNumber, currentParagraphNumber, navigationQuery.data?.bookmarks, navigationQuery.data?.highlights, navigationQuery.data?.notes, navigationQuery.data?.toc]);

  useEffect(() => {
    setSelectionDraft(null);
    setSelectionNoteText("");
    setActiveReaderNote(null);
    setActiveReaderNoteText("");
    setEditingNavigationNoteId(null);
    setEditingNavigationNoteColor(null);
    setEditingNavigationNoteText("");
    setEditingNavigationHighlightId(null);
    setEditingNavigationHighlightText("");
  }, [currentPageNumber]);

  useEffect(() => {
    if (!activeReaderNote?.noteId) {
      return;
    }

    const nextNote = currentNotes.find((note) => note.noteId === activeReaderNote.noteId) ?? null;
    if (!nextNote) {
      setActiveReaderNote(null);
      setActiveReaderNoteText("");
    }
  }, [activeReaderNote, currentNotes]);

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
  const currentPageActiveParagraphNumber = currentParagraph?.paragraphNumber ?? null;
  const effectiveCurrentParagraphNumber = currentPageActiveParagraphNumber ?? currentParagraphNumber;

  useEffect(() => {
    if (!hasRichPageContent || !richContentRef.current || !currentHtmlContent) {
      return;
    }

    paragraphRefs.current.clear();

    const paragraphNodes = richContentRef.current.querySelectorAll<HTMLElement>("[data-paragraph-number]");
    paragraphNodes.forEach((node) => {
      const paragraphNumber = Number.parseInt(node.dataset.paragraphNumber ?? "", 10);
      if (!Number.isInteger(paragraphNumber)) {
        return;
      }

      const paragraph = currentParagraphs.find((entry) => entry.paragraphNumber === paragraphNumber);
      if (!paragraph) {
        return;
      }

      node.dataset.paragraphId = paragraph.paragraphId;
      paragraphRefs.current.set(paragraphNumber, node as HTMLParagraphElement);
    });
  }, [currentHtmlContent, currentPageNumber, currentParagraphs, hasRichPageContent]);

  useEffect(() => {
    if (typeof window === "undefined" || pageTurnDirection || !currentParagraph) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const paragraphElement = getLiveParagraphElement(currentParagraph.paragraphNumber);
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
  }, [currentPageNumber, currentParagraph, pageTurnDirection, hasRichPageContent, currentHtmlContent]);

  useEffect(() => {
    if (typeof window === "undefined" || pageTurnDirection) {
      return;
    }

    const targetParagraphNumber = pendingParagraphScrollRef.current;
    if (targetParagraphNumber === null) {
      return;
    }

    let animationFrameId = 0;
    let retryTimeoutId = 0;
    let attempts = 0;

    const attemptScroll = () => {
      const paragraphElement = getLiveParagraphElement(targetParagraphNumber);
      if (!paragraphElement) {
        if (attempts >= 8) {
          return;
        }

        attempts += 1;
        retryTimeoutId = window.setTimeout(() => {
          animationFrameId = window.requestAnimationFrame(attemptScroll);
        }, 60);
        return;
      }

      const paragraphBounds = paragraphElement.getBoundingClientRect();
      const controlsElement = document.querySelector<HTMLElement>(".reader-floating-controls");
      const controlsHeight = controlsElement?.getBoundingClientRect().height ?? 0;
      const viewportTargetCenter = (window.innerHeight - controlsHeight - 24) / 2;
      const paragraphCenter = paragraphBounds.top + (paragraphBounds.height / 2);
      const nextScrollTop = window.scrollY + paragraphCenter - viewportTargetCenter;

      pendingParagraphScrollRef.current = null;
      if (Math.abs(nextScrollTop - window.scrollY) < 4) {
        return;
      }

      window.scrollTo({
        behavior: "smooth",
        top: Math.max(0, nextScrollTop)
      });
    };

    animationFrameId = window.requestAnimationFrame(attemptScroll);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(retryTimeoutId);
    };
  }, [currentPageNumber, currentParagraphNumber, pageTurnDirection, currentHtmlContent]);

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

  useEffect(() => {
    const pendingParagraphTarget = pendingParagraphTargetRef.current;
    if ((pendingParagraphTarget === null && !pendingAutoPlayNextPage) || pageQuery.data?.page.pageNumber !== currentPageNumber) {
      return;
    }

    const targetParagraph = (pendingParagraphTarget === "last"
      ? pageQuery.data.page.paragraphs[pageQuery.data.page.paragraphs.length - 1]
      : pendingParagraphTarget === null
        ? pageQuery.data.page.paragraphs[0]
        : pageQuery.data.page.paragraphs.find((paragraph) => paragraph.paragraphNumber === pendingParagraphTarget))
      ?? pageQuery.data.page.paragraphs[0]
      ?? null;
    pendingParagraphTargetRef.current = null;

    if (!targetParagraph) {
      if (pendingAutoPlayNextPage) {
        setPendingAutoPlayNextPage(false);
      }
      return;
    }

    setCurrentParagraphNumber(targetParagraph.paragraphNumber);
    pendingParagraphScrollRef.current = targetParagraph.paragraphNumber;
    if (
      pendingRouteNavigationRef.current
      && pendingRouteNavigationRef.current.pageNumber === currentPageNumber
      && pendingRouteNavigationRef.current.paragraphNumber === targetParagraph.paragraphNumber
    ) {
      pendingRouteNavigationRef.current = null;
      navigate(`/books/${bookId}`, { replace: true, state: location.state });
    }
    if (pendingAutoPlayNextPage) {
      setPendingAutoPlayNextPage(false);
      void playParagraph(targetParagraph, currentPageNumber, true);
      return;
    }

    void persistProgress(targetParagraph, currentPageNumber);
  }, [currentPageNumber, pageQuery.data?.page.pageNumber, pageQuery.data?.page.paragraphs, pendingAutoPlayNextPage]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    function updateSelectionDraftFromDocument() {
      const selection = window.getSelection();
      const activeElement = document.activeElement;
      const isInteractingWithPopover = Boolean(
        activeElement
        && selectionPopoverRef.current?.contains(activeElement)
      );

      if ((!selection || selection.isCollapsed || !livePageRef.current) && !isInteractingWithPopover) {
        setSelectionDraft(null);
        setSelectionNoteText("");
        return;
      }

      if (!selection || selection.isCollapsed || !livePageRef.current) {
        return;
      }

      const nextDraft = buildSelectionDraft(selection, paragraphsById, livePageRef.current);
      if (!nextDraft && isInteractingWithPopover) {
        return;
      }

      setSelectionDraft(nextDraft);
      if (!nextDraft) {
        setSelectionNoteText("");
      }
    }

    function scheduleSelectionDraftUpdate() {
      if (selectionUpdateTimeoutRef.current !== null) {
        window.clearTimeout(selectionUpdateTimeoutRef.current);
      }

      selectionUpdateTimeoutRef.current = window.setTimeout(() => {
        selectionUpdateTimeoutRef.current = null;
        updateSelectionDraftFromDocument();
      }, READER_SELECTION_DEBOUNCE_MS);
    }

    function handleSelectionEvent() {
      updateSelectionDraftFromDocument();
    }

    function handleSelectionChange() {
      scheduleSelectionDraftUpdate();
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleSelectionEvent);
    document.addEventListener("keyup", handleSelectionEvent);
    document.addEventListener("touchend", handleSelectionEvent);

    return () => {
      if (selectionUpdateTimeoutRef.current !== null) {
        window.clearTimeout(selectionUpdateTimeoutRef.current);
        selectionUpdateTimeoutRef.current = null;
      }

      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleSelectionEvent);
      document.removeEventListener("keyup", handleSelectionEvent);
      document.removeEventListener("touchend", handleSelectionEvent);
    };
  }, [paragraphsById]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    function handleReaderContextMenu(event: MouseEvent) {
      if (!livePageRef.current?.contains(event.target as Node)) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        return;
      }

      const selectedText = selection.toString().trim();
      if (!selectedText) {
        return;
      }

      const nextDraft = buildSelectionDraft(selection, paragraphsById, livePageRef.current);
      if (!nextDraft) {
        return;
      }

      event.preventDefault();
      setSelectionDraft(nextDraft);
    }

    document.addEventListener("contextmenu", handleReaderContextMenu);

    return () => {
      document.removeEventListener("contextmenu", handleReaderContextMenu);
    };
  }, [paragraphsById]);

  useEffect(() => {
    if ((!isNavigationPanelVisible && !selectionDraft && !activeReaderNote) || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const targetNode = event.target as Node;
      if (selectionPopoverRef.current?.contains(targetNode)) {
        return;
      }

      if (readerNotePopoverRef.current?.contains(targetNode)) {
        return;
      }

      if (isNavigationPanelVisible && navigationPanelRef.current?.contains(targetNode)) {
        return;
      }

      closeNavigationPanel();
      setSelectionDraft(null);
      setSelectionNoteText("");
      setActiveReaderNote(null);
      setActiveReaderNoteText("");
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      closeNavigationPanel();
      setSelectionDraft(null);
      setSelectionNoteText("");
      setActiveReaderNote(null);
      setActiveReaderNoteText("");
      window.getSelection()?.removeAllRanges();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeReaderNote, isNavigationPanelVisible, selectionDraft]);

  useEffect(() => {
    if (!livePageRef.current) {
      return;
    }

    function handleHighlightedNoteClick(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const highlightElement = target.closest<HTMLElement>("[data-highlight-id]");
      if (!highlightElement) {
        return;
      }

      const highlightId = highlightElement.dataset.highlightId;
      if (!highlightId) {
        return;
      }

      const note = notesByHighlightId.get(highlightId) ?? null;
      const highlight = highlightsById.get(highlightId) ?? null;
      if (!highlight) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const rect = highlightElement.getBoundingClientRect();
      const popoverLayout = resolveReaderPopoverLayout(rect);
      setSelectionDraft(null);
      setSelectionNoteText("");
      setActiveReaderNote({
        color: note?.highlightColor ?? highlight.color,
        highlightId,
        noteId: note?.noteId ?? null,
        rect: {
          left: popoverLayout.left,
          maxHeight: popoverLayout.maxHeight,
          placement: popoverLayout.placement,
          top: popoverLayout.top
        },
        selectedText: note ? notePreview(note) : highlightPreview(highlight)
      });
      setActiveReaderNoteText(note?.noteText ?? "");
    }

    const livePageElement = livePageRef.current;
    livePageElement.addEventListener("click", handleHighlightedNoteClick);

    return () => {
      livePageElement.removeEventListener("click", handleHighlightedNoteClick);
    };
  }, [highlightsById, notesByHighlightId]);

  useEffect(() => {
    if (!isNavigationPanelVisible) {
      return;
    }

    activeNavigationItemRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTocEntryKey, currentPageNumber, currentParagraphNumber, isNavigationPanelVisible]);

  async function persistProgress(paragraph: PersistedParagraphProgress, pageNumber: number) {
    if (!accessToken) {
      return;
    }

    const progressKey = `${pageNumber}:${paragraph.sequenceNumber}`;
    if (lastPersistedProgressRef.current === progressKey) {
      return;
    }

    const totalParagraphs = pageQuery.data?.book.totalParagraphs ?? 0;
    const nextReadingPercentage = totalParagraphs > 0
      ? Math.min((paragraph.sequenceNumber / totalParagraphs) * 100, 100)
      : 0;

    setIsSavingProgress(true);
    lastPersistedProgressRef.current = progressKey;

    try {
      await updateProgress(accessToken, bookId, {
        audioOffsetMs: 0,
        currentPageNumber: pageNumber,
        currentParagraphNumber: paragraph.paragraphNumber,
        currentSequenceNumber: paragraph.sequenceNumber,
        readingPercentage: nextReadingPercentage
      });
    } catch (error) {
      if (lastPersistedProgressRef.current === progressKey) {
        lastPersistedProgressRef.current = null;
      }

      throw error;
    } finally {
      setIsSavingProgress(false);
    }
  }

  function clearQueuedAudioBlocks() {
    audioBlockQueueRef.current.forEach((entry) => {
      entry.controller?.abort();
      releaseQueuedAudioBlockMedia(entry);
    });
    audioBlockQueueRef.current = [];
    activeAudioBlockRef.current = null;
  }

  function clearPendingDeviceAdvance() {
    if (deviceAdvanceTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }

    window.clearTimeout(deviceAdvanceTimeoutRef.current);
    deviceAdvanceTimeoutRef.current = null;
  }

  async function releaseScreenWakeLock() {
    const wakeLock = wakeLockRef.current;
    wakeLockRef.current = null;

    if (!wakeLock) {
      return;
    }

    try {
      await wakeLock.release();
    } catch {
      // Algunos navegadores lo liberan automáticamente al apagar la pantalla o cambiar de app.
    }
  }

  async function ensureScreenWakeLock() {
    const wakeLockApi = getWakeLockApi();
    if (!wakeLockApi) {
      return;
    }

    if (wakeLockRef.current && wakeLockRef.current.released !== true) {
      return;
    }

    try {
      const wakeLock = await wakeLockApi.request("screen");
      wakeLockRef.current = wakeLock;
      wakeLock.addEventListener?.("release", () => {
        if (wakeLockRef.current === wakeLock) {
          wakeLockRef.current = null;
        }
      });
    } catch {
      // Si falla, mantenemos la reproducción sin mostrar un error extra al usuario.
    }
  }

  function clearAudioResource(options: { cancelDeviceSpeech?: boolean; invalidatePlayback?: boolean; preservePlaybackElement?: boolean } = {}) {
    if (options.invalidatePlayback ?? true) {
      playbackAttemptRef.current += 1;
    }

    clearPendingDeviceAdvance();
    activeAudioRequestRef.current?.abort();
    activeAudioRequestRef.current = null;
    if (options.cancelDeviceSpeech ?? true) {
      getSpeechSynthesisApi()?.cancel();
    }
    deviceUtteranceRef.current = null;
    const currentAudioElement = audioRef.current;
    currentAudioElement?.pause();
    if (currentAudioElement) {
      currentAudioElement.onplay = null;
      currentAudioElement.onpause = null;
      currentAudioElement.ontimeupdate = null;
      currentAudioElement.onended = null;
      currentAudioElement.onerror = null;
    }

    if (!(options.preservePlaybackElement ?? false)) {
      audioRef.current = null;
    }

    activeAudioBlockRef.current = null;
    setIsAudioPlaying(false);
    setHasActivePlaybackSession(false);
    void releaseScreenWakeLock();

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  function getOrCreatePlaybackAudioElement() {
    if (audioRef.current) {
      return audioRef.current;
    }

    const audioElement = new Audio();
    audioRef.current = audioElement;
    return audioElement;
  }

  function getQueuedAudioBlock(startSequenceNumber: number, voiceModel: string) {
    return audioBlockQueueRef.current.find(
      (entry) => entry.startSequenceNumber === startSequenceNumber && entry.voiceModel === voiceModel
    ) ?? null;
  }

  function getNextAudioBlockParagraphCount(currentParagraphCount: number) {
    return Math.min(
      AUDIO_BLOCK_PARAGRAPH_COUNT,
      Math.max(AUDIO_RAMP_FIRST_BLOCK_PARAGRAPH_COUNT, currentParagraphCount + 1)
    );
  }

  function releaseQueuedAudioBlockMedia(entry: QueuedAudioBlock) {
    entry.audioElement?.pause();
    delete entry.audioElement;
    delete entry.metadataPromise;

    if (entry.audioUrl) {
      URL.revokeObjectURL(entry.audioUrl);
      delete entry.audioUrl;
    }
  }

  function createQueuedAudioBlock(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    if (!accessToken) {
      return null;
    }

    const controller = new AbortController();
    const nextBlock: QueuedAudioBlock = {
      controller,
      paragraphCount,
      paragraphs: [],
      startSequenceNumber,
      voiceModel
    };

    nextBlock.promise = requestParagraphAudioBlock(accessToken, bookId, startSequenceNumber, {
      paragraphCount,
      signal: controller.signal,
      voiceModel
    })
      .then((response) => {
        nextBlock.blob = response.blob;
        nextBlock.paragraphs = response.paragraphs;
        nextBlock.audioUrl = URL.createObjectURL(response.blob);
        nextBlock.audioElement = new Audio(nextBlock.audioUrl);
        nextBlock.audioElement.preload = "auto";
        nextBlock.audioElement.playbackRate = playbackRate;
        nextBlock.audioElement.load();
        nextBlock.metadataPromise = waitForAudioMetadata(nextBlock.audioElement);
        return response;
      })
      .catch((error: unknown) => {
        audioBlockQueueRef.current = audioBlockQueueRef.current.filter((entry) => entry !== nextBlock);
        releaseQueuedAudioBlockMedia(nextBlock);

        if (
          !isAbortError(error)
          && !(error instanceof Error && error.message.toLowerCase().includes("no se encontraron párrafos"))
        ) {
          console.warn("No se pudo precargar el siguiente bloque de audio.", error);
        }

        throw error;
      })
      .finally(() => {
        delete nextBlock.controller;
        delete nextBlock.promise;
      });

    return nextBlock;
  }

  function ensureQueuedAudioBlocks(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    const desiredBlocks: Array<{ paragraphCount: number; startSequenceNumber: number }> = [];

    let nextBlockStartSequenceNumber = startSequenceNumber;
    let nextBlockParagraphCount = paragraphCount;
    for (let queueIndex = 0; queueIndex < AUDIO_BLOCK_QUEUE_SIZE; queueIndex += 1) {
      desiredBlocks.push({
        paragraphCount: nextBlockParagraphCount,
        startSequenceNumber: nextBlockStartSequenceNumber
      });
      nextBlockStartSequenceNumber += nextBlockParagraphCount;
      nextBlockParagraphCount = getNextAudioBlockParagraphCount(nextBlockParagraphCount);
    }

    if (activeAudioBlockRef.current?.voiceModel === voiceModel) {
      desiredBlocks.push({
        paragraphCount: activeAudioBlockRef.current.paragraphCount,
        startSequenceNumber: activeAudioBlockRef.current.startSequenceNumber
      });
    }

    const retainedBlocks: QueuedAudioBlock[] = [];
    for (const entry of audioBlockQueueRef.current) {
      if (entry.voiceModel === voiceModel && desiredBlocks.some((block) => block.startSequenceNumber === entry.startSequenceNumber && block.paragraphCount === entry.paragraphCount)) {
        retainedBlocks.push(entry);
        continue;
      }

      entry.controller?.abort();
      releaseQueuedAudioBlockMedia(entry);
    }

    for (const desiredBlock of desiredBlocks) {
      if (retainedBlocks.some((entry) => entry.startSequenceNumber === desiredBlock.startSequenceNumber && entry.paragraphCount === desiredBlock.paragraphCount)) {
        continue;
      }

      const nextEntry = createQueuedAudioBlock(desiredBlock.startSequenceNumber, voiceModel, desiredBlock.paragraphCount);
      if (nextEntry) {
        retainedBlocks.push(nextEntry);
      }
    }

    retainedBlocks.sort((left, right) => left.startSequenceNumber - right.startSequenceNumber);
    audioBlockQueueRef.current = retainedBlocks;
    retainedBlocks.forEach((entry) => {
      void entry.promise?.catch(() => undefined);
    });
  }

  async function resolveAudioBlock(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    const queuedBlock = getQueuedAudioBlock(startSequenceNumber, voiceModel) ?? createQueuedAudioBlock(startSequenceNumber, voiceModel, paragraphCount);
    if (!queuedBlock) {
      throw new Error("Missing access token.");
    }

    if (!audioBlockQueueRef.current.includes(queuedBlock)) {
      audioBlockQueueRef.current = [...audioBlockQueueRef.current, queuedBlock].sort(
        (left, right) => left.startSequenceNumber - right.startSequenceNumber
      );
    }

    if (!queuedBlock.blob || queuedBlock.paragraphs.length === 0) {
      activeAudioRequestRef.current = queuedBlock.controller ?? null;

      try {
        if (queuedBlock.promise) {
          await queuedBlock.promise;
        }
      } finally {
        if (activeAudioRequestRef.current === queuedBlock.controller) {
          activeAudioRequestRef.current = null;
        }
      }
    }

    if (!queuedBlock.blob || queuedBlock.paragraphs.length === 0) {
      throw new Error("No se pudo preparar el bloque de audio solicitado.");
    }

    audioBlockQueueRef.current = audioBlockQueueRef.current.filter((entry) => entry !== queuedBlock);

    return queuedBlock;
  }

  async function primeQueuedAudioBlock(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    ensureQueuedAudioBlocks(startSequenceNumber, voiceModel, paragraphCount);

    const queuedBlock = getQueuedAudioBlock(startSequenceNumber, voiceModel);
    if (!queuedBlock) {
      return null;
    }

    if (!queuedBlock.blob || queuedBlock.paragraphs.length === 0) {
      await queuedBlock.promise;
    }

    if (queuedBlock.audioElement) {
      await (queuedBlock.metadataPromise ?? waitForAudioMetadata(queuedBlock.audioElement));
    }

    return queuedBlock;
  }

  function findActiveAudioBlockParagraph(sequenceNumber: number) {
    return activeAudioBlockRef.current?.paragraphTimings.find(
      (paragraphTiming) => paragraphTiming.sequenceNumber === sequenceNumber
    ) ?? null;
  }

  function findActiveAudioBlockParagraphIndex(sequenceNumber: number) {
    return activeAudioBlockRef.current?.paragraphTimings.findIndex(
      (paragraphTiming) => paragraphTiming.sequenceNumber === sequenceNumber
    ) ?? -1;
  }

  async function jumpWithinActiveAudioBlock(paragraph: ParagraphContent) {
    const activeAudioBlock = activeAudioBlockRef.current;
    const audioElement = audioRef.current;
    const paragraphIndex = findActiveAudioBlockParagraphIndex(paragraph.sequenceNumber);
    const paragraphTiming = paragraphIndex >= 0
      ? activeAudioBlock?.paragraphTimings[paragraphIndex] ?? null
      : null;
    if (!audioElement || !activeAudioBlock || !paragraphTiming || paragraphIndex < 0) {
      return false;
    }

    const shouldKeepPlaying = !audioElement.paused;
    audioElement.currentTime = paragraphTiming.startMs / 1000;
    activeAudioBlockRef.current = {
      ...activeAudioBlock,
      activeParagraphIndex: paragraphIndex
    };
    syncReaderLocationFromBlockParagraph(paragraphTiming);

    if (shouldKeepPlaying) {
      await audioElement.play();
    }

    return true;
  }

  function syncReaderLocationFromBlockParagraph(paragraph: ReaderAudioBlockParagraph) {
    if (paragraph.pageNumber !== currentPageNumberRef.current) {
      preparePageTurn(paragraph.pageNumber);
      currentPageNumberRef.current = paragraph.pageNumber;
      setCurrentPageNumber(paragraph.pageNumber);
    }

    if (paragraph.paragraphNumber !== currentParagraphNumberRef.current) {
      currentParagraphNumberRef.current = paragraph.paragraphNumber;
      setCurrentParagraphNumber(paragraph.paragraphNumber);
    }

    void persistProgress(paragraph, paragraph.pageNumber);
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
    setPageTurnSnapshot(createPageTurnSnapshot(currentPageNumber, currentParagraphs, currentHtmlContent, currentParagraph?.paragraphNumber ?? null));
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

  function decorateRichHtmlContent(htmlContent: string, activeParagraphNumber: number | null) {
    if (!htmlContent || activeParagraphNumber === null || typeof DOMParser === "undefined") {
      return htmlContent;
    }

    const document = new DOMParser().parseFromString(htmlContent, "text/html");
    const paragraphNodes = document.querySelectorAll<HTMLElement>("[data-paragraph-number]");

    paragraphNodes.forEach((node) => {
      const paragraphNumber = Number.parseInt(node.dataset.paragraphNumber ?? "", 10);
      if (!Number.isInteger(paragraphNumber)) {
        return;
      }

      const paragraph = currentParagraphs.find((entry) => entry.paragraphNumber === paragraphNumber);
      if (!paragraph) {
        return;
      }

      node.dataset.paragraphId = paragraph.paragraphId;
      node.classList.toggle("active", Number.isInteger(paragraphNumber) && paragraphNumber === activeParagraphNumber);
      node.classList.toggle(
        "reader-search-hit",
        Boolean(activeSearchTarget
          && activeSearchTarget.pageNumber === currentPageNumber
          && activeSearchTarget.paragraphNumber === paragraphNumber)
      );

      const activeRichSearchQuery = activeSearchTarget
        && activeSearchTarget.pageNumber === currentPageNumber
        && activeSearchTarget.paragraphNumber === paragraphNumber
        ? activeSearchTarget.query.trim()
        : "";

      const noteCount = noteCountsByParagraphId.get(paragraph.paragraphId) ?? 0;
      node.classList.toggle("has-note", noteCount > 0);
      if (noteCount > 0) {
        node.dataset.noteCount = String(noteCount);
      } else {
        delete node.dataset.noteCount;
      }

      applyHighlightsToRichParagraph(node, highlightsByParagraphId.get(paragraph.paragraphId) ?? []);
      if (activeRichSearchQuery) {
        highlightRichParagraphSearchMatches(node, activeRichSearchQuery);
      }
      node.querySelectorAll<HTMLElement>("[data-highlight-id]").forEach((highlightElement) => {
        const highlightId = highlightElement.dataset.highlightId;
        const note = highlightId ? notesByHighlightId.get(highlightId) ?? null : null;
        if (note) {
          highlightElement.dataset.noteId = note.noteId;
          return;
        }

        delete highlightElement.dataset.noteId;
      });
    });

    return document.body.innerHTML;
  }

  function renderRichContent(htmlContent: string, activeParagraphNumber: number | null, interactive: boolean) {
    const renderedHtmlContent = decorateRichHtmlContent(htmlContent, activeParagraphNumber);

    return (
      <article className="reader-prose reader-prose-rich">
        <div
          className={pageQuery.data?.book.sourceType === "IMAGES" ? "reader-rich-content ocr-rich-content" : "reader-rich-content"}
          dangerouslySetInnerHTML={{ __html: renderedHtmlContent }}
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
      return renderRichContent(htmlContent, activeParagraphNumber, interactive);
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
              data-note-count={noteCountsByParagraphId.get(paragraph.paragraphId) ?? undefined}
              data-paragraph-id={paragraph.paragraphId}
              data-paragraph-number={paragraph.paragraphNumber}
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
              {renderParagraphText(paragraph)}
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
    setHasActivePlaybackSession(false);
  }

  async function playParagraphWithDeviceVoice(
    paragraph: ParagraphContent,
    pageNumber: number,
    keepAutoPlay: boolean,
    playbackAttempt: number
  ) {
    const speechSynthesisApi = getSpeechSynthesisApi();
    if (!speechSynthesisApi) {
      throw new Error("Este navegador no ofrece voces del dispositivo.");
    }

    const normalizedText = paragraph.paragraphText.trim();
    if (!normalizedText) {
      throw new Error("El párrafo no contiene texto para leer en voz alta.");
    }

    const utterance = new SpeechSynthesisUtterance(normalizedText);
    const voice = selectedDeviceVoice ?? pickFallbackDeviceVoice(availableDeviceVoices);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = "es-ES";
    }

    utterance.rate = playbackRate;
    utterance.onstart = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      setIsAudioLoading(false);
      setIsAudioPlaying(true);
      setHasActivePlaybackSession(true);
    };
    utterance.onpause = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      setIsAudioPlaying(false);
    };
    utterance.onresume = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      setIsAudioPlaying(true);
      setHasActivePlaybackSession(true);
    };
    utterance.onend = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      clearPendingDeviceAdvance();
      deviceUtteranceRef.current = null;
      setIsAudioLoading(false);
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);

      if (keepAutoPlay) {
        if (typeof window === "undefined") {
          void advanceToNextParagraphAfterPlayback(paragraph, pageNumber);
          return;
        }

        deviceAdvanceTimeoutRef.current = window.setTimeout(() => {
          deviceAdvanceTimeoutRef.current = null;
          if (playbackAttempt !== playbackAttemptRef.current) {
            return;
          }

          void advanceToNextParagraphAfterPlayback(paragraph, pageNumber);
        }, 90);
      }
    };
    utterance.onerror = (event) => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      clearPendingDeviceAdvance();
      deviceUtteranceRef.current = null;
      setIsAudioLoading(false);
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);

      if (event.error !== "canceled" && event.error !== "interrupted") {
        setAutoPlay(false);
        setReaderError("No se pudo reproducir la voz del dispositivo en este párrafo.");
      }
    };

    setCurrentParagraphNumber(paragraph.paragraphNumber);
    void persistProgress(paragraph, pageNumber);

    clearPendingDeviceAdvance();
    if (speechSynthesisApi.speaking || speechSynthesisApi.pending || speechSynthesisApi.paused) {
      speechSynthesisApi.cancel();
    }
    deviceUtteranceRef.current = utterance;
    setHasActivePlaybackSession(true);
    await ensureScreenWakeLock();
    speechSynthesisApi.speak(utterance);
    setIsAudioLoading(false);
  }

  async function activateResolvedAudioBlock(
    audioBlock: QueuedAudioBlock,
    targetSequenceNumber: number,
    voiceModel: string,
    keepAutoPlay: boolean,
    playbackAttempt: number
  ) {
    const targetParagraph = audioBlock.paragraphs.find(
      (blockParagraph) => blockParagraph.sequenceNumber === targetSequenceNumber
    ) ?? audioBlock.paragraphs[0];
    const nextBlockStartSequenceNumber = audioBlock.startSequenceNumber + audioBlock.paragraphs.length;
    const nextBlockParagraphCount = getNextAudioBlockParagraphCount(audioBlock.paragraphs.length);
    let hasPrimedNextBlockHandoff = false;

    const primeNextBlockHandoff = () => {
      if (hasPrimedNextBlockHandoff) {
        return;
      }

      hasPrimedNextBlockHandoff = true;
      void primeQueuedAudioBlock(nextBlockStartSequenceNumber, voiceModel, nextBlockParagraphCount).catch(() => undefined);
    };

    if (!targetParagraph || !audioBlock.blob) {
      throw new Error("No se pudo localizar el párrafo dentro del bloque de audio.");
    }

    ensureQueuedAudioBlocks(
      nextBlockStartSequenceNumber,
      voiceModel,
      nextBlockParagraphCount
    );
    primeNextBlockHandoff();

    const audioUrl = audioBlock.audioUrl ?? URL.createObjectURL(audioBlock.blob);
    audioUrlRef.current = audioUrl;

    const audioElement = getOrCreatePlaybackAudioElement();
    audioRef.current = audioElement;
    if (audioElement.src !== audioUrl) {
      audioElement.src = audioUrl;
      audioElement.load();
    }
    audioElement.preload = "auto";
    audioElement.playbackRate = playbackRate;

    const blockStartsAtTargetParagraph = audioBlock.paragraphs[0]?.sequenceNumber === targetParagraph.sequenceNumber;
    if (!blockStartsAtTargetParagraph) {
      await (audioBlock.metadataPromise ?? waitForAudioMetadata(audioElement));
    }

    if (playbackAttempt !== playbackAttemptRef.current) {
      return;
    }

    const paragraphTimings = buildAudioBlockTimings(audioBlock.paragraphs, audioElement.duration * 1000);
    const targetParagraphIndex = Math.max(
      paragraphTimings.findIndex((timing) => timing.sequenceNumber === targetParagraph.sequenceNumber),
      0
    );
    const targetParagraphTiming = paragraphTimings[targetParagraphIndex] ?? null;

    if (!targetParagraphTiming) {
      throw new Error("No se pudo calcular la posición del bloque de audio.");
    }

    activeAudioBlockRef.current = {
      activeParagraphIndex: targetParagraphIndex,
      paragraphCount: audioBlock.paragraphs.length,
      paragraphTimings,
      startSequenceNumber: audioBlock.startSequenceNumber,
      voiceModel
    };

    if (blockStartsAtTargetParagraph) {
      void (audioBlock.metadataPromise ?? waitForAudioMetadata(audioElement))
        .then(() => {
          if (playbackAttempt !== playbackAttemptRef.current) {
            return;
          }

          const activeAudioBlock = activeAudioBlockRef.current;
          if (!activeAudioBlock || activeAudioBlock.startSequenceNumber !== audioBlock.startSequenceNumber || activeAudioBlock.voiceModel !== voiceModel) {
            return;
          }

          activeAudioBlockRef.current = {
            ...activeAudioBlock,
            paragraphTimings: buildAudioBlockTimings(audioBlock.paragraphs, audioElement.duration * 1000)
          };
        })
        .catch(() => undefined);
    }

    audioElement.currentTime = targetParagraphTiming.startMs / 1000;
    setHasActivePlaybackSession(true);
    audioElement.onplay = () => {
      setIsAudioPlaying(true);
    };
    audioElement.onpause = () => {
      setIsAudioPlaying(false);
    };
    audioElement.ontimeupdate = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      const activeAudioBlock = activeAudioBlockRef.current;
      if (!activeAudioBlock || activeAudioBlock.voiceModel !== voiceModel) {
        return;
      }

      const currentTimeMs = audioElement.currentTime * 1000;
      const paragraphTimings = activeAudioBlock.paragraphTimings;
      if (paragraphTimings.length === 0) {
        return;
      }

      let nextParagraphIndex = Math.min(
        Math.max(activeAudioBlock.activeParagraphIndex, 0),
        paragraphTimings.length - 1
      );
      let activeParagraphTiming = paragraphTimings[nextParagraphIndex] ?? null;
      if (!activeParagraphTiming) {
        return;
      }

      while (nextParagraphIndex > 0 && currentTimeMs < activeParagraphTiming.startMs) {
        nextParagraphIndex -= 1;
        activeParagraphTiming = paragraphTimings[nextParagraphIndex] ?? null;
        if (!activeParagraphTiming) {
          return;
        }
      }

      while (nextParagraphIndex < paragraphTimings.length - 1 && currentTimeMs >= activeParagraphTiming.endMs) {
        nextParagraphIndex += 1;
        activeParagraphTiming = paragraphTimings[nextParagraphIndex] ?? null;
        if (!activeParagraphTiming) {
          return;
        }
      }

      if (nextParagraphIndex !== activeAudioBlock.activeParagraphIndex) {
        activeAudioBlockRef.current = {
          ...activeAudioBlock,
          activeParagraphIndex: nextParagraphIndex
        };
      }

      syncReaderLocationFromBlockParagraph(activeParagraphTiming);

      const remainingMs = Math.max(activeParagraphTiming.endMs - currentTimeMs, 0);
      if (remainingMs <= AUDIO_BLOCK_HANDOFF_PRIME_THRESHOLD_MS) {
        primeNextBlockHandoff();
      }
    };
    audioElement.onended = () => {
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);
      activeAudioBlockRef.current = null;
      if (keepAutoPlay) {
        void continueWithNextAudioBlock(audioBlock.startSequenceNumber, audioBlock.paragraphs.length, voiceModel);
      }
    };
    audioElement.onerror = () => {
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);
      activeAudioBlockRef.current = null;
    };

    syncReaderLocationFromBlockParagraph(targetParagraphTiming);
    void persistProgress(targetParagraph, targetParagraph.pageNumber);
    await ensureScreenWakeLock();
    await audioElement.play();
  }

  async function playQueuedAudioBlock(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    const playbackAttempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = playbackAttempt;
    setReaderError(null);
    setIsAudioLoading(true);

    try {
      clearAudioResource({ invalidatePlayback: false, preservePlaybackElement: true });
      ensureQueuedAudioBlocks(startSequenceNumber, voiceModel, paragraphCount);
      const nextBlock = await resolveAudioBlock(startSequenceNumber, voiceModel, paragraphCount);

      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      await activateResolvedAudioBlock(nextBlock, startSequenceNumber, voiceModel, true, playbackAttempt);
    } finally {
      if (playbackAttempt === playbackAttemptRef.current) {
        setIsAudioLoading(false);
      }
    }
  }

  async function continueWithNextAudioBlock(currentBlockStartSequenceNumber: number, currentBlockParagraphCount: number, voiceModel: string) {
    const nextParagraphSequence = currentBlockStartSequenceNumber + currentBlockParagraphCount;
    const nextParagraphCount = getNextAudioBlockParagraphCount(currentBlockParagraphCount);

    try {
      await playQueuedAudioBlock(nextParagraphSequence, voiceModel, nextParagraphCount);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setAutoPlay(false);
      setIsAudioPlaying(false);
      setHasActivePlaybackSession(false);

      if (isMissingAudioBlockRouteError(error)) {
        audioBlockModeAvailableRef.current = false;
        clearQueuedAudioBlocks();

        const currentParagraph = currentParagraphs.find((entry) => entry.sequenceNumber === nextParagraphSequence);
        if (currentParagraph) {
          void playParagraph(currentParagraph, currentPageNumberRef.current, true);
          return;
        }

        setAutoPlay(false);
        return;
      }

      if (error instanceof Error && !error.message.toLowerCase().includes("no se encontraron párrafos")) {
        setReaderError(error.message);
      }
    }
  }

  async function playParagraphWarmStart(paragraph: ParagraphContent, pageNumber: number, keepAutoPlay: boolean) {
    const controller = new AbortController();
    activeAudioRequestRef.current = controller;

    try {
      const audioBlob = await requestParagraphAudio(accessToken!, bookId, paragraph.paragraphId, {
        signal: controller.signal,
        voiceModel: selectedVoiceModel
      });

      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      audioUrlRef.current = audioUrl;

      const audioElement = getOrCreatePlaybackAudioElement();
      audioRef.current = audioElement;
      if (audioElement.src !== audioUrl) {
        audioElement.src = audioUrl;
        audioElement.load();
      }
      audioElement.preload = "auto";
      audioElement.playbackRate = playbackRate;
      setHasActivePlaybackSession(true);
      audioElement.onplay = () => {
        setIsAudioPlaying(true);
      };
      audioElement.onpause = () => {
        setIsAudioPlaying(false);
      };
      audioElement.onended = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
        if (keepAutoPlay) {
          void playQueuedAudioBlock(paragraph.sequenceNumber + 1, selectedVoiceModel, AUDIO_RAMP_FIRST_BLOCK_PARAGRAPH_COUNT).catch((error: unknown) => {
            if (isAbortError(error)) {
              return;
            }

            if (isMissingAudioBlockRouteError(error)) {
              audioBlockModeAvailableRef.current = false;
              clearQueuedAudioBlocks();
              void advanceToNextParagraphAfterPlayback(paragraph, pageNumber);
              return;
            }

            if (error instanceof Error && error.message.toLowerCase().includes("no se encontraron párrafos")) {
              setAutoPlay(false);
              setIsAudioPlaying(false);
              setHasActivePlaybackSession(false);
              return;
            }

            setAutoPlay(false);
            setReaderError(error instanceof Error ? error.message : "No se pudo continuar la reproducción.");
          });
        }
      };
      audioElement.onerror = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
      };

      setCurrentParagraphNumber(paragraph.paragraphNumber);
      if (keepAutoPlay) {
        ensureQueuedAudioBlocks(paragraph.sequenceNumber + 1, selectedVoiceModel, AUDIO_RAMP_FIRST_BLOCK_PARAGRAPH_COUNT);
      }

      void persistProgress(paragraph, pageNumber);
      await ensureScreenWakeLock();
      await audioElement.play();
    } finally {
      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }
    }
  }

  async function playParagraphWithLegacyDeepgram(paragraph: ParagraphContent, pageNumber: number, keepAutoPlay: boolean) {
    const controller = new AbortController();
    activeAudioRequestRef.current = controller;

    try {
      const audioBlob = await requestParagraphAudio(accessToken!, bookId, paragraph.paragraphId, {
        signal: controller.signal,
        voiceModel: selectedVoiceModel
      });

      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      audioUrlRef.current = audioUrl;

      const audioElement = getOrCreatePlaybackAudioElement();
      audioRef.current = audioElement;
      if (audioElement.src !== audioUrl) {
        audioElement.src = audioUrl;
        audioElement.load();
      }
      audioElement.preload = "auto";
      audioElement.playbackRate = playbackRate;
      setHasActivePlaybackSession(true);
      audioElement.onplay = () => {
        setIsAudioPlaying(true);
      };
      audioElement.onpause = () => {
        setIsAudioPlaying(false);
      };
      audioElement.onended = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
        if (keepAutoPlay) {
          void advanceToNextParagraphAfterPlayback(paragraph, pageNumber);
        }
      };
      audioElement.onerror = () => {
        setIsAudioPlaying(false);
        setHasActivePlaybackSession(false);
      };

      setCurrentParagraphNumber(paragraph.paragraphNumber);
      void persistProgress(paragraph, pageNumber);
      await ensureScreenWakeLock();
      await audioElement.play();
    } finally {
      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }
    }
  }

  async function playParagraph(paragraph: ParagraphContent, pageNumber: number, keepAutoPlay: boolean) {
    if (!accessToken) {
      return;
    }

    const playbackAttempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = playbackAttempt;
    const hasReusableAudioSession = Boolean(audioRef.current?.src) && audioRef.current?.ended !== true;
    const shouldWarmStartDeepgram = keepAutoPlay
      && paragraph.paragraphText.trim().length > 0
      && !hasReusableAudioSession;

    setReaderError(null);
    setIsAudioLoading(true);

    try {
      const speechSynthesisApi = selectedTtsEngine === "device" ? getSpeechSynthesisApi() : null;
      const shouldCancelDeviceSpeech = Boolean(
        speechSynthesisApi && (speechSynthesisApi.speaking || speechSynthesisApi.pending || speechSynthesisApi.paused)
      );
      clearAudioResource({ cancelDeviceSpeech: shouldCancelDeviceSpeech, invalidatePlayback: false });

      if (selectedTtsEngine === "device") {
        await playParagraphWithDeviceVoice(paragraph, pageNumber, keepAutoPlay, playbackAttempt);
        return;
      }

      if (!audioBlockModeAvailableRef.current) {
        await playParagraphWithLegacyDeepgram(paragraph, pageNumber, keepAutoPlay);
        return;
      }

      if (shouldWarmStartDeepgram) {
        await playParagraphWarmStart(paragraph, pageNumber, keepAutoPlay);
        return;
      }

      const audioBlock = await resolveAudioBlock(paragraph.sequenceNumber, selectedVoiceModel);
      if (playbackAttempt !== playbackAttemptRef.current) {
        return;
      }

      await activateResolvedAudioBlock(audioBlock, paragraph.sequenceNumber, selectedVoiceModel, keepAutoPlay, playbackAttempt);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      if (isMissingAudioBlockRouteError(error)) {
        audioBlockModeAvailableRef.current = false;
        clearQueuedAudioBlocks();
        setReaderError(null);
        await playParagraphWithLegacyDeepgram(paragraph, pageNumber, keepAutoPlay);
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

  async function handlePlay() {
    if (!currentParagraph) {
      return;
    }

    setAutoPlay(true);

    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (speechSynthesisApi?.paused) {
        void ensureScreenWakeLock();
        speechSynthesisApi.resume();
        setIsAudioPlaying(true);
        setHasActivePlaybackSession(true);
        return;
      }
    }

    if (audioRef.current?.paused && audioRef.current.src) {
      void ensureScreenWakeLock();
      await audioRef.current.play();
      setHasActivePlaybackSession(true);
      return;
    }

    await playParagraph(currentParagraph, currentPageNumber, true);
  }

  function handlePause() {
    setAutoPlay(false);

    if (selectedTtsEngine === "device") {
      const speechSynthesisApi = getSpeechSynthesisApi();
      if (speechSynthesisApi && (speechSynthesisApi.speaking || speechSynthesisApi.pending)) {
        speechSynthesisApi.pause();
      }
      setIsAudioPlaying(false);
      void releaseScreenWakeLock();
      return;
    }

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
    clearQueuedAudioBlocks();
    await persistProgress(paragraph, currentPageNumber);
  }

  async function refreshReaderMetadata() {
    await Promise.all([annotationsQuery.refetch(), navigationQuery.refetch()]);
  }

  async function goToLocation(nextPageNumber: number, targetParagraphNumber: number | "last" = 1, options?: { continuePlayback?: boolean }) {
    const boundedPageNumber = totalPages > 0
      ? Math.min(Math.max(nextPageNumber, 1), totalPages)
      : nextPageNumber;

    if (!Number.isInteger(boundedPageNumber) || boundedPageNumber < 1) {
      return;
    }

    if (boundedPageNumber === currentPageNumber) {
      const targetParagraph = (targetParagraphNumber === "last"
        ? currentParagraphs[currentParagraphs.length - 1]
        : currentParagraphs.find((paragraph) => paragraph.paragraphNumber === targetParagraphNumber))
        ?? currentParagraphs[0]
        ?? null;
      if (!targetParagraph) {
        return;
      }

      setCurrentParagraphNumber(targetParagraph.paragraphNumber);
      await persistProgress(targetParagraph, currentPageNumber);
      return;
    }

    clearAudioResource();
    clearQueuedAudioBlocks();
    setPendingAutoPlayNextPage(options?.continuePlayback === true);
    setAutoPlay(options?.continuePlayback === true);
    setIsPageJumpActive(false);
    pendingParagraphTargetRef.current = targetParagraphNumber;
    preparePageTurn(boundedPageNumber);
    currentParagraphNumberRef.current = targetParagraphNumber === "last" ? 1 : targetParagraphNumber;
    setCurrentParagraphNumber(targetParagraphNumber === "last" ? 1 : targetParagraphNumber);
    setCurrentPageNumber(boundedPageNumber);
  }

  function handleNavigationPanelSelection(pageNumber: number, paragraphNumber: number | "last" = 1) {
    closeNavigationPanel();
    void goToLocation(pageNumber, paragraphNumber);
  }

  async function goToPage(nextPageNumber: number) {
    const shouldContinuePlayback = autoPlay || isAudioPlaying || isAudioLoading;
    await goToLocation(nextPageNumber, 1, { continuePlayback: shouldContinuePlayback });
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

    const shouldContinuePlayback = autoPlay || isAudioPlaying || isAudioLoading;
    const paragraphIndex = currentParagraphs.findIndex((paragraph) => paragraph.paragraphId === currentParagraph.paragraphId);
    const nextParagraph = currentParagraphs[paragraphIndex + delta];
    if (!nextParagraph) {
      const targetPageNumber = currentPageNumber + delta;
      const canChangePage = delta < 0 ? pageQuery.data?.hasPreviousPage : pageQuery.data?.hasNextPage;
      if (!canChangePage) {
        return;
      }

      await goToLocation(targetPageNumber, delta < 0 ? "last" : 1, { continuePlayback: shouldContinuePlayback });
      return;
    }

    if (selectedTtsEngine === "deepgram") {
      const reusedCurrentBlock = await jumpWithinActiveAudioBlock(nextParagraph);
      if (reusedCurrentBlock) {
        return;
      }
    }

    clearAudioResource();
    clearQueuedAudioBlocks();
    setCurrentParagraphNumber(nextParagraph.paragraphNumber);

    if (!shouldContinuePlayback) {
      setAutoPlay(false);
      await persistProgress(nextParagraph, currentPageNumber);
      return;
    }

    setAutoPlay(true);
    await playParagraph(nextParagraph, currentPageNumber, true);
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
    clearQueuedAudioBlocks();
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

  async function handleToggleBookmark() {
    if (!accessToken) {
      return;
    }

    setReaderError(null);

    try {
      const removingBookmark = currentBookmarks.length > 0;

      if (currentBookmarks.length > 0) {
        triggerBookmarkAnimation("removing");
        await Promise.all(currentBookmarks.map((bookmark) => deleteBookmark(accessToken, bookId, bookmark.bookmarkId)));
      } else {
        const bookmarkParagraph = currentParagraph ?? currentParagraphs[0] ?? null;
        if (!bookmarkParagraph) {
          return;
        }

        triggerBookmarkAnimation("adding");
        await createBookmark(accessToken, bookId, { paragraphId: bookmarkParagraph.paragraphId });
      }

      await refreshReaderMetadata();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo actualizar el marcador actual.");
    }
  }

  async function handleSaveSelection() {
    if (!accessToken || !selectionDraft || selectionDraft.charEnd <= selectionDraft.charStart) {
      return;
    }

    setIsSavingSelection(true);
    setReaderError(null);

    try {
      const { highlight } = await createHighlight(accessToken, bookId, {
        charEnd: selectionDraft.charEnd,
        charStart: selectionDraft.charStart,
        color: selectionColor,
        highlightedText: selectionDraft.selectedText,
        paragraphId: selectionDraft.paragraph.paragraphId
      });

      if (selectionNoteText.trim()) {
        await createNote(accessToken, bookId, {
          highlightId: highlight.highlightId,
          noteText: selectionNoteText.trim()
        });
      }

      await refreshReaderMetadata();
      setSelectionDraft(null);
      setSelectionNoteText("");
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo guardar el texto resaltado.");
    } finally {
      setIsSavingSelection(false);
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
      setActiveReaderNote((current) => current?.noteId === noteId ? null : current);
      await refreshReaderMetadata();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo borrar la nota.");
    }
  }

  async function handleCreateNoteForHighlight(highlightId: string, noteText: string, source: "navigation" | "reader") {
    if (!accessToken || !noteText.trim()) {
      return;
    }

    setIsUpdatingNote(true);
    setReaderError(null);

    try {
      const trimmedNoteText = noteText.trim();
      const { note } = await createNote(accessToken, bookId, {
        highlightId,
        noteText: trimmedNoteText
      });
      await refreshReaderMetadata();

      if (source === "navigation") {
        setEditingNavigationHighlightId(null);
        setEditingNavigationHighlightText("");
        setExpandedNavigationNoteId(null);
      } else {
        setActiveReaderNote(null);
        setActiveReaderNoteText("");
      }
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo guardar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
  }

  async function handleUpdateExistingNote(noteId: string, noteText: string, source: "navigation" | "reader", highlightColor?: HighlightColor) {
    if (!accessToken || !noteText.trim()) {
      return;
    }

    setIsUpdatingNote(true);
    setReaderError(null);

    try {
      const trimmedNoteText = noteText.trim();
      await updateNote(accessToken, bookId, noteId, {
        ...(highlightColor ? { highlightColor } : {}),
        noteText: trimmedNoteText
      });
      await refreshReaderMetadata();

      setActiveReaderNote((current) => current?.noteId === noteId
        ? {
            ...current,
            color: highlightColor ?? current.color
          }
        : current);

      if (source === "navigation") {
        setEditingNavigationNoteId(null);
        setEditingNavigationNoteColor(null);
        setEditingNavigationNoteText("");
        setExpandedNavigationNoteId(null);
      } else {
        setActiveReaderNote(null);
        setActiveReaderNoteText("");
      }
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo actualizar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
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

  async function handleDeleteSavedHighlight(highlightId: string) {
    if (!accessToken) {
      return;
    }

    try {
      await deleteHighlight(accessToken, bookId, highlightId);
      setEditingNavigationHighlightId((current) => current === highlightId ? null : current);
      setActiveReaderNote((current) => current?.highlightId === highlightId ? null : current);
      await refreshReaderMetadata();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo borrar el resaltado.");
    }
  }

  async function handleDeleteSavedBookmark(bookmarkId: string) {
    if (!accessToken) {
      return;
    }

    try {
      await deleteBookmark(accessToken, bookId, bookmarkId);
      await refreshReaderMetadata();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo borrar el marcador.");
    }
  }

  function renderParagraphText(paragraph: ParagraphContent) {
    const segments = buildTextSegments(paragraph.paragraphText, highlightsByParagraphId.get(paragraph.paragraphId) ?? []);
    const activeSearchQuery = activeSearchTarget
      && activeSearchTarget.pageNumber === currentPageNumber
      && activeSearchTarget.paragraphNumber === paragraph.paragraphNumber
      ? activeSearchTarget.query.trim()
      : "";

    const renderSearchMatches = (text: string, keyPrefix: string) => {
      if (!activeSearchQuery) {
        return renderTextWithLineBreaks(text, `${keyPrefix}-plain`);
      }

      const normalizedText = text.toLocaleLowerCase("es");
      const normalizedQuery = activeSearchQuery.toLocaleLowerCase("es");
      const matchNodes: ReactNode[] = [];
      let cursor = 0;
      let matchIndex = 0;

      while (cursor < text.length) {
        const nextMatchIndex = normalizedText.indexOf(normalizedQuery, cursor);
        if (nextMatchIndex === -1) {
          if (cursor < text.length) {
            matchNodes.push(...renderTextWithLineBreaks(text.slice(cursor), `${keyPrefix}-tail-${matchIndex}`));
          }
          break;
        }

        if (nextMatchIndex > cursor) {
          matchNodes.push(...renderTextWithLineBreaks(text.slice(cursor, nextMatchIndex), `${keyPrefix}-text-${matchIndex}`));
        }

        matchNodes.push(
          <mark className="reader-search-match-inline" key={`${keyPrefix}-match-${matchIndex}`}>
            {text.slice(nextMatchIndex, nextMatchIndex + activeSearchQuery.length)}
          </mark>
        );

        cursor = nextMatchIndex + activeSearchQuery.length;
        matchIndex += 1;
      }

      return matchNodes.length > 0 ? matchNodes : renderTextWithLineBreaks(text, `${keyPrefix}-fallback`);
    };

    return segments.map((segment, index) => {
      if (!segment.highlight) {
        return renderSearchMatches(segment.text, `${paragraph.paragraphId}-text-${index}`);
      }

      const linkedNote = notesByHighlightId.get(segment.highlight.highlightId) ?? null;

      return (
        <span
          className={highlightClassName(segment.highlight.color)}
          data-highlight-id={segment.highlight.highlightId}
          data-note-id={linkedNote?.noteId}
          key={`${paragraph.paragraphId}-highlight-${index}`}
        >
          {renderSearchMatches(segment.text, `${paragraph.paragraphId}-highlight-${index}`)}
        </span>
      );
    });
  }

  const bookTitle = pageQuery.data?.book.title ?? "Cargando libro...";
  const bookNotionUrl = pageQuery.data?.book.notionBookUrl?.trim() ?? "";
  const readerSearchParams = new URLSearchParams();
  readerSearchParams.set("bookId", bookId);
  if (pageQuery.data?.book.title) {
    readerSearchParams.set("bookTitle", pageQuery.data.book.title);
  }
  const currentSearchQuery = activeSearchTarget?.query.trim() ?? "";
  if (currentSearchQuery) {
    readerSearchParams.set("q", currentSearchQuery);
  }
  const readerSearchHref = `/search?${readerSearchParams.toString()}`;
  const readerSearchReturnTo = `/books/${bookId}?page=${encodeURIComponent(String(currentPageNumber))}&paragraph=${encodeURIComponent(String(currentParagraphNumber))}`;
  const canEditImportedPage = pageQuery.data?.book.sourceType === "IMAGES" || pageQuery.data?.book.sourceType === "PDF";

  function renderReaderHeaderActionButtons(buttonClassName: string, onAction?: () => void) {
    const deleteButtonClassName = buttonClassName.includes("reader-header-floating-action-button")
      ? "danger-button reader-header-icon-button reader-header-floating-action-button"
      : "danger-button reader-header-icon-button";
    const bookmarkButtonClassName = isCurrentPageBookmarked
      ? `${buttonClassName} active`
      : buttonClassName;

    return (
      <>
        <Link
          aria-label={isReturningToGlobalSearch ? "Volver a la búsqueda global" : "Volver a la estantería"}
          className={buttonClassName}
          onClick={onAction}
          title={isReturningToGlobalSearch ? "Volver a la búsqueda global" : "Volver a la estantería"}
          to={isReturningToGlobalSearch ? readerReturnTo : "/"}
        >
          {isReturningToGlobalSearch ? <BackIcon /> : <ShelfIcon />}
        </Link>
        <Link
          aria-label="Buscar dentro del libro"
          className={buttonClassName}
          onClick={onAction}
          state={{ returnTo: readerSearchReturnTo }}
          title="Buscar dentro del libro"
          to={readerSearchHref}
        >
          <SearchIcon />
        </Link>
        <button
          aria-label={isCurrentPageBookmarked ? "Quitar marcador de la página" : "Guardar marcador de la página"}
          className={bookmarkButtonClassName}
          data-bookmark-animation={bookmarkAnimationState ?? undefined}
          disabled={!currentParagraphs.length}
          onClick={() => {
            onAction?.();
            void handleToggleBookmark();
          }}
          title={isCurrentPageBookmarked ? "Quitar marcador de la página" : "Guardar marcador de la página"}
          type="button"
        >
          {isCurrentPageBookmarked ? <BookmarkIcon /> : <BookmarkOutlineIcon />}
        </button>
        {bookNotionUrl ? (
          <a
            aria-label="Abrir libro en Notion"
            className={buttonClassName}
            href={bookNotionUrl}
            onClick={onAction}
            rel="noreferrer noopener"
            target="_blank"
            title="Abrir libro en Notion"
          >
            <NotionIcon />
          </a>
        ) : null}
        {pageQuery.data?.book.sourceType === "IMAGES" ? (
          <Link
            aria-label="Añadir páginas"
            className={buttonClassName}
            onClick={onAction}
            title="Añadir páginas"
            to={appendPagesLink}
          >
            <AddPagesIcon />
          </Link>
        ) : null}
        {canEditImportedPage ? (
          <Link
            aria-label="Editar esta página"
            className={buttonClassName}
            onClick={onAction}
            state={{ returnTo: `/books/${bookId}?page=${currentPageNumber}` }}
            title="Editar esta página"
            to={reviewOcrLink}
          >
            <OriginalPageIcon />
          </Link>
        ) : null}
        {pageQuery.data?.book.sourceType === "IMAGES" ? (
          <button
            aria-label={isDeletingPage ? "Borrando página" : "Borrar página"}
            className={deleteButtonClassName}
            disabled={isDeletingPage}
            onClick={() => {
              onAction?.();
              void handleDeleteCurrentPage();
            }}
            title={isDeletingPage ? "Borrando página..." : "Borrar página"}
            type="button"
          >
            <DeletePageIcon />
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div className="page-grid reader-layout reader-floating-layout">
      <section className="panel wide-panel" ref={readerPanelRef}>
        <div className="panel-header">
          <div className="reader-header-copy">
            <p className="eyebrow">Lectura</p>
            <h2>{bookTitle}</h2>
            {activeChapterTitle ? <p className="reader-chapter-title">{activeChapterTitle}</p> : null}
          </div>
          <div className="reader-header-actions" ref={headerActionsRef}>
            {renderReaderHeaderActionButtons("secondary-button link-button reader-header-icon-button")}
          </div>
        </div>

        <div className="reader-canvas">
          <div className="reader-split">
            <div className={pageTurnDirection ? `reader-page-turn reader-page-turn-${pageTurnDirection}` : "reader-page-turn"}>
              <div className={pageTurnDirection ? `reader-page reader-page-live reader-page-live-animating reader-page-live-animating-${pageTurnDirection}` : "reader-page reader-page-live"} ref={livePageRef}>
                {shouldRenderPageCornerBookmark ? (
                  <div className="reader-page-corner-bookmark" data-animation={bookmarkAnimationState ?? undefined} title="Página marcada">
                    <BookmarkIcon />
                  </div>
                ) : null}
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
          </div>
        </div>
      </section>

      {isFloatingHeaderActionsVisible ? (
        <div
          className={isFloatingHeaderActionsExpanded ? "reader-header-floating-dock open" : "reader-header-floating-dock"}
          ref={floatingHeaderActionsRef}
          style={floatingHeaderDockStyle ?? undefined}
        >
          <div className={isFloatingHeaderActionsExpanded ? "reader-header-floating-dock-panel open" : "reader-header-floating-dock-panel"}>
            {renderReaderHeaderActionButtons(
              "secondary-button link-button reader-header-icon-button reader-header-floating-action-button",
              () => setIsFloatingHeaderActionsExpanded(false)
            )}
          </div>
          <button
            aria-expanded={isFloatingHeaderActionsExpanded}
            aria-label={isFloatingHeaderActionsExpanded ? "Cerrar acciones del encabezado" : "Abrir acciones del encabezado"}
            className="reader-header-floating-toggle"
            onClick={() => setIsFloatingHeaderActionsExpanded((current) => !current)}
            title={isFloatingHeaderActionsExpanded ? "Cerrar acciones" : "Abrir acciones"}
            type="button"
          >
            {isFloatingHeaderActionsExpanded ? <CloseIcon /> : <ActionsMenuIcon />}
          </button>
        </div>
      ) : null}

      {selectionDraft ? (
        <div
          className="reader-selection-popover"
          data-placement={selectionDraft.rect.placement}
          ref={selectionPopoverRef}
          style={{ left: `${selectionDraft.rect.left}px`, maxHeight: `${selectionDraft.rect.maxHeight}px`, top: `${selectionDraft.rect.top}px` }}
        >
          <div className="reader-selection-swatches" role="radiogroup" aria-label="Color del resaltado">
            {HIGHLIGHT_OPTIONS.map((option) => (
              <button
                aria-checked={selectionColor === option.color}
                className={selectionColor === option.color ? `reader-swatch active ${highlightClassName(option.color)}` : `reader-swatch ${highlightClassName(option.color)}`}
                key={option.color}
                onClick={() => setSelectionColor(option.color)}
                role="radio"
                title={option.label}
                type="button"
              >
                <span>{option.label}</span>
              </button>
            ))}
          </div>
          <p className="reader-selection-preview">{selectionDraft.selectedText}</p>
          <label className="reader-note-composer compact">
            <textarea
              onChange={(event) => setSelectionNoteText(event.target.value)}
              placeholder="Nota opcional: añade un apunte sobre este fragmento."
              rows={3}
              value={selectionNoteText}
            />
          </label>
          <div className="reader-selection-actions">
            <button
              className="secondary-button"
              onClick={() => {
                setSelectionDraft(null);
                setSelectionNoteText("");
                window.getSelection()?.removeAllRanges();
              }}
              type="button"
            >
              Cancelar
            </button>
            <button className="primary-button" disabled={isSavingSelection} onClick={() => void handleSaveSelection()} type="button">
              {isSavingSelection ? "Guardando..." : "Guardar resaltado"}
            </button>
          </div>
        </div>
      ) : null}

      {activeReaderNote ? (
        <div
          className="reader-existing-note-popover"
          data-placement={activeReaderNote.rect.placement}
          ref={readerNotePopoverRef}
          style={{ left: `${activeReaderNote.rect.left}px`, maxHeight: `${activeReaderNote.rect.maxHeight}px`, top: `${activeReaderNote.rect.top}px` }}
        >
          <div className="reader-existing-note-header">
            <span className={activeReaderNote.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(activeReaderNote.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
            {activeReaderNote.noteId ? <strong>Nota vinculada</strong> : null}
          </div>
          {activeReaderNote.noteId && activeReaderNote.color ? (
            <div aria-label="Color del resaltado" className="reader-selection-swatches" role="radiogroup">
              {HIGHLIGHT_OPTIONS.map((option) => (
                <button
                  aria-checked={activeReaderNote.color === option.color}
                  className={activeReaderNote.color === option.color ? `reader-swatch active ${highlightClassName(option.color)}` : `reader-swatch ${highlightClassName(option.color)}`}
                  disabled={isUpdatingNote}
                  key={option.color}
                  onClick={() => {
                    setActiveReaderNote((current) => current
                      ? {
                          ...current,
                          color: option.color
                        }
                      : current);
                  }}
                  role="radio"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="reader-selection-preview">{activeReaderNote.selectedText}</p>
          <label className="reader-note-composer compact">
            <textarea
              onChange={(event) => setActiveReaderNoteText(event.target.value)}
              placeholder={activeReaderNote.noteId ? "Escribe para actualizar esta nota." : "Nota opcional: añade un apunte sobre este fragmento."}
              rows={4}
              value={activeReaderNoteText}
            />
          </label>
          <div className="reader-note-editor-actions">
            <button
              aria-label="Cerrar nota"
              className="reader-note-icon-button"
              onClick={() => {
                setActiveReaderNote(null);
                setActiveReaderNoteText("");
              }}
              title="Cerrar"
              type="button"
            >
              <CloseIcon />
            </button>
            <button
              aria-label={activeReaderNote.noteId ? "Guardar nota editada" : "Guardar nueva nota"}
              className="reader-note-icon-button primary"
              disabled={isUpdatingNote || !activeReaderNoteText.trim()}
              onClick={() => activeReaderNote.noteId
                ? void handleUpdateExistingNote(activeReaderNote.noteId, activeReaderNoteText, "reader", activeReaderNote.color ?? undefined)
                : void handleCreateNoteForHighlight(activeReaderNote.highlightId, activeReaderNoteText, "reader")}
              title={activeReaderNote.noteId ? "Guardar cambios" : "Guardar nota"}
              type="button"
            >
              <SaveIcon />
            </button>
          </div>
        </div>
      ) : null}

      <div aria-label="Controles flotantes del lector" className="reader-floating-controls" role="toolbar">
        <ReaderFloatingAudioPopover
          buttonLabel="Opciones de audio"
          isOpen={isAudioSettingsVisible}
          menuRef={audioSettingsRef}
          onToggle={() => setIsAudioSettingsVisible((current) => !current)}
          panelId="reader-audio-settings-panel"
        >
          <ReaderAudioSettingsContent
            deepgramBalanceErrorMessage={deepgramBalanceQuery.isError ? deepgramBalanceErrorMessage : null}
            deepgramBalanceLoading={deepgramBalanceQuery.isLoading}
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
            onOutlineEditClick={closeNavigationPanel}
            outlineEditHref={`/books/${bookId}/outline/edit`}
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
            onSaveHighlightNote={(highlightId, noteText) => void handleCreateNoteForHighlight(highlightId, noteText, "navigation")}
            onSaveNote={(noteId, noteText, color) => void handleUpdateExistingNote(noteId, noteText, "navigation", color ?? undefined)}
            onSelectBookmark={(item) => handleNavigationPanelSelection(item.pageNumber, item.paragraphNumber)}
            onSelectHighlight={(item) => handleNavigationPanelSelection(item.pageNumber, item.paragraphNumber)}
            onSelectNote={(item) => handleNavigationPanelSelection(item.pageNumber, item.paragraphNumber)}
            onSelectToc={(item) => handleNavigationPanelSelection(item.pageNumber, item.paragraphNumber)}
            onSummaryClick={closeNavigationPanel}
            onToggleNoteExpansion={(noteId) => setExpandedNavigationNoteId((current) => current === noteId ? null : noteId)}
            summaryHrefBuilder={(targetChapterId) => sectionSummaryHref(bookId, targetChapterId)}
          />
        </ReaderNavigationPopover>
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
          disabled={!canGoToPreviousParagraph}
          onClick={() => void goToParagraph(-1)}
          title={isSavingProgress ? "Guardando progreso" : "Párrafo anterior"}
          type="button"
        >
          <ParagraphPreviousIcon />
        </button>
        <button
          aria-label={isAudioLoading ? (selectedTtsEngine === "device" ? "Preparando voz" : "Generando audio") : "Reproducir"}
          className={isAudioLoading ? "reader-float-button primary is-loading" : "reader-float-button primary"}
          disabled={!currentParagraph || isAudioLoading}
          onClick={() => void handlePlay()}
          title={isAudioLoading ? (selectedTtsEngine === "device" ? "Preparando voz" : "Generando audio") : "Reproducir"}
          type="button"
        >
          {isAudioLoading ? <LoadingAudioIcon /> : <PlayIcon />}
        </button>
        <button
          aria-label="Pausar"
          className="reader-float-button"
          disabled={!hasActivePlaybackSession}
          onClick={() => handlePause()}
          title="Pausar"
          type="button"
        >
          <PauseIcon />
        </button>
        <button
          aria-label="Párrafo siguiente"
          className="reader-float-button"
          disabled={!canGoToNextParagraph}
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
