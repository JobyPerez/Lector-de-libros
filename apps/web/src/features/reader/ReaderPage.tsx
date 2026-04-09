import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

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
const AUDIO_BLOCK_QUEUE_SIZE = 2;
const AUDIO_RAMP_FIRST_BLOCK_PARAGRAPH_COUNT = 1;
const AUDIO_BLOCK_FALLBACK_DURATION_MS = 18_000;
const READER_NOTE_POPOVER_HEIGHT_ESTIMATE_PX = 340;

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
  paragraphCount: number;
  paragraphTimings: TimedAudioBlockParagraph[];
  startSequenceNumber: number;
  voiceModel: string;
};

type NavigationListItem =
  | {
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
    placement: "above" | "below";
    top: number;
  };
  selectedText: string;
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

  const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : AUDIO_BLOCK_FALLBACK_DURATION_MS;
  const paragraphWeights = paragraphs.map((paragraph) => Math.max(paragraph.textLength, 48));
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

function NavigationIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5.5 7.25H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 12H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 16.75H14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="17.5" cy="16.75" fill="currentColor" r="1.2" />
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

function applyHighlightsToRichParagraph(paragraphElement: HTMLElement, highlights: ReaderHighlight[]) {
  if (typeof document === "undefined" || highlights.length === 0) {
    return;
  }

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(paragraphElement, NodeFilter.SHOW_TEXT);
  let nextNode = walker.nextNode();

  while (nextNode) {
    if (nextNode.textContent) {
      textNodes.push(nextNode as Text);
    }

    nextNode = walker.nextNode();
  }

  let cursor = 0;

  for (const textNode of textNodes) {
    const textValue = textNode.data;
    const nodeStart = cursor;
    const nodeEnd = cursor + textValue.length;
    const localHighlights = highlights
      .filter((highlight) => highlight.charStart < nodeEnd && highlight.charEnd > nodeStart)
      .map((highlight) => ({
        charEnd: Math.min(textValue.length, highlight.charEnd - nodeStart),
        charStart: Math.max(0, highlight.charStart - nodeStart),
        color: highlight.color,
        highlightId: highlight.highlightId
      }));

    if (localHighlights.length > 0) {
      const fragment = document.createDocumentFragment();
      const segments = buildTextSegments(textValue, localHighlights);

      for (const segment of segments) {
        if (!segment.highlight) {
          fragment.append(document.createTextNode(segment.text));
          continue;
        }

        const span = document.createElement("span");
        span.className = highlightClassName(segment.highlight.color);
        span.dataset.highlightId = segment.highlight.highlightId;
        span.textContent = segment.text;
        fragment.append(span);
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    cursor = nodeEnd;
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
  const rect = range.getBoundingClientRect();

  if (charEnd <= charStart || !selectedText || rect.width === 0) {
    return null;
  }

  return {
    charEnd,
    charStart,
    paragraph,
    rect: {
      left: rect.left + (rect.width / 2),
      top: Math.max(72, rect.top)
    },
    selectedText
  };
}

function formatRelativeAnchor(pageNumber: number, paragraphNumber: number | null | undefined) {
  return paragraphNumber ? `Pág. ${pageNumber} · párr. ${paragraphNumber}` : `Pág. ${pageNumber}`;
}

function formatPageAnchor(pageNumber: number) {
  return `Pág. ${pageNumber}`;
}

function notePreview(note: ReaderNote) {
  const sourceExcerpt = note.highlightedText?.trim();
  if (sourceExcerpt) {
    return sourceExcerpt;
  }

  return note.noteText;
}

function highlightPreview(highlight: ReaderHighlight) {
  return highlight.highlightedText.trim();
}

function resolveReaderNotePopoverPlacement(anchorRect: DOMRect) {
  if (anchorRect.top <= READER_NOTE_POPOVER_HEIGHT_ESTIMATE_PX) {
    return {
      placement: "below" as const,
      top: anchorRect.bottom
    };
  }

  return {
    placement: "above" as const,
    top: Math.max(72, anchorRect.top)
  };
}

function tocEntryKey(entry: ReaderTocEntry) {
  return `${entry.pageNumber}:${entry.paragraphNumber}:${entry.title}`;
}

function AddPagesIcon() {
  return (
    <ReaderControlIcon>
      <path d="M12 7V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M7 12H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
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
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function OriginalPageIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5.75 18.25L9.25 17.5L17.9 8.85C18.4858 8.26421 18.4858 7.31446 17.9 6.72868L17.2713 6.1C16.6855 5.51421 15.7358 5.51421 15.15 6.1L6.5 14.75L5.75 18.25Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M14.5 6.75L17.25 9.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 17.5L6.5 15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ReaderControlIcon>
  );
}

export function ReaderPage() {
  const { bookId = "" } = useParams();
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
  const [isNavigationPanelVisible, setIsNavigationPanelVisible] = useState(false);
  const [expandedNavigationNoteId, setExpandedNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteId, setEditingNavigationNoteId] = useState<string | null>(null);
  const [editingNavigationNoteText, setEditingNavigationNoteText] = useState("");
  const [editingNavigationHighlightId, setEditingNavigationHighlightId] = useState<string | null>(null);
  const [editingNavigationHighlightText, setEditingNavigationHighlightText] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [selectionColor, setSelectionColor] = useState<HighlightColor>("YELLOW");
  const [selectionNoteText, setSelectionNoteText] = useState("");
  const [isSavingSelection, setIsSavingSelection] = useState(false);
  const [quickNoteText, setQuickNoteText] = useState("");
  const [isSavingQuickNote, setIsSavingQuickNote] = useState(false);
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
  const paragraphRefs = useRef(new Map<number, HTMLParagraphElement>());
  const richContentRef = useRef<HTMLDivElement | null>(null);
  const livePageRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelRef = useRef<HTMLDivElement | null>(null);
  const selectionPopoverRef = useRef<HTMLDivElement | null>(null);
  const readerNotePopoverRef = useRef<HTMLDivElement | null>(null);
  const activeNavigationItemRef = useRef<HTMLButtonElement | null>(null);
  const pendingParagraphTargetRef = useRef<number | "last" | null>(null);
  const pendingParagraphScrollRef = useRef<number | null>(null);
  const deviceAdvanceTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<ReaderWakeLockSentinel | null>(null);
  const requestedPageParam = searchParams.get("page")?.trim() ?? "";
  const requestedPageNumber = requestedPageParam ? Number(requestedPageParam) : Number.NaN;

  useEffect(() => {
    progressHydratedRef.current = false;
    audioBlockModeAvailableRef.current = true;
    lastPersistedProgressRef.current = null;
    currentPageNumberRef.current = 1;
    currentParagraphNumberRef.current = 1;
    setPendingPageTurnDirection(null);
    setPageTurnDirection(null);
    setPageTurnSnapshot(null);
    setCurrentPageNumber(1);
    setCurrentParagraphNumber(1);
  }, [bookId]);

  useEffect(() => {
    currentPageNumberRef.current = currentPageNumber;
  }, [currentPageNumber]);

  useEffect(() => {
    currentParagraphNumberRef.current = currentParagraphNumber;
  }, [currentParagraphNumber]);

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

      if (selectedTtsEngine !== "device" || !isAudioPlaying) {
        return;
      }

      void ensureScreenWakeLock();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAudioPlaying, selectedTtsEngine]);

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
  const currentHtmlContent = pageQuery.data?.page.htmlContent ?? null;
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

  const activeTocEntryKey = useMemo(() => {
    const tocEntries = navigationQuery.data?.toc ?? [];
    let activeEntry: ReaderTocEntry | null = null;

    for (const entry of tocEntries) {
      const isBeforeCurrentPage = entry.pageNumber < currentPageNumber;
      const isCurrentPageEntry = entry.pageNumber === currentPageNumber && entry.paragraphNumber <= currentParagraphNumber;
      if (isBeforeCurrentPage || isCurrentPageEntry) {
        activeEntry = entry;
      }
    }

    return activeEntry ? tocEntryKey(activeEntry) : null;
  }, [currentPageNumber, currentParagraphNumber, navigationQuery.data?.toc]);

  const orderedNavigationItems = useMemo<NavigationListItem[]>(() => {
    const tocItems: NavigationListItem[] = (navigationQuery.data?.toc ?? []).map((entry) => ({
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

    richContentRef.current.innerHTML = currentHtmlContent;
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
      node.classList.toggle("active", paragraphNumber === effectiveCurrentParagraphNumber);

      const noteCount = noteCountsByParagraphId.get(paragraph.paragraphId) ?? 0;
      node.classList.toggle("has-note", noteCount > 0);
      if (noteCount > 0) {
        node.dataset.noteCount = String(noteCount);
      } else {
        delete node.dataset.noteCount;
      }

      applyHighlightsToRichParagraph(node, highlightsByParagraphId.get(paragraph.paragraphId) ?? []);
      node.querySelectorAll<HTMLElement>("[data-highlight-id]").forEach((highlightElement) => {
        const highlightId = highlightElement.dataset.highlightId;
        const note = highlightId ? notesByHighlightId.get(highlightId) ?? null : null;
        if (note) {
          highlightElement.dataset.noteId = note.noteId;
          return;
        }

        delete highlightElement.dataset.noteId;
      });
      paragraphRefs.current.set(paragraphNumber, node as HTMLParagraphElement);
    });
  }, [currentHtmlContent, currentPageNumber, currentParagraphs, effectiveCurrentParagraphNumber, hasRichPageContent, highlightsByParagraphId, noteCountsByParagraphId, notesByHighlightId]);

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

    function handleSelectionChange() {
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

    document.addEventListener("mouseup", handleSelectionChange);
    document.addEventListener("keyup", handleSelectionChange);
    document.addEventListener("touchend", handleSelectionChange);

    return () => {
      document.removeEventListener("mouseup", handleSelectionChange);
      document.removeEventListener("keyup", handleSelectionChange);
      document.removeEventListener("touchend", handleSelectionChange);
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

      setIsNavigationPanelVisible(false);
      setSelectionDraft(null);
      setSelectionNoteText("");
      setActiveReaderNote(null);
      setActiveReaderNoteText("");
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setIsNavigationPanelVisible(false);
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
      const popoverPlacement = resolveReaderNotePopoverPlacement(rect);
      setSelectionDraft(null);
      setSelectionNoteText("");
      setActiveReaderNote({
        color: note?.highlightColor ?? highlight.color,
        highlightId,
        noteId: note?.noteId ?? null,
        rect: {
          left: rect.left + (rect.width / 2),
          placement: popoverPlacement.placement,
          top: popoverPlacement.top
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
    if (selectedTtsEngine !== "device") {
      return;
    }

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

  function clearAudioResource(options: { cancelDeviceSpeech?: boolean; invalidatePlayback?: boolean } = {}) {
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
    audioRef.current?.pause();
    audioRef.current = null;
    activeAudioBlockRef.current = null;
    setIsAudioPlaying(false);
    setHasActivePlaybackSession(false);
    void releaseScreenWakeLock();

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
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

  function findActiveAudioBlockParagraph(sequenceNumber: number) {
    return activeAudioBlockRef.current?.paragraphTimings.find(
      (paragraphTiming) => paragraphTiming.sequenceNumber === sequenceNumber
    ) ?? null;
  }

  async function jumpWithinActiveAudioBlock(paragraph: ParagraphContent) {
    const audioElement = audioRef.current;
    const paragraphTiming = findActiveAudioBlockParagraph(paragraph.sequenceNumber);
    if (!audioElement || !paragraphTiming) {
      return false;
    }

    const shouldKeepPlaying = !audioElement.paused;
    audioElement.currentTime = paragraphTiming.startMs / 1000;
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
      node.classList.toggle("active", Number.isInteger(paragraphNumber) && paragraphNumber === activeParagraphNumber);
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

    if (!targetParagraph || !audioBlock.blob) {
      throw new Error("No se pudo localizar el párrafo dentro del bloque de audio.");
    }

    ensureQueuedAudioBlocks(
      audioBlock.startSequenceNumber + audioBlock.paragraphs.length,
      voiceModel,
      getNextAudioBlockParagraphCount(audioBlock.paragraphs.length)
    );

    const audioUrl = audioBlock.audioUrl ?? URL.createObjectURL(audioBlock.blob);
    audioUrlRef.current = audioUrl;

    const audioElement = audioBlock.audioElement ?? new Audio(audioUrl);
    audioRef.current = audioElement;
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
    const targetParagraphTiming = paragraphTimings.find(
      (timing) => timing.sequenceNumber === targetParagraph.sequenceNumber
    ) ?? paragraphTimings[0];

    if (!targetParagraphTiming) {
      throw new Error("No se pudo calcular la posición del bloque de audio.");
    }

    activeAudioBlockRef.current = {
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

      const activeParagraphTiming = findParagraphTimingForTime(activeAudioBlock.paragraphTimings, audioElement.currentTime * 1000);
      if (activeParagraphTiming) {
        syncReaderLocationFromBlockParagraph(activeParagraphTiming);
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
    await audioElement.play();
  }

  async function playQueuedAudioBlock(startSequenceNumber: number, voiceModel: string, paragraphCount = AUDIO_BLOCK_PARAGRAPH_COUNT) {
    const playbackAttempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = playbackAttempt;
    setReaderError(null);
    setIsAudioLoading(true);

    try {
      clearAudioResource({ invalidatePlayback: false });
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

      const audioElement = new Audio(audioUrl);
      audioRef.current = audioElement;
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

      const audioElement = new Audio(audioUrl);
      audioRef.current = audioElement;
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
      if (currentBookmarks.length > 0) {
        await Promise.all(currentBookmarks.map((bookmark) => deleteBookmark(accessToken, bookId, bookmark.bookmarkId)));
      } else {
        const bookmarkParagraph = currentParagraph ?? currentParagraphs[0] ?? null;
        if (!bookmarkParagraph) {
          return;
        }

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

  async function handleCreateQuickNote() {
    if (!accessToken || !quickNoteText.trim()) {
      return;
    }

    setIsSavingQuickNote(true);
    setReaderError(null);

    try {
      await createNote(accessToken, bookId, currentParagraph
        ? { noteText: quickNoteText.trim(), paragraphId: currentParagraph.paragraphId }
        : { noteText: quickNoteText.trim(), pageNumber: currentPageNumber });
      setQuickNoteText("");
      await refreshReaderMetadata();
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo guardar la nota.");
    } finally {
      setIsSavingQuickNote(false);
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
        setExpandedNavigationNoteId(note.noteId);
      } else {
        setActiveReaderNote((current) => current
          ? {
              ...current,
              noteId: note.noteId
            }
          : current);
        setActiveReaderNoteText(trimmedNoteText);
      }
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo guardar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
  }

  async function handleUpdateExistingNote(noteId: string, noteText: string, source: "navigation" | "reader") {
    if (!accessToken || !noteText.trim()) {
      return;
    }

    setIsUpdatingNote(true);
    setReaderError(null);

    try {
      const trimmedNoteText = noteText.trim();
      await updateNote(accessToken, bookId, noteId, { noteText: trimmedNoteText });
      await refreshReaderMetadata();

      setActiveReaderNote((current) => current?.noteId === noteId
        ? {
            ...current
          }
        : current);

      if (source === "navigation") {
        setEditingNavigationNoteId(null);
        setEditingNavigationNoteText("");
        setExpandedNavigationNoteId(noteId);
      } else {
        setActiveReaderNoteText(trimmedNoteText);
      }
    } catch (error) {
      setReaderError(error instanceof Error ? error.message : "No se pudo actualizar la nota.");
    } finally {
      setIsUpdatingNote(false);
    }
  }

  function beginNavigationNoteEditing(note: Pick<ReaderNote, "noteId" | "noteText">) {
    setExpandedNavigationNoteId(note.noteId);
    setEditingNavigationHighlightId(null);
    setEditingNavigationHighlightText("");
    setEditingNavigationNoteId(note.noteId);
    setEditingNavigationNoteText(note.noteText);
  }

  function beginNavigationHighlightEditing(highlightId: string) {
    setExpandedNavigationNoteId(null);
    setEditingNavigationNoteId(null);
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

    return segments.map((segment, index) => {
      if (!segment.highlight) {
        return <span key={`${paragraph.paragraphId}-text-${index}`}>{segment.text}</span>;
      }

      const linkedNote = notesByHighlightId.get(segment.highlight.highlightId) ?? null;

      return (
        <span
          className={highlightClassName(segment.highlight.color)}
          data-highlight-id={segment.highlight.highlightId}
          data-note-id={linkedNote?.noteId}
          key={`${paragraph.paragraphId}-highlight-${index}`}
        >
          {segment.text}
        </span>
      );
    });
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
            <Link aria-label="Volver a la estantería" className="secondary-button link-button reader-header-icon-button" title="Volver a la estantería" to="/">
              <ShelfIcon />
            </Link>
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <Link aria-label="Añadir páginas" className="secondary-button link-button reader-header-icon-button" title="Añadir páginas" to={appendPagesLink}>
                <AddPagesIcon />
              </Link>
            ) : null}
            {pageQuery.data?.book.sourceType === "IMAGES" ? (
              <Link
                aria-label="Editar OCR de esta página"
                className="secondary-button link-button reader-header-icon-button"
                state={{ returnTo: `/books/${bookId}?page=${currentPageNumber}` }}
                title="Editar OCR de esta página"
                to={reviewOcrLink}
              >
                <OriginalPageIcon />
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
          </div>
        </div>

        <div className="reader-canvas">
          <div className="reader-split">
            <div className={pageTurnDirection ? `reader-page-turn reader-page-turn-${pageTurnDirection}` : "reader-page-turn"}>
              <div className={pageTurnDirection ? `reader-page reader-page-live reader-page-live-animating reader-page-live-animating-${pageTurnDirection}` : "reader-page reader-page-live"} ref={livePageRef}>
                {isCurrentPageBookmarked ? (
                  <div className="reader-page-corner-bookmark" title="Página marcada">
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

      {isNavigationPanelVisible ? (
        <aside aria-label="Índice, marcadores y notas" className="reader-navigation-panel" ref={navigationPanelRef}>
          <div className="reader-navigation-header">
            <div>
              <p className="eyebrow">Navegación</p>
              <h3>Índice y notas</h3>
            </div>
            <button
              aria-label="Cerrar panel de navegación"
              className="reader-icon-ghost"
              onClick={() => setIsNavigationPanelVisible(false)}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>

          <section className="reader-navigation-section">
            <div className="reader-navigation-section-heading">
              <strong>Índice del libro</strong>
              <span>{orderedNavigationItems.length}</span>
            </div>
            {orderedNavigationItems.length ? (
              <div className="reader-navigation-list">
                {orderedNavigationItems.map((item) => {
                  if (item.type === "toc") {
                    return (
                      <button
                        className={item.isActive ? "reader-navigation-item active" : "reader-navigation-item"}
                        key={item.key}
                        onClick={() => {
                          void goToLocation(item.pageNumber, item.paragraphNumber);
                          setIsNavigationPanelVisible(false);
                        }}
                        ref={item.isActive
                          ? (element) => {
                              activeNavigationItemRef.current = element;
                            }
                          : undefined}
                        style={{ "--toc-level": String(Math.max(0, item.level - 1)) } as CSSProperties}
                        type="button"
                      >
                        <div className="reader-navigation-item-topline">
                          <strong>{item.title}</strong>
                          <span className="reader-navigation-inline-meta">{formatPageAnchor(item.pageNumber)}</span>
                        </div>
                      </button>
                    );
                  }

                  if (item.type === "bookmark") {
                    return (
                      <article className={item.isActive ? "reader-note-card reader-navigation-item-bookmark-card active" : "reader-note-card reader-navigation-item-bookmark-card"} key={item.key}>
                        <button
                          className="reader-navigation-item reader-navigation-item-bookmark"
                          onClick={() => {
                            void goToLocation(item.pageNumber, item.paragraphNumber);
                            setIsNavigationPanelVisible(false);
                          }}
                          ref={item.isActive
                            ? (element) => {
                                activeNavigationItemRef.current = element;
                              }
                            : undefined}
                          type="button"
                        >
                          <div className="reader-navigation-item-topline">
                            <span className="reader-navigation-chip reader-navigation-chip-bookmark"><BookmarkIcon /></span>
                            <strong>{item.title}</strong>
                            <span className="reader-navigation-inline-meta">{formatPageAnchor(item.pageNumber)}</span>
                          </div>
                        </button>
                        <div className="reader-note-actions">
                          <button
                            aria-label="Borrar marcador"
                            className="reader-note-delete"
                            onClick={() => void handleDeleteSavedBookmark(item.bookmarkId)}
                            title="Borrar marcador"
                            type="button"
                          >
                            <DeletePageIcon />
                          </button>
                        </div>
                      </article>
                    );
                  }

                  if (item.type === "highlight") {
                    const isHighlightEditing = editingNavigationHighlightId === item.highlightId;

                    return (
                      <article className={item.isActive ? "reader-note-card reader-navigation-item-note reader-navigation-note-entry active" : "reader-note-card reader-navigation-item-note reader-navigation-note-entry"} key={item.key}>
                        <button
                          className="reader-note-jump"
                          onClick={() => {
                            void goToLocation(item.pageNumber, item.paragraphNumber);
                            setIsNavigationPanelVisible(false);
                          }}
                          ref={item.isActive
                            ? (element) => {
                                activeNavigationItemRef.current = element;
                              }
                            : undefined}
                          type="button"
                        >
                          <div className="reader-navigation-item-topline">
                            <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
                            <strong>{item.excerpt}</strong>
                            <span className="reader-navigation-inline-meta">{formatRelativeAnchor(item.pageNumber, item.paragraphNumber)}</span>
                          </div>
                        </button>
                        <div className="reader-note-actions">
                          <button
                            aria-label="Añadir nota al resaltado"
                            className={isHighlightEditing ? "reader-note-icon-button active" : "reader-note-icon-button"}
                            onClick={() => beginNavigationHighlightEditing(item.highlightId)}
                            title="Añadir nota"
                            type="button"
                          >
                            <EditIcon />
                          </button>
                          <button
                            aria-label="Borrar resaltado"
                            className="reader-note-delete"
                            onClick={() => void handleDeleteSavedHighlight(item.highlightId)}
                            title="Borrar resaltado"
                            type="button"
                          >
                            <DeletePageIcon />
                          </button>
                        </div>
                        {isHighlightEditing ? (
                          <div className="reader-note-editor">
                            <label className="reader-note-composer compact">
                              <textarea
                                onChange={(event) => setEditingNavigationHighlightText(event.target.value)}
                                rows={4}
                                value={editingNavigationHighlightText}
                              />
                            </label>
                            <div className="reader-note-editor-actions">
                              <button
                                aria-label="Cancelar edición del resaltado"
                                className="reader-note-icon-button"
                                onClick={() => {
                                  setEditingNavigationHighlightId(null);
                                  setEditingNavigationHighlightText("");
                                }}
                                title="Cancelar"
                                type="button"
                              >
                                <CloseIcon />
                              </button>
                              <button
                                aria-label="Guardar nota del resaltado"
                                className="reader-note-icon-button primary"
                                disabled={isUpdatingNote || !editingNavigationHighlightText.trim()}
                                onClick={() => void handleCreateNoteForHighlight(item.highlightId, editingNavigationHighlightText, "navigation")}
                                title="Guardar nota"
                                type="button"
                              >
                                <SaveIcon />
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  }

                  const isNoteExpanded = expandedNavigationNoteId === item.noteId;
                  const isNoteEditing = editingNavigationNoteId === item.noteId;
                  const hasNoteText = item.noteText.trim().length > 0;

                  return (
                    <article className={item.isActive ? "reader-note-card reader-navigation-item-note reader-navigation-note-entry active" : "reader-note-card reader-navigation-item-note reader-navigation-note-entry"} key={item.key}>
                      <button
                        className="reader-note-jump"
                        onClick={() => {
                          void goToLocation(item.pageNumber, item.paragraphNumber);
                          setIsNavigationPanelVisible(false);
                        }}
                        ref={item.isActive
                          ? (element) => {
                              activeNavigationItemRef.current = element;
                            }
                          : undefined}
                        type="button"
                      >
                        <div className="reader-navigation-item-topline">
                          <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
                          <strong>{item.excerpt}</strong>
                          <span className="reader-navigation-inline-meta">{formatRelativeAnchor(item.pageNumber, item.paragraphNumber)}</span>
                        </div>
                      </button>
                      <div className="reader-note-actions">
                        {hasNoteText ? (
                          <button
                            aria-expanded={isNoteExpanded}
                            aria-label={isNoteExpanded ? "Ocultar contenido de la nota" : "Mostrar contenido de la nota"}
                            className="reader-note-icon-button"
                            onClick={() => setExpandedNavigationNoteId((current) => current === item.noteId ? null : item.noteId)}
                            title={isNoteExpanded ? "Ocultar nota" : "Ver nota"}
                            type="button"
                          >
                            <EyeIcon />
                          </button>
                        ) : null}
                        <button
                          aria-label="Editar nota"
                          className={isNoteEditing ? "reader-note-icon-button active" : "reader-note-icon-button"}
                          onClick={() => beginNavigationNoteEditing({ noteId: item.noteId, noteText: item.noteText })}
                          title="Editar nota"
                          type="button"
                        >
                          <EditIcon />
                        </button>
                        <button
                          aria-label="Borrar nota"
                          className="reader-note-delete"
                          onClick={() => void handleDeleteSavedNote(item.noteId)}
                          title="Borrar nota"
                          type="button"
                        >
                          <DeletePageIcon />
                        </button>
                      </div>
                      {isNoteEditing ? (
                        <div className="reader-note-editor">
                          <label className="reader-note-composer compact">
                            <textarea
                              onChange={(event) => setEditingNavigationNoteText(event.target.value)}
                              rows={4}
                              value={editingNavigationNoteText}
                            />
                          </label>
                          <div className="reader-note-editor-actions">
                            <button
                              aria-label="Cancelar edición de la nota"
                              className="reader-note-icon-button"
                              onClick={() => {
                                setEditingNavigationNoteId(null);
                                setEditingNavigationNoteText("");
                              }}
                              title="Cancelar"
                              type="button"
                            >
                              <CloseIcon />
                            </button>
                            <button
                              aria-label="Guardar cambios de la nota"
                              className="reader-note-icon-button primary"
                              disabled={isUpdatingNote || !editingNavigationNoteText.trim()}
                              onClick={() => void handleUpdateExistingNote(item.noteId, editingNavigationNoteText, "navigation")}
                              title="Guardar cambios"
                              type="button"
                            >
                              <SaveIcon />
                            </button>
                          </div>
                        </div>
                      ) : isNoteExpanded ? <p>{item.noteText}</p> : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="reader-navigation-empty">Este libro no trae índice estructurado. Aquí seguirás viendo marcadores y notas.</p>
            )}
          </section>

          <section className="reader-navigation-section">
            <div className="reader-navigation-section-heading">
              <strong>Notas</strong>
              <span>{navigationQuery.data?.notes.length ?? 0}</span>
            </div>
            <label className="reader-note-composer">
              <span>Nueva nota aquí</span>
              <textarea
                onChange={(event) => setQuickNoteText(event.target.value)}
                placeholder="Anota una idea, resumen o recordatorio en el punto actual."
                rows={3}
                value={quickNoteText}
              />
            </label>
            <button
              className="secondary-button"
              disabled={isSavingQuickNote || !quickNoteText.trim()}
              onClick={() => void handleCreateQuickNote()}
              type="button"
            >
              {isSavingQuickNote ? "Guardando nota..." : "Guardar nota"}
            </button>
            <p className="reader-navigation-empty">Las notas y marcadores aparecen integrados dentro del índice según su posición en el libro.</p>
          </section>
        </aside>
      ) : null}

      {selectionDraft ? (
        <div
          className="reader-selection-popover"
          ref={selectionPopoverRef}
          style={{ left: `${selectionDraft.rect.left}px`, top: `${selectionDraft.rect.top}px` }}
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
            <span>Nota opcional</span>
            <textarea
              onChange={(event) => setSelectionNoteText(event.target.value)}
              placeholder="Añade una nota a este fragmento."
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
          style={{ left: `${activeReaderNote.rect.left}px`, top: `${activeReaderNote.rect.top}px` }}
        >
          <div className="reader-existing-note-header">
            <span className={activeReaderNote.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(activeReaderNote.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
            {activeReaderNote.noteId ? <strong>Nota vinculada</strong> : null}
          </div>
          <p className="reader-selection-preview">{activeReaderNote.selectedText}</p>
          <label className="reader-note-composer compact">
            <textarea
              onChange={(event) => setActiveReaderNoteText(event.target.value)}
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
                ? void handleUpdateExistingNote(activeReaderNote.noteId, activeReaderNoteText, "reader")
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
                <span>Motor</span>
                <select
                  onChange={(event) => setSelectedTtsEngine(event.target.value as TtsEngine)}
                  value={selectedTtsEngine}
                >
                  {TTS_ENGINE_OPTIONS.map((engine) => (
                    <option disabled={engine.value === "device" && !isDeviceTtsSupported} key={engine.value} value={engine.value}>
                      {engine.label} · {engine.description}
                    </option>
                  ))}
                </select>
              </label>

              {selectedTtsEngine === "deepgram" ? (
                <>
                  {deepgramBalanceQuery.isLoading ? (
                    <p className="reader-audio-note">Consultando saldo de Deepgram...</p>
                  ) : null}

                  {deepgramBalanceQuery.data ? (
                    <div className="reader-audio-status reader-audio-status-inline">
                      <span>Saldo disponible en Deepgram</span>
                      <strong>{formatUsdBalance(deepgramBalanceQuery.data.balance_usd)}</strong>
                    </div>
                  ) : null}

                  {deepgramBalanceQuery.isError ? (
                    <p className="reader-audio-note">{deepgramBalanceErrorMessage}</p>
                  ) : null}

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
                </>
              ) : (
                <label className="reader-audio-field">
                  <span>Voz del dispositivo</span>
                  <select
                    disabled={!isDeviceTtsSupported}
                    onChange={(event) => setSelectedDeviceVoiceUri(event.target.value)}
                    value={selectedDeviceVoiceUri}
                  >
                    {deviceVoiceOptions.map((voice) => (
                      <option key={voice.value || "device-default"} value={voice.value}>
                        {voice.label} · {voice.description}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {!isDeviceTtsSupported && selectedTtsEngine === "device" ? (
                <p className="reader-audio-note">
                  Este navegador no expone voces nativas. Mantén el modo IA para reproducir audio.
                </p>
              ) : null}

              {selectedTtsEngine === "device" && selectedDeviceVoice ? (
                <p className="reader-audio-note">Voz activa: {selectedDeviceVoice.name} · {selectedDeviceVoice.lang}</p>
              ) : null}

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
          aria-label={isCurrentPageBookmarked ? "Quitar marcador de la página" : "Guardar marcador de la página"}
          className={isCurrentPageBookmarked ? "reader-float-button active" : "reader-float-button"}
          disabled={!currentParagraphs.length}
          onClick={() => void handleToggleBookmark()}
          title={isCurrentPageBookmarked ? "Quitar marcador de la página" : "Guardar marcador de la página"}
          type="button"
        >
          {isCurrentPageBookmarked ? <BookmarkIcon /> : <BookmarkOutlineIcon />}
        </button>
        <button
          aria-expanded={isNavigationPanelVisible}
          aria-label="Abrir panel de índice, marcadores y notas"
          className={isNavigationPanelVisible ? "reader-float-button active" : "reader-float-button"}
          onClick={() => setIsNavigationPanelVisible((current) => !current)}
          title="Índice, marcadores y notas"
          type="button"
        >
          <NavigationIcon />
        </button>
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
          title="Párrafo anterior"
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