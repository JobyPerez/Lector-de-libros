import { Link } from "react-router-dom";
import { type CSSProperties, type MutableRefObject, type ReactNode, type Ref, useEffect, useId, useState } from "react";

import { formatExactDate, formatRelativeDate } from "../../app/date-format";
import { formatSectionTitleWithAncestors } from "../../app/outline-source";
import { ShareWithSelector } from "../../components/ShareWithSelector";

type AudioEngineOption = {
  description: string;
  label: string;
  value: "deepgram" | "device";
};

type AudioVoiceOption = {
  description: string;
  label: string;
  value: string;
};

export type ReaderAudioReadingTimeStats = {
  bookRemainingCostLabel: string | null;
  bookRemainingLabel: string;
  bookRemainingPageCount: number;
  bookTotalCostLabel: string | null;
  bookTotalLabel: string;
  bookTotalPageCount: number;
  chapterRemainingCostLabel: string | null;
  chapterRemainingLabel: string | null;
  chapterRemainingPageCount: number | null;
  chapterTitle: string | null;
  chapterTotalCostLabel: string | null;
  chapterTotalLabel: string | null;
  chapterTotalPageCount: number | null;
};

type ReaderHighlightColor = "YELLOW" | "GREEN" | "BLUE" | "PINK";

const HIGHLIGHT_OPTIONS: Array<{ color: ReaderHighlightColor; label: string }> = [
  { color: "YELLOW", label: "Amarillo" },
  { color: "GREEN", label: "Verde" },
  { color: "BLUE", label: "Azul" },
  { color: "PINK", label: "Rosa" }
];

type AudioPopoverProps = {
  buttonLabel: string;
  buttonTitle?: string;
  children: ReactNode;
  closeLabel?: string;
  isOpen: boolean;
  menuRef?: Ref<HTMLDivElement>;
  onClose?: () => void;
  onToggle: () => void;
  panelId: string;
  title?: string;
};

type AudioSettingsContentProps = {
  deepgramBalanceErrorMessage?: string | null;
  deepgramBalanceLabel?: string;
  deepgramBalanceLoading?: boolean;
  deepgramBalanceValue?: string | null;
  deviceUnsupportedMessage?: string;
  deviceVoiceNote?: string | null;
  deviceVoiceOptions: ReadonlyArray<AudioVoiceOption>;
  engineOptions: ReadonlyArray<AudioEngineOption>;
  isDeviceTtsSupported: boolean;
  maxPlaybackRate: number;
  minPlaybackRate: number;
  onDeviceVoiceChange: (value: string) => void;
  onPlaybackRateChange: (value: number) => void;
  onTtsEngineChange: (value: "deepgram" | "device") => void;
  onVoiceModelChange: (value: string) => void;
  playbackRate: number;
  playbackRateStep: number;
  readingTimeStats?: ReaderAudioReadingTimeStats | null;
  selectedDeviceVoiceUri: string;
  selectedTtsEngine: "deepgram" | "device";
  selectedVoiceModel: string;
  voiceOptions: ReadonlyArray<AudioVoiceOption>;
};

type NavigationPopoverProps = {
  aiRequestsHref?: string;
  aiRequestsLabel?: string;
  onAiRequestsClick?: () => void;
  buttonLabel: string;
  buttonTitle?: string;
  children: ReactNode;
  closeLabel?: string;
  eyebrow?: string;
  isOpen: boolean;
  isRendered: boolean;
  onClose: () => void;
  onToggle: () => void;
  panelAriaLabel: string;
  panelRef?: Ref<HTMLElement>;
  title: string;
};

type NavigationTocCardProps = {
  buttonRef?: ((element: HTMLButtonElement | null) => void) | undefined;
  isActive: boolean;
  isExpanded?: boolean | undefined;
  level: number;
  nestedCount?: number | undefined;
  onSelect: () => void;
  onToggle?: (() => void) | undefined;
  pageNumber: number;
  summaryHref?: string | undefined;
  summaryLabel?: string | undefined;
  onSummaryClick?: (() => void) | undefined;
  title: string;
};

function formatReadingTimeValue(timeLabel: string, costLabel: string | null) {
  return costLabel ? `${timeLabel} / ${costLabel}` : timeLabel;
}

function formatPageCount(pageCount: number) {
  return `${pageCount} ${pageCount === 1 ? "pág." : "págs."}`;
}

function ReadingTimeLabel({ label, pageCount }: { label: string; pageCount: number }) {
  return (
    <dt title={label}>
      <span className="reader-audio-reading-time-label">{label}</span>
      <span className="reader-audio-reading-time-pages">{formatPageCount(pageCount)}</span>
    </dt>
  );
}

export type ReaderNavigationListItem =
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
      authorLabel: string | null;
      bookmarkId: string;
      createdAt: string;
      isActive: boolean;
      isOwnedByCurrentUser: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      sharedWithUserIds: string[];
      title: string;
      type: "bookmark";
      visibilitySource: "OWN" | "DIRECT" | "BOOK";
    }
  | {
      color: ReaderHighlightColor;
      excerpt: string;
      highlightId: string;
      isActive: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      type: "highlight";
    }
  | {
      authorLabel: string | null;
      color: ReaderHighlightColor | null;
      excerpt: string;
      isActive: boolean;
      isReadOnly: boolean;
      key: string;
      noteId: string;
      noteText: string;
      pageNumber: number;
      paragraphNumber: number;
      sharedWithUserIds?: string[];
      type: "note";
    };

type NavigationPanelContentProps = {
  activeItemRef?: MutableRefObject<HTMLButtonElement | null>;
  editingHighlightId: string | null;
  editingHighlightText: string;
  editingNoteId: string | null;
  editingNoteColor: ReaderHighlightColor | null;
  editingNoteText: string;
  expandedNoteId: string | null;
  isUpdatingNote: boolean;
  items: ReaderNavigationListItem[];
  onBeginHighlightEditing: (highlightId: string) => void;
  onBeginNoteEditing: (note: { color: ReaderHighlightColor | null; noteId: string; noteText: string }) => void;
  onCancelHighlightEditing: () => void;
  onCancelNoteEditing: () => void;
  onDeleteBookmark: (bookmarkId: string) => Promise<void>;
  onDeleteHighlight: (highlightId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onEditingNoteColorChange: (value: ReaderHighlightColor) => void;
  onEditingHighlightTextChange: (value: string) => void;
  onEditingNoteTextChange: (value: string) => void;
  onSaveHighlightNote: (highlightId: string, noteText: string) => void;
  onSaveNote: (noteId: string, noteText: string, color: ReaderHighlightColor | null) => void;
  onSelectBookmark: (item: Extract<ReaderNavigationListItem, { type: "bookmark" }>) => void;
  onSelectHighlight: (item: Extract<ReaderNavigationListItem, { type: "highlight" }>) => void;
  onSelectNote: (item: Extract<ReaderNavigationListItem, { type: "note" }>) => void;
  onSelectToc: (item: Extract<ReaderNavigationListItem, { type: "toc" }>) => void;
  onSummaryClick?: () => void;
  onToggleNoteExpansion: (noteId: string) => void;
  onUpdateBookmarkShares: (bookmarkId: string, sharedWithUserIds: string[]) => Promise<void>;
  onUpdateNoteShares?: (noteId: string, sharedWithUserIds: string[]) => Promise<void>;
  sharableUsers: { displayName: string | null; userId: string; username: string }[];
  summaryHrefBuilder?: (chapterId: string) => string;
};

type BookmarkNavigationItem = Extract<ReaderNavigationListItem, { type: "bookmark" }>;
type TocNavigationItem = Extract<ReaderNavigationListItem, { type: "toc" }>;

function annotationLocationLabel(item: { pageNumber: number; paragraphNumber: number }, tocItems: TocNavigationItem[]) {
  const section = tocItems.reduce<TocNavigationItem | null>((currentSection, tocItem) => {
    const startsBeforeAnnotation = tocItem.pageNumber < item.pageNumber
      || (tocItem.pageNumber === item.pageNumber && tocItem.paragraphNumber <= item.paragraphNumber);

    if (!startsBeforeAnnotation) {
      return currentSection;
    }

    if (!currentSection
      || tocItem.pageNumber > currentSection.pageNumber
      || (tocItem.pageNumber === currentSection.pageNumber && tocItem.paragraphNumber >= currentSection.paragraphNumber)) {
      return tocItem;
    }

    return currentSection;
  }, null);

  const sectionTitle = formatSectionTitleWithAncestors(section, tocItems);
  return `Pág. ${item.pageNumber} · ${sectionTitle ? `Sección: ${sectionTitle}` : "Sin sección"}`;
}

function haveSameUserIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((userId) => right.includes(userId));
}

function BookmarkShareEditor({ id, item, onUpdateShares, sharableUsers }: {
  id: string;
  item: BookmarkNavigationItem;
  onUpdateShares: (bookmarkId: string, sharedWithUserIds: string[]) => Promise<void>;
  sharableUsers: { displayName: string | null; userId: string; username: string }[];
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = draft ?? item.sharedWithUserIds;
  const hasChanges = draft !== null && !haveSameUserIds(draft, item.sharedWithUserIds);

  async function handleSave() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await onUpdateShares(item.bookmarkId, selected);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo actualizar con quién se comparte el marcador.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="ai-request-share-editor reader-bookmark-share-editor" id={id}>
      <ShareWithSelector
        disabled={isSaving}
        emptyLabel="Este marcador solo lo verás tú."
        label="Compartido con"
        onChange={(userIds) => {
          setDraft(userIds);
          setError(null);
        }}
        options={sharableUsers}
        selected={selected}
      />
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {hasChanges ? (
        <button
          className="secondary-button ai-request-share-save"
          disabled={isSaving}
          onClick={() => void handleSave()}
          type="button"
        >
          {isSaving ? "Guardando..." : "Guardar destinatarios"}
        </button>
      ) : null}
    </div>
  );
}

