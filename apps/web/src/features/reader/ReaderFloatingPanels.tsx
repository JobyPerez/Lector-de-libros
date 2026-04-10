import { Link } from "react-router-dom";
import { type CSSProperties, type ReactNode, type RefObject } from "react";

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

type AudioPopoverProps = {
  buttonLabel: string;
  buttonTitle?: string;
  children: ReactNode;
  isOpen: boolean;
  menuRef?: RefObject<HTMLDivElement | null>;
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
  deviceVoiceOptions: AudioVoiceOption[];
  engineOptions: AudioEngineOption[];
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
  voiceOptions: AudioVoiceOption[];
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
  panelRef?: RefObject<HTMLDivElement | null>;
  title: string;
};

type NavigationTocCardProps = {
  buttonRef?: (element: HTMLButtonElement | null) => void;
  isActive: boolean;
  level: number;
  onSelect: () => void;
  pageNumber: number;
  summaryHref?: string;
  summaryLabel?: string;
  onSummaryClick?: () => void;
  title: string;
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