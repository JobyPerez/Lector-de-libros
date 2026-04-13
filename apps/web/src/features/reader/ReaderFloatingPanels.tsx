import { Link } from "react-router-dom";
import { type CSSProperties, type MutableRefObject, type ReactNode, type Ref } from "react";

import type { BookOutlineSource } from "../../app/api";
import { getOutlineSourceMeta } from "../../app/outline-source";

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
  isOpen: boolean;
  menuRef?: Ref<HTMLDivElement>;
  onToggle: () => void;
  panelId: string;
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
  selectedDeviceVoiceUri: string;
  selectedTtsEngine: "deepgram" | "device";
  selectedVoiceModel: string;
  voiceOptions: ReadonlyArray<AudioVoiceOption>;
};

type NavigationPopoverProps = {
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
  level: number;
  onSelect: () => void;
  pageNumber: number;
  summaryHref?: string | undefined;
  summaryLabel?: string | undefined;
  onSummaryClick?: (() => void) | undefined;
  title: string;
};

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
      bookmarkId: string;
      isActive: boolean;
      key: string;
      pageNumber: number;
      paragraphNumber: number;
      title: string;
      type: "bookmark";
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
      color: ReaderHighlightColor | null;
      excerpt: string;
      isActive: boolean;
      key: string;
      noteId: string;
      noteText: string;
      pageNumber: number;
      paragraphNumber: number;
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
  onOutlineEditClick?: () => void;
  outlineSource?: BookOutlineSource;
  outlineEditHref?: string;
  onBeginHighlightEditing: (highlightId: string) => void;
  onBeginNoteEditing: (note: { color: ReaderHighlightColor | null; noteId: string; noteText: string }) => void;
  onCancelHighlightEditing: () => void;
  onCancelNoteEditing: () => void;
  onDeleteBookmark: (bookmarkId: string) => void;
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
  summaryHrefBuilder?: (chapterId: string) => string;
};

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
      <path d="M5 8.5H11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M5 15.5H8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M13 15.5H19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M16 8.5H19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <circle cx="13" cy="8.5" fill="currentColor" r="1.6" />
      <circle cx="10" cy="15.5" fill="currentColor" r="1.6" />
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

function highlightClassName(color: ReaderHighlightColor) {
  return `reader-text-highlight reader-text-highlight-${color.toLowerCase()}`;
}

export function ReaderFloatingAudioPopover({ buttonLabel, buttonTitle, children, isOpen, menuRef, onToggle, panelId }: AudioPopoverProps) {
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
    </>
  );
}

export function ReaderNavigationPopover({
  buttonLabel,
  buttonTitle,
  children,
  closeLabel = "Cerrar panel",
  eyebrow,
  isOpen,
  isRendered,
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
            <button aria-label={closeLabel} className="reader-icon-ghost" onClick={onClose} type="button">
              <CloseIcon />
            </button>
          </div>

          {children}
        </aside>
      ) : null}
    </>
  );
}