function NoteShareEditor({ id, item, onUpdateShares, sharableUsers }: {
  id: string;
  item: Extract<ReaderNavigationListItem, { type: "note" }>;
  onUpdateShares: (noteId: string, sharedWithUserIds: string[]) => Promise<void>;
  sharableUsers: { displayName: string | null; userId: string; username: string }[];
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentShares = item.sharedWithUserIds ?? [];
  const selected = draft ?? currentShares;
  const hasChanges = draft !== null && !haveSameUserIds(draft, currentShares);

  async function handleSave() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await onUpdateShares(item.noteId, selected);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo actualizar con quién se comparte la nota.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="ai-request-share-editor reader-bookmark-share-editor" id={id}>
      <ShareWithSelector
        disabled={isSaving}
        emptyLabel="Esta nota solo la verás tú (Privada)."
        label="Compartida con"
        onChange={(userIds) => {
          setDraft(userIds);
          setError(null);
        }}
        options={sharableUsers}
        selected={selected}
      />
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {hasChanges ? (
        <button
          className="secondary-button ai-request-share-save"
          disabled={isSaving}
          onClick={() => void handleSave()}
          type="button"
        >
          {isSaving ? "Guardando..." : "Guardar destinatarios"}
        </button>
      ) : null}
    </div>
  );
}

function ReaderControlIcon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function AudioSettingsIcon() {
  return (
    <ReaderControlIcon>
      <path d="M5 13V11.5C5 7.63 8.13 4.5 12 4.5C15.87 4.5 19 7.63 19 11.5V13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M5 12.5H6.5C7.33 12.5 8 13.17 8 14V17.5C8 18.33 7.33 19 6.5 19H5.75C4.78 19 4 18.22 4 17.25V13.5C4 12.95 4.45 12.5 5 12.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M19 12.5H17.5C16.67 12.5 16 13.17 16 14V17.5C16 18.33 16.67 19 17.5 19H18.25C19.22 19 20 18.22 20 17.25V13.5C20 12.95 19.55 12.5 19 12.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.9" />
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

function SummarySectionIcon() {
  return (
    <ReaderControlIcon>
      <path d="M7 6.5H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7 11H17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7 15.5H13.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M16.25 14L17 15.5L18.5 16.25L17 17L16.25 18.5L15.5 17L14 16.25L15.5 15.5L16.25 14Z" fill="currentColor" />
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

function ShareIcon() {
  return (
    <ReaderControlIcon>
      <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8.2 10.9 7.6-3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="m8.2 13.1 7.6 3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
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

function ChevronIcon() {
  return (
    <ReaderControlIcon>
      <path d="M9 6.5L14.5 12L9 17.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ReaderControlIcon>
  );
}

function highlightClassName(color: ReaderHighlightColor) {
  return `reader-text-highlight reader-text-highlight-${color.toLowerCase()}`;
}

function getPostItColorClass(color?: string | null) {
  if (!color) return "postit-yellow";
  const c = color.toLowerCase();
  if (c.includes("green") || c.includes("verde")) return "postit-green";
  if (c.includes("blue") || c.includes("azul")) return "postit-blue";
  if (c.includes("pink") || c.includes("rosa") || c.includes("rose")) return "postit-pink";
  if (c.includes("orange") || c.includes("naranja")) return "postit-orange";
  if (c.includes("purple") || c.includes("morado") || c.includes("púrpura") || c.includes("violeta")) return "postit-purple";
  return "postit-yellow";
}

const BOOKMARK_TONE_COUNT = 6;

export function bookmarkToneClassName(bookmarkId: string) {
  let hash = 0;
  for (const character of bookmarkId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `reader-navigation-chip-bookmark-tone-${hash % BOOKMARK_TONE_COUNT}`;
}

export function ReaderFloatingAudioPopover({
  buttonLabel,
  buttonTitle,
  children,
  closeLabel = "Cerrar preferencias de audio",
  isOpen,
  menuRef,
  onClose,
  onToggle,
  panelId,
  title = "Preferencias de audio"
}: AudioPopoverProps) {
  const handleClose = onClose ?? onToggle;

  return (
    <div className="reader-floating-audio-menu" ref={menuRef}>
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-label={buttonLabel}
        className={isOpen ? "reader-float-button active" : "reader-float-button"}
        onClick={onToggle}
        title={buttonTitle ?? buttonLabel}
        type="button"
      >
        <AudioSettingsIcon />
      </button>

      {isOpen ? (
        <section aria-label={buttonLabel} className="reader-floating-audio-panel" id={panelId}>
          <div className="reader-navigation-header reader-audio-header">
            <div>
              <h3>{title}</h3>
            </div>
            <div className="reader-navigation-header-actions reader-audio-header-actions">
              <button
                aria-label={closeLabel}
                className="reader-icon-ghost"
                onClick={handleClose}
                title={closeLabel}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {children}
        </section>
      ) : null}
    </div>
  );
}

export function ReaderAudioSettingsContent({
  deepgramBalanceErrorMessage,
  deepgramBalanceLabel = "Saldo disponible en Deepgram",
  deepgramBalanceLoading = false,
  deepgramBalanceValue,
  deviceUnsupportedMessage = "Este navegador no expone voces nativas. Mantén el modo IA para reproducir audio.",
  deviceVoiceNote,
  deviceVoiceOptions,
  engineOptions,
  isDeviceTtsSupported,
  maxPlaybackRate,
  minPlaybackRate,
  onDeviceVoiceChange,
  onPlaybackRateChange,
  onTtsEngineChange,
  onVoiceModelChange,
  playbackRate,
  playbackRateStep,
  readingTimeStats,
  selectedDeviceVoiceUri,
  selectedTtsEngine,
  selectedVoiceModel,
  voiceOptions
}: AudioSettingsContentProps) {
  return (
    <>
      <label className="reader-audio-field">
        <span>Motor</span>
        <select onChange={(event) => onTtsEngineChange(event.target.value as "deepgram" | "device")} value={selectedTtsEngine}>
          {engineOptions.map((engine) => (
            <option disabled={engine.value === "device" && !isDeviceTtsSupported} key={engine.value} value={engine.value}>
              {engine.label} · {engine.description}
            </option>
          ))}
        </select>
      </label>

      {selectedTtsEngine === "deepgram" ? (
        <>
          {deepgramBalanceLoading ? (
            <p className="reader-audio-note">Consultando saldo de Deepgram...</p>
          ) : null}

          {deepgramBalanceValue ? (
            <div className="reader-audio-status reader-audio-status-inline">
              <span>{deepgramBalanceLabel}</span>
              <strong>{deepgramBalanceValue}</strong>
            </div>
          ) : null}

          {deepgramBalanceErrorMessage ? (
            <p className="reader-audio-note">{deepgramBalanceErrorMessage}</p>
          ) : null}

          <label className="reader-audio-field">
            <span>Voz</span>
            <select onChange={(event) => onVoiceModelChange(event.target.value)} value={selectedVoiceModel}>
              {voiceOptions.map((voice) => (
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
          <select disabled={!isDeviceTtsSupported} onChange={(event) => onDeviceVoiceChange(event.target.value)} value={selectedDeviceVoiceUri}>
            {deviceVoiceOptions.map((voice) => (
              <option key={voice.value || "device-default"} value={voice.value}>
                {voice.label} · {voice.description}
              </option>
            ))}
          </select>
        </label>
      )}

      {!isDeviceTtsSupported && selectedTtsEngine === "device" ? (
        <p className="reader-audio-note">{deviceUnsupportedMessage}</p>
      ) : null}

      {selectedTtsEngine === "device" && deviceVoiceNote ? (
        <p className="reader-audio-note">{deviceVoiceNote}</p>
      ) : null}

      <label className="reader-audio-field reader-audio-field-range">
        <span>
          Velocidad
          <strong className="reader-audio-inline-value">{playbackRate.toFixed(2)}x</strong>
        </span>
        <input
          max={maxPlaybackRate}
          min={minPlaybackRate}
          onChange={(event) => onPlaybackRateChange(Number(event.target.value))}
          step={playbackRateStep}
          type="range"
          value={playbackRate}
        />
      </label>

      {readingTimeStats ? (
        <section aria-label="Tiempo estimado de lectura" className="reader-audio-reading-time-card">
          <div className="reader-audio-reading-time-heading">
            <strong>Tiempo estimado</strong>
            <span>Según texto y velocidad actual</span>
          </div>
          <dl>
            <div>
              <ReadingTimeLabel label="Libro" pageCount={readingTimeStats.bookTotalPageCount} />
              <dd>{formatReadingTimeValue(readingTimeStats.bookTotalLabel, readingTimeStats.bookTotalCostLabel)}</dd>
            </div>
            <div>
              <ReadingTimeLabel label="Te queda" pageCount={readingTimeStats.bookRemainingPageCount} />
              <dd>{formatReadingTimeValue(readingTimeStats.bookRemainingLabel, readingTimeStats.bookRemainingCostLabel)}</dd>
            </div>
            {readingTimeStats.chapterTotalLabel && readingTimeStats.chapterRemainingLabel
              && readingTimeStats.chapterTotalPageCount !== null && readingTimeStats.chapterRemainingPageCount !== null ? (
              <>
                <div>
                  <ReadingTimeLabel label={readingTimeStats.chapterTitle ?? "Capítulo"} pageCount={readingTimeStats.chapterTotalPageCount} />
                  <dd>{formatReadingTimeValue(readingTimeStats.chapterTotalLabel, readingTimeStats.chapterTotalCostLabel)}</dd>
                </div>
                <div>
                  <ReadingTimeLabel label="Te queda del capítulo" pageCount={readingTimeStats.chapterRemainingPageCount} />
                  <dd>{formatReadingTimeValue(readingTimeStats.chapterRemainingLabel, readingTimeStats.chapterRemainingCostLabel)}</dd>
                </div>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
    </>
  );
}

export function ReaderNavigationPopover({
  aiRequestsHref,
  aiRequestsLabel = "Peticiones IA del libro",
  buttonLabel,
  buttonTitle,
  children,
  closeLabel = "Cerrar panel",
  eyebrow,
  isOpen,
  isRendered,
  onAiRequestsClick,
  onClose,
  onToggle,
  panelAriaLabel,
  panelRef,
  title
}: NavigationPopoverProps) {
  return (
    <>
      <button
        aria-expanded={isOpen}
        aria-label={buttonLabel}
        className={isOpen ? "reader-float-button active" : "reader-float-button"}
        onClick={onToggle}
        title={buttonTitle ?? buttonLabel}
        type="button"
      >
        <NavigationIcon />
      </button>

      {isRendered ? (
        <aside aria-label={panelAriaLabel} className="reader-navigation-panel" data-state={isOpen ? "open" : "closed"} ref={panelRef}>
          <div className="reader-navigation-header">
            <div>
              {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
              <h3>{title}</h3>
            </div>
            <div className="reader-navigation-header-actions">
              {aiRequestsHref ? (
                <Link
                  aria-label={aiRequestsLabel}
                  className="reader-icon-ghost"
                  onClick={onAiRequestsClick}
                  title={aiRequestsLabel}
                  to={aiRequestsHref}
                >
                  <SummarySectionIcon />
                </Link>
              ) : null}
              <button aria-label={closeLabel} className="reader-icon-ghost" onClick={onClose} type="button">
                <CloseIcon />
              </button>
            </div>
          </div>

          {children}
        </aside>
      ) : null}
    </>
  );
}

export function ReaderNavigationTocCard({ buttonRef, isActive, isExpanded, level, nestedCount, onSelect, onToggle, pageNumber, summaryHref, summaryLabel, onSummaryClick, title }: NavigationTocCardProps) {
  const articleClassName = [
    "reader-note-card reader-navigation-item-toc-card",
    isActive ? "active" : "",
    onToggle ? "with-toggle" : ""
  ].filter(Boolean).join(" ");

  return (
    <article className={articleClassName}>
      <button
        className={isActive ? "reader-navigation-item active" : "reader-navigation-item"}
        onClick={onSelect}
        ref={buttonRef}
        style={{ "--toc-level": String(Math.max(0, level - 1)) } as CSSProperties}
        type="button"
      >
        <div className="reader-navigation-item-topline">
          <strong>{title}</strong>
          <span className="reader-navigation-inline-meta">Pág. {pageNumber}</span>
        </div>
      </button>

      {summaryHref ? (
        <Link
          aria-label={summaryLabel ?? `Abrir resumen de ${title}`}
          className="reader-note-icon-button reader-navigation-summary-link"
          onClick={onSummaryClick}
          title="Peticiones IA de la sección"
          to={summaryHref}
        >
          <SummarySectionIcon />
        </Link>
      ) : null}

      {onToggle ? (
        <button
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Ocultar notas de ${title}` : `Mostrar notas de ${title}`}
          className="reader-note-icon-button reader-navigation-toggle"
          data-expanded={isExpanded ? "" : undefined}
          onClick={onToggle}
          title={isExpanded ? "Ocultar notas del capítulo" : "Mostrar notas del capítulo"}
          type="button"
        >
          <ChevronIcon />
          {typeof nestedCount === "number" ? <span className="reader-navigation-toggle-count">{nestedCount}</span> : null}
        </button>
      ) : null}
    </article>
  );
}

export function ReaderNavigationPanelContent({
  activeItemRef,
  editingHighlightId,
  editingHighlightText,
  editingNoteId,
  editingNoteColor,
  editingNoteText,
  expandedNoteId,
  isUpdatingNote,
  items,
  onBeginHighlightEditing,
  onBeginNoteEditing,
  onCancelHighlightEditing,
  onCancelNoteEditing,
  onDeleteBookmark,
  onDeleteHighlight,
  onDeleteNote,
  onEditingNoteColorChange,
  onEditingHighlightTextChange,
  onEditingNoteTextChange,
  onSaveHighlightNote,
  onSaveNote,
  onSelectBookmark,
  onSelectHighlight,
  onSelectNote,
  onSelectToc,
  onSummaryClick,
  onToggleNoteExpansion,
  onUpdateBookmarkShares,
  onUpdateNoteShares,
  sharableUsers,
  summaryHrefBuilder
}: NavigationPanelContentProps) {
  const indexItems = items.filter((item): item is Extract<ReaderNavigationListItem, { type: "bookmark" | "toc" }> => item.type === "bookmark" || item.type === "toc");
  const noteItems = items.filter((item): item is Extract<ReaderNavigationListItem, { type: "highlight" | "note" }> => item.type === "highlight" || item.type === "note");
  const tocItems = indexItems.filter((item): item is TocNavigationItem => item.type === "toc");
  const tocItemCount = tocItems.length;
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<"index" | "notes">("index");
  const [deletingBookmarkIds, setDeletingBookmarkIds] = useState<Set<string>>(new Set());
  const [openBookmarkShareId, setOpenBookmarkShareId] = useState<string | null>(null);
  const [openNoteShareId, setOpenNoteShareId] = useState<string | null>(null);

  useEffect(() => {
    activeItemRef?.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeItemRef, activeTab]);

  async function handleDeleteBookmark(item: BookmarkNavigationItem) {
    const confirmation = item.isOwnedByCurrentUser
      ? "¿Borrar este marcador? Esta acción no se puede deshacer."
      : "¿Quitar este marcador compartido de tus marcadores? El marcador original no se borrará.";
    if (!window.confirm(confirmation)) {
      return;
    }

    setDeletingBookmarkIds((prev) => new Set(prev).add(item.bookmarkId));
    try {
      await onDeleteBookmark(item.bookmarkId);
    } finally {
      setDeletingBookmarkIds((prev) => {
        const next = new Set(prev);
        next.delete(item.bookmarkId);
        return next;
      });
    }
  }

  function handleDeleteNote(item: Extract<ReaderNavigationListItem, { type: "note" }>) {
    const message = item.isReadOnly
      ? "¿Quitar esta nota compartida de tus notas? La nota original no se borrará."
      : "¿Borrar esta nota? Esta acción no se puede deshacer.";
    if (window.confirm(message)) {
      onDeleteNote(item.noteId);
    }
  }

  function renderBookmarkCard(item: BookmarkNavigationItem) {
    const isDeleting = deletingBookmarkIds.has(item.bookmarkId);
    const isShareEditorOpen = openBookmarkShareId === item.bookmarkId;
    const shareEditorId = `${tabsId}-bookmark-share-${item.bookmarkId}`;
    const canRemove = item.isOwnedByCurrentUser || item.visibilitySource === "DIRECT";
    const deleteLabel = item.isOwnedByCurrentUser ? "Borrar marcador" : "Quitar de mis marcadores";
    const toneClass = bookmarkToneClassName(item.bookmarkId);
    const sharedWithUserIds = item.sharedWithUserIds ?? [];
    const isShared = sharedWithUserIds.length > 0;
    const canShare = item.isOwnedByCurrentUser && sharableUsers.length > 0;
    const relativeCreatedAt = formatRelativeDate(item.createdAt);
    const exactCreatedAt = formatExactDate(item.createdAt);

    return (
      <article className={`reader-note-card reader-navigation-item-bookmark-card ${toneClass} ${item.isActive ? "active" : ""}`} data-deleting={isDeleting ? "" : undefined} key={item.key}>
        <button
          className="reader-navigation-item reader-navigation-item-bookmark"
          onClick={() => onSelectBookmark(item)}
          ref={item.isActive && activeItemRef
            ? (element) => {
                activeItemRef.current = element;
              }
            : undefined}
          type="button"
        >
          <div className="reader-navigation-item-topline">
            <span className={`reader-navigation-chip reader-navigation-chip-bookmark ${toneClass}`}><BookmarkIcon /></span>
            <strong>{item.title}</strong>
            <span className="reader-navigation-inline-meta" title={exactCreatedAt ? `Guardado el ${exactCreatedAt}` : undefined}>
              Pág. {item.pageNumber}{relativeCreatedAt ? ` · ${relativeCreatedAt}` : ""}
            </span>
          </div>
          {!item.isOwnedByCurrentUser && item.authorLabel ? (
            <span className="reader-navigation-inline-meta">Compartido por {item.authorLabel} · Solo lectura</span>
          ) : null}
        </button>
        <div className="reader-note-actions">
          {canShare ? (
            <button
              aria-controls={shareEditorId}
              aria-expanded={isShareEditorOpen}
              aria-label={isShareEditorOpen ? "Cerrar opciones para compartir" : isShared ? `Compartido con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir marcador (Privada)"}
              className={`reader-note-icon-button reader-postit-share-btn ${isShared ? "shared" : ""} ${isShareEditorOpen ? "active" : ""}`}
              onClick={() => setOpenBookmarkShareId((currentId) => currentId === item.bookmarkId ? null : item.bookmarkId)}
              title={isShared ? `Compartido con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir marcador (Privada)"}
              type="button"
            >
              <ShareIcon />
              {isShared ? <span className="reader-share-badge">{sharedWithUserIds.length}</span> : null}
            </button>
          ) : null}
          {canRemove ? (
            <button
              aria-label={deleteLabel}
              className="reader-note-delete"
              disabled={isDeleting}
              onClick={() => void handleDeleteBookmark(item)}
              title={deleteLabel}
              type="button"
            >
              {isDeleting ? <span className="reader-bookmark-delete-spinner" /> : <DeletePageIcon />}
            </button>
          ) : null}
        </div>
        {canShare && isShareEditorOpen ? (
          <BookmarkShareEditor
            id={shareEditorId}
            item={item}
            onUpdateShares={onUpdateBookmarkShares}
            sharableUsers={sharableUsers}
          />
        ) : null}
      </article>
    );
  }

  function renderHighlightCard(item: Extract<ReaderNavigationListItem, { type: "highlight" }>) {
    const isHighlightEditing = editingHighlightId === item.highlightId;
    const colorClass = getPostItColorClass(item.color);

    return (
      <article
        className={`reader-note-card reader-postit-card reader-navigation-item-note reader-navigation-note-entry ${colorClass} ${item.isActive ? "active" : ""}`}
        key={item.key}
      >
        <div className="reader-postit-tape" />

        {/* 1. TEXTO ARRIBA */}
        {isHighlightEditing ? (
          <div className="reader-note-editor">
            <label className="reader-note-composer compact">
              <textarea
                onChange={(event) => onEditingHighlightTextChange(event.target.value)}
                rows={3}
                value={editingHighlightText}
                placeholder="Añadir una nota a este resaltado..."
              />
            </label>
            <div className="reader-note-editor-actions">
              <button
                aria-label="Cancelar edición del resaltado"
                className="reader-note-icon-button"
                onClick={onCancelHighlightEditing}
                title="Cancelar"
                type="button"
              >
                <CloseIcon />
              </button>
              <button
                aria-label="Guardar nota del resaltado"
                className="reader-note-icon-button primary"
                disabled={isUpdatingNote || !editingHighlightText.trim()}
                onClick={() => onSaveHighlightNote(item.highlightId, editingHighlightText)}
                title="Guardar nota"
                type="button"
              >
                <SaveIcon />
              </button>
            </div>
          </div>
        ) : (
          <div className="reader-postit-note-text">
            <span className="reader-postit-highlight-title">Resaltado</span>
          </div>
        )}

        {/* 2. LO ANOTADO DEBAJO */}
        <div className="reader-postit-excerpt-block">
          <div className="reader-postit-excerpt-header">
            <span className={`reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}`} />
            <span className="reader-postit-excerpt-label">Texto anotado</span>
          </div>
          <blockquote className="reader-postit-excerpt-quote">
            "{item.excerpt}"
          </blockquote>
          <div className="reader-navigation-note-meta">
            <span>{annotationLocationLabel(item, tocItems)}</span>
          </div>
        </div>

        {/* 3. LOS BOTONES ABAJO */}
        <div className="reader-postit-footer">
          <button
            className="reader-postit-jump-btn"
            onClick={() => onSelectHighlight(item)}
            ref={item.isActive && activeItemRef
              ? (element) => {
                  activeItemRef.current = element;
                }
              : undefined}
            type="button"
            title="Ir al lugar en el libro"
          >
            <span>Ir al texto</span>
          </button>

          <div className="reader-note-actions">
            <button
              aria-label="Añadir nota al resaltado"
              className={isHighlightEditing ? "reader-note-icon-button active" : "reader-note-icon-button"}
              onClick={() => onBeginHighlightEditing(item.highlightId)}
              title="Añadir nota"
              type="button"
            >
              <EditIcon />
            </button>
            <button
              aria-label="Borrar resaltado"
              className="reader-note-delete"
              onClick={() => onDeleteHighlight(item.highlightId)}
              title="Borrar resaltado"
              type="button"
            >
              <DeletePageIcon />
            </button>
          </div>
        </div>
      </article>
    );
  }

  function renderNoteCard(item: Extract<ReaderNavigationListItem, { type: "note" }>) {
    const isNoteEditing = editingNoteId === item.noteId;
    const hasNoteText = item.noteText.trim().length > 0;
    const colorClass = getPostItColorClass(item.color);
    const isShareEditorOpen = openNoteShareId === item.noteId;
    const shareEditorId = `${tabsId}-note-share-${item.noteId}`;
    const sharedWithUserIds = item.sharedWithUserIds ?? [];
    const isShared = sharedWithUserIds.length > 0;
    const canShare = !item.isReadOnly && sharableUsers.length > 0;

    return (
      <article
        className={`reader-note-card reader-postit-card reader-navigation-item-note reader-navigation-note-entry ${colorClass} ${item.isActive ? "active" : ""}`}
        key={item.key}
      >
        <div className="reader-postit-tape" />

        {/* 1. TEXTO ARRIBA */}
        {isNoteEditing ? (
          <div className="reader-note-editor">
            {editingNoteColor ? (
              <div className="reader-note-composer">
                <span>Color del resaltado</span>
                <div aria-label="Color del resaltado" className="reader-selection-swatches" role="radiogroup">
                  {HIGHLIGHT_OPTIONS.map((option) => (
                    <button
                      aria-checked={editingNoteColor === option.color}
                      className={editingNoteColor === option.color ? `reader-swatch active ${highlightClassName(option.color)}` : `reader-swatch ${highlightClassName(option.color)}`}
                      disabled={isUpdatingNote}
                      key={option.color}
                      onClick={() => onEditingNoteColorChange(option.color)}
                      role="radio"
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="reader-note-composer compact">
              <textarea
                onChange={(event) => onEditingNoteTextChange(event.target.value)}
                rows={3}
                value={editingNoteText}
              />
            </label>
            <div className="reader-note-editor-actions">
              <button
                aria-label="Cancelar edición de la nota"
                className="reader-note-icon-button"
                onClick={onCancelNoteEditing}
                title="Cancelar"
                type="button"
              >
                <CloseIcon />
              </button>
              <button
                aria-label="Guardar cambios de la nota"
                className="reader-note-icon-button primary"
                disabled={isUpdatingNote || !editingNoteText.trim()}
                onClick={() => onSaveNote(item.noteId, editingNoteText, editingNoteColor)}
                title="Guardar cambios"
                type="button"
              >
                <SaveIcon />
              </button>
            </div>
          </div>
        ) : (
          <div className="reader-postit-note-text">
            {hasNoteText ? (
              <p>{item.noteText}</p>
            ) : (
              <p className="reader-postit-empty-text">(Sin nota escrita)</p>
            )}
          </div>
        )}

        {/* 2. LO ANOTADO DEBAJO */}
        <div className="reader-postit-excerpt-block">
          <div className="reader-postit-excerpt-header">
            <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
            <span className="reader-postit-excerpt-label">Texto anotado</span>
          </div>
          <blockquote className="reader-postit-excerpt-quote">
            "{item.excerpt}"
          </blockquote>
          <div className="reader-navigation-note-meta">
            {item.isReadOnly && item.authorLabel ? <span>Compartida por {item.authorLabel} • </span> : null}
            <span>{annotationLocationLabel(item, tocItems)}</span>
          </div>
        </div>

        {/* 3. LOS BOTONES ABAJO */}
        <div className="reader-postit-footer">
          <button
            className="reader-postit-jump-btn"
            onClick={() => onSelectNote(item)}
            ref={item.isActive && activeItemRef
              ? (element) => {
                  activeItemRef.current = element;
                }
              : undefined}
            type="button"
            title="Ir al lugar en el libro"
          >
            <span>Ir al texto</span>
          </button>

          <div className="reader-note-actions">
            {canShare ? (
              <button
                aria-controls={shareEditorId}
                aria-expanded={isShareEditorOpen}
                aria-label={isShareEditorOpen ? "Cerrar opciones para compartir nota" : isShared ? `Compartida con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir nota (Privada)"}
                className={`reader-note-icon-button reader-postit-share-btn ${isShared ? "shared" : ""} ${isShareEditorOpen ? "active" : ""}`}
                onClick={() => setOpenNoteShareId((currentId) => currentId === item.noteId ? null : item.noteId)}
                title={isShared ? `Compartida con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir nota (Privada)"}
                type="button"
              >
                <ShareIcon />
                {isShared ? <span className="reader-share-badge">{sharedWithUserIds.length}</span> : null}
              </button>
            ) : null}
            {!item.isReadOnly ? (
              <button
                aria-label="Editar nota"
                className={isNoteEditing ? "reader-note-icon-button active" : "reader-note-icon-button"}
                onClick={() => onBeginNoteEditing({ color: item.color, noteId: item.noteId, noteText: item.noteText })}
                title="Editar nota"
                type="button"
              >
                <EditIcon />
              </button>
            ) : null}
            <button
              aria-label={item.isReadOnly ? "Quitar nota compartida" : "Borrar nota"}
              className="reader-note-delete"
              onClick={() => handleDeleteNote(item)}
              title={item.isReadOnly ? "Quitar de mis notas" : "Borrar nota"}
              type="button"
            >
              <DeletePageIcon />
            </button>
          </div>
        </div>

        {canShare && isShareEditorOpen && onUpdateNoteShares ? (
          <NoteShareEditor
            id={shareEditorId}
            item={item}
            onUpdateShares={onUpdateNoteShares}
            sharableUsers={sharableUsers}
          />
        ) : null}
      </article>
    );
  }

  return (
    <section className="reader-navigation-section">
      <div aria-label="Contenido de navegación" className="reader-navigation-tabs" role="tablist">
        <button
          aria-controls={`${tabsId}-index-panel`}
          aria-selected={activeTab === "index"}
          className={activeTab === "index" ? "reader-navigation-tab active" : "reader-navigation-tab"}
          id={`${tabsId}-index-tab`}
          onClick={() => setActiveTab("index")}
          role="tab"
          type="button"
        >
          <span>Índice</span>
          <span className="reader-navigation-tab-count">{indexItems.length}</span>
        </button>
        <button
          aria-controls={`${tabsId}-notes-panel`}
          aria-selected={activeTab === "notes"}
          className={activeTab === "notes" ? "reader-navigation-tab active" : "reader-navigation-tab"}
          id={`${tabsId}-notes-tab`}
          onClick={() => setActiveTab("notes")}
          role="tab"
          type="button"
        >
          <span>Notas</span>
          <span className="reader-navigation-tab-count">{noteItems.length}</span>
        </button>
      </div>

      {activeTab === "index" ? (
        <div aria-labelledby={`${tabsId}-index-tab`} className="reader-navigation-tab-panel" id={`${tabsId}-index-panel`} role="tabpanel">
          <div className="reader-navigation-section-heading">
            <div className="reader-navigation-section-heading-copy">
              <strong>Índice del libro</strong>
            </div>
            <div className="reader-navigation-section-actions">
              <span>{tocItemCount}</span>
            </div>
          </div>

          {indexItems.length ? (
            <div className="reader-navigation-list">
              {indexItems.map((item) => item.type === "bookmark" ? renderBookmarkCard(item) : (
                <ReaderNavigationTocCard
                  buttonRef={item.isActive && activeItemRef
                    ? (element) => {
                        activeItemRef.current = element;
                      }
                    : undefined}
                  isActive={item.isActive}
                  key={item.key}
                  level={item.level}
                  onSelect={() => onSelectToc(item)}
                  onSummaryClick={onSummaryClick}
                  pageNumber={item.pageNumber}
                  summaryHref={item.chapterId && summaryHrefBuilder ? summaryHrefBuilder(item.chapterId) : undefined}
                  summaryLabel={`Abrir resumen de ${item.title}`}
                  title={item.title}
                />
              ))}
            </div>
          ) : (
            <p className="reader-navigation-empty">Este libro no tiene capítulos ni marcadores.</p>
          )}
        </div>
      ) : (
        <div aria-labelledby={`${tabsId}-notes-tab`} className="reader-navigation-tab-panel" id={`${tabsId}-notes-panel`} role="tabpanel">
          <div className="reader-navigation-section-heading">
            <strong>Notas y resaltados</strong>
            <span>{noteItems.length}</span>
          </div>
          {noteItems.length ? (
            <div className="reader-navigation-list reader-navigation-notes-list">
              {noteItems.map((item) => item.type === "highlight" ? renderHighlightCard(item) : renderNoteCard(item))}
            </div>
          ) : (
            <p className="reader-navigation-empty">Todavía no hay notas ni resaltados en este libro.</p>
          )}
        </div>
      )}
    </section>
  );
}