export function ReaderNavigationTocCard({ buttonRef, isActive, level, onSelect, pageNumber, summaryHref, summaryLabel, onSummaryClick, title }: NavigationTocCardProps) {
  return (
    <article className={isActive ? "reader-note-card reader-navigation-item-toc-card active" : "reader-note-card reader-navigation-item-toc-card"}>
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
          title="Resumen de la sección"
          to={summaryHref}
        >
          <SummarySectionIcon />
        </Link>
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
  onOutlineEditClick,
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
  outlineEditHref,
  outlineSource,
  summaryHrefBuilder
}: NavigationPanelContentProps) {
  const outlineSourceMeta = outlineSource ? getOutlineSourceMeta(outlineSource) : null;
  const tocItemCount = items.filter((item) => item.type === "toc").length;

  return (
    <section className="reader-navigation-section">
      <div className="reader-navigation-section-heading">
        <div className="reader-navigation-section-heading-copy">
          <strong>Índice del libro</strong>
          {outlineSourceMeta ? <span className="reader-navigation-source-badge" title={outlineSourceMeta.description}>{outlineSourceMeta.badgeLabel}</span> : null}
        </div>
        <div className="reader-navigation-section-actions">
          <span>{tocItemCount}</span>
          {outlineEditHref ? (
            <Link
              aria-label="Editar índice"
              className="reader-note-icon-button reader-navigation-edit-link"
              onClick={onOutlineEditClick}
              title="Editar índice"
              to={outlineEditHref}
            >
              <EditIcon />
            </Link>
          ) : null}
        </div>
      </div>

      {items.length ? (
        <div className="reader-navigation-list">
          {items.map((item) => {
            if (item.type === "toc") {
              return (
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
              );
            }

            if (item.type === "bookmark") {
              return (
                <article className={item.isActive ? "reader-note-card reader-navigation-item-bookmark-card active" : "reader-note-card reader-navigation-item-bookmark-card"} key={item.key}>
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
                      <span className="reader-navigation-chip reader-navigation-chip-bookmark"><BookmarkIcon /></span>
                      <strong>{item.title}</strong>
                      <span className="reader-navigation-inline-meta">Pág. {item.pageNumber}</span>
                    </div>
                  </button>
                  <div className="reader-note-actions">
                    <button
                      aria-label="Borrar marcador"
                      className="reader-note-delete"
                      onClick={() => onDeleteBookmark(item.bookmarkId)}
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
              const isHighlightEditing = editingHighlightId === item.highlightId;

              return (
                <article className={item.isActive ? "reader-note-card reader-navigation-item-note reader-navigation-note-entry active" : "reader-note-card reader-navigation-item-note reader-navigation-note-entry"} key={item.key}>
                  <button
                    className="reader-note-jump"
                    onClick={() => onSelectHighlight(item)}
                    ref={item.isActive && activeItemRef
                      ? (element) => {
                          activeItemRef.current = element;
                        }
                      : undefined}
                    type="button"
                  >
                    <div className="reader-navigation-item-topline">
                      <span className={`reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}`} />
                      <strong>{item.excerpt}</strong>
                      <span className="reader-navigation-inline-meta">Pág. {item.pageNumber} · párr. {item.paragraphNumber}</span>
                    </div>
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

                  {isHighlightEditing ? (
                    <div className="reader-note-editor">
                      <label className="reader-note-composer compact">
                        <textarea
                          onChange={(event) => onEditingHighlightTextChange(event.target.value)}
                          rows={4}
                          value={editingHighlightText}
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
                  ) : null}
                </article>
              );
            }

            const isNoteExpanded = expandedNoteId === item.noteId;
            const isNoteEditing = editingNoteId === item.noteId;
            const hasNoteText = item.noteText.trim().length > 0;

            return (
              <article className={item.isActive ? "reader-note-card reader-navigation-item-note reader-navigation-note-entry active" : "reader-note-card reader-navigation-item-note reader-navigation-note-entry"} key={item.key}>
                <button
                  className="reader-note-jump"
                  onClick={() => onSelectNote(item)}
                  ref={item.isActive && activeItemRef
                    ? (element) => {
                        activeItemRef.current = element;
                      }
                    : undefined}
                  type="button"
                >
                  <div className="reader-navigation-item-topline">
                    <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
                    <strong>{item.excerpt}</strong>
                    <span className="reader-navigation-inline-meta">Pág. {item.pageNumber} · párr. {item.paragraphNumber}</span>
                  </div>
                </button>
                <div className="reader-note-actions">
                  {hasNoteText ? (
                    <button
                      aria-expanded={isNoteExpanded}
                      aria-label={isNoteExpanded ? "Ocultar contenido de la nota" : "Mostrar contenido de la nota"}
                      className="reader-note-icon-button"
                      onClick={() => onToggleNoteExpansion(item.noteId)}
                      title={isNoteExpanded ? "Ocultar nota" : "Ver nota"}
                      type="button"
                    >
                      <EyeIcon />
                    </button>
                  ) : null}
                  <button
                    aria-label="Editar nota"
                    className={isNoteEditing ? "reader-note-icon-button active" : "reader-note-icon-button"}
                    onClick={() => onBeginNoteEditing({ color: item.color, noteId: item.noteId, noteText: item.noteText })}
                    title="Editar nota"
                    type="button"
                  >
                    <EditIcon />
                  </button>
                  <button
                    aria-label="Borrar nota"
                    className="reader-note-delete"
                    onClick={() => onDeleteNote(item.noteId)}
                    title="Borrar nota"
                    type="button"
                  >
                    <DeletePageIcon />
                  </button>
                </div>

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
                        rows={4}
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
                ) : isNoteExpanded ? (
                  <p>{item.noteText}</p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="reader-navigation-empty">Este libro no trae índice estructurado. Aquí seguirás viendo marcadores y notas.</p>
      )}
    </section>
  );
}