import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node as FlowNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  createNote,
  createAiRequest,
  deleteBookmark,
  deleteHighlight,
  deleteAiRequest,
  deleteNote,
  fetchAnnotationShareUsers,
  fetchBook,
  fetchDeepgramBalance,
  fetchReaderNavigation,
  fetchAiRequests,
  fetchAiRequestRetryProgress,
  isBookCommenterOrAbove,
  isRetryableRateLimitError,
  requestAiResponseAudio,
  updateAiRequestShares,
  updateBookmarkShares,
  updateNote,
  type HighlightColor,
  type AiRequestKind,
  type AiRequestRecord,
  type AiRequestsResponse,
  type AiVisualType,
  type ReaderHighlight,
  type ReaderNote,
  type ReaderTocEntry
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import {
  DEFAULT_DEVICE_VOICE_URI,
  buildDeviceVoiceOptions,
  findDeviceVoice,
  getBookLanguageName,
  getDeepgramVoiceOptions,
  getSpeechLanguage,
  normalizeBookLanguageCode,
  pickFallbackDeviceVoice,
  readStoredDeviceVoiceUri,
  readStoredVoiceModel,
  writeStoredDeviceVoiceUri,
  writeStoredVoiceModel
} from "../../app/book-language";
import { playCompletionSound, prepareCompletionSound } from "../../app/notification-sound";
import { formatSectionTitleWithAncestors } from "../../app/outline-source";
import { AiModelBadge, AiModelSelector, useAiModelSelection } from "../../components/AiModelBadge";
import { ShareWithSelector } from "../../components/ShareWithSelector";
import { ReaderAudioSettingsContent, ReaderFloatingAudioPopover, ReaderNavigationPanelContent, ReaderNavigationPopover, type ReaderNavigationListItem } from "./ReaderFloatingPanels";

const READER_TTS_ENGINE_STORAGE_KEY = "lector.reader.ttsEngine";
const READER_SPEED_STORAGE_KEY = "lector.reader.playbackRate";
const DEFAULT_TTS_ENGINE = "deepgram";
const DEFAULT_PLAYBACK_RATE = 1;
const MIN_PLAYBACK_RATE = 0.8;
const MAX_PLAYBACK_RATE = 1.35;
const PLAYBACK_RATE_STEP = 0.05;
const READER_NAVIGATION_PANEL_ANIMATION_MS = 220;
const AI_REQUEST_REMOVAL_ANIMATION_MS = 240;
const AI_REQUEST_CREATION_ANIMATION_MS = 520;
const AI_VISUAL_TYPE_OPTIONS: Array<{ description: string; label: string; value: AiVisualType }> = [
  { description: "La IA elige según el contenido", label: "Automático", value: "AUTO" },
  { description: "Idea central y ramas", label: "Mapa mental", value: "MIND_MAP" },
  { description: "Conceptos jerárquicos y conexiones", label: "Mapa conceptual", value: "CONCEPT_MAP" },
  { description: "Hechos ordenados temporalmente", label: "Línea de tiempo", value: "TIMELINE" },
  { description: "Bloques editoriales y datos destacados", label: "Infografía", value: "INFOGRAPHIC" },
  { description: "Pasos, procesos y decisiones", label: "Diagrama de flujo", value: "FLOWCHART" },
  { description: "Conexiones entre personajes o ideas", label: "Red de relaciones", value: "RELATIONSHIPS" }
];
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

type TtsEngine = "deepgram" | "device";

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

function readStoredPlaybackRate() {
  if (typeof window === "undefined") {
    return DEFAULT_PLAYBACK_RATE;
  }

  const storedValue = window.localStorage.getItem(READER_SPEED_STORAGE_KEY);
  if (!storedValue) {
    return DEFAULT_PLAYBACK_RATE;
  }

  const storedPlaybackRate = Number(storedValue);
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

function ShareIcon() {
  return (
    <RequestIcon>
      <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8.2 10.9 7.6-3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="m8.2 13.1 7.6 3.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
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

function ChevronIcon() {
  return (
    <RequestIcon>
      <path d="M8 10L12 14L16 10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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
    timeStyle: "short",
    timeZone: "Europe/Madrid"
  });
}

function paragraphize(value: string) {
  return value
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

type AiRequestDiagramData = {
  edges: Array<{ from: string; label?: string; to: string }>;
  nodes: Array<{ category?: string; date?: string; detail?: string; id: string; label: string; metric?: string }>;
  summary: string;
  title: string;
  type: Exclude<AiVisualType, "AUTO">;
};

const AI_VISUAL_TYPES = new Set<AiRequestDiagramData["type"]>(["MIND_MAP", "CONCEPT_MAP", "TIMELINE", "INFOGRAPHIC", "FLOWCHART", "RELATIONSHIPS"]);

function parseAiRequestDiagram(value: string): AiRequestDiagramData | null {
  try {
    const diagram = JSON.parse(value) as Partial<AiRequestDiagramData>;
    if (
      typeof diagram.title !== "string"
      || typeof diagram.summary !== "string"
      || !Array.isArray(diagram.nodes)
      || !Array.isArray(diagram.edges)
    ) {
      return null;
    }
    const type = typeof diagram.type === "string" && AI_VISUAL_TYPES.has(diagram.type as AiRequestDiagramData["type"])
      ? diagram.type as AiRequestDiagramData["type"]
      : "CONCEPT_MAP";
    return { ...diagram, type } as AiRequestDiagramData;
  } catch {
    return null;
  }
}

function getAiRequestSpeechText(request: AiRequestRecord) {
  if (request.kind !== "DIAGRAM") {
    return request.responseText;
  }
  const diagram = parseAiRequestDiagram(request.responseText);
  return diagram ? `${diagram.title}. ${diagram.summary}` : request.responseText;
}

function DiagramHeader({ diagram }: { diagram: AiRequestDiagramData }) {
  const visualLabel = AI_VISUAL_TYPE_OPTIONS.find((option) => option.value === diagram.type)?.label ?? "Resumen gráfico";
  return (
    <header className="ai-request-diagram-header">
      <span className="ai-request-diagram-kicker">{visualLabel}</span>
      <h4>{diagram.title}</h4>
      <p>{diagram.summary}</p>
    </header>
  );
}

function AiRequestFlowDiagram({ diagram }: { diagram: AiRequestDiagramData }) {
  const [flow, setFlow] = useState<{ edges: Edge[]; nodes: FlowNode[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const direction = diagram.type === "MIND_MAP" || diagram.type === "RELATIONSHIPS" ? "RIGHT" : "DOWN";
    void import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK().layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": direction,
          "elk.layered.spacing.nodeNodeBetweenLayers": "70",
          "elk.spacing.nodeNode": "38"
        },
        children: diagram.nodes.map((node) => ({ height: node.detail ? 116 : 88, id: node.id, width: 230 })),
        edges: diagram.edges.map((edge, index) => ({ id: `elk-${index}`, sources: [edge.from], targets: [edge.to] }))
      })).then((layout) => {
      if (cancelled) {
        return;
      }
      setFlow({
        nodes: diagram.nodes.map((node, index) => {
          const position = layout.children?.find((child) => child.id === node.id);
          return {
            className: index === 0 ? "ai-flow-node is-primary" : "ai-flow-node",
            data: {
              label: (
                <div className="ai-flow-node-content">
                  {node.category ? <span>{node.category}</span> : null}
                  <strong>{node.label}</strong>
                  {node.detail ? <small>{node.detail}</small> : null}
                </div>
              )
            },
            id: node.id,
            position: { x: position?.x ?? 0, y: position?.y ?? index * 120 }
          };
        }),
        edges: diagram.edges.map((edge, index) => ({
          animated: diagram.type === "FLOWCHART",
          id: `edge-${edge.from}-${edge.to}-${index}`,
          label: edge.label,
          markerEnd: { type: MarkerType.ArrowClosed },
          source: edge.from,
          target: edge.to,
          type: "smoothstep"
        }))
      });
    });

    return () => {
      cancelled = true;
    };
  }, [diagram]);

  return (
    <div className="ai-request-flow" aria-label={`Diagrama interactivo: ${diagram.title}`}>
      {flow ? (
        <ReactFlow
          edges={flow.edges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          maxZoom={1.5}
          minZoom={0.25}
          nodes={flow.nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#b9c8bd" gap={22} size={1} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      ) : <p className="subdued">Organizando el diagrama...</p>}
    </div>
  );
}

function AiRequestTimeline({ diagram }: { diagram: AiRequestDiagramData }) {
  return (
    <ol className="ai-request-timeline">
      {diagram.nodes.map((node, index) => (
        <li key={node.id}>
          <span className="ai-request-timeline-marker">{index + 1}</span>
          <article>
            {node.date ? <time>{node.date}</time> : null}
            <h5>{node.label}</h5>
            {node.detail ? <p>{node.detail}</p> : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

function AiRequestInfographic({ diagram }: { diagram: AiRequestDiagramData }) {
  return (
    <div className="ai-request-infographic">
      {diagram.nodes.map((node, index) => (
        <article className={index === 0 ? "is-featured" : undefined} key={node.id}>
          <span className="ai-request-infographic-index">{String(index + 1).padStart(2, "0")}</span>
          {node.category ? <span className="ai-request-infographic-category">{node.category}</span> : null}
          {node.metric ? <strong className="ai-request-infographic-metric">{node.metric}</strong> : null}
          <h5>{node.label}</h5>
          {node.detail ? <p>{node.detail}</p> : null}
        </article>
      ))}
    </div>
  );
}

function AiRequestDiagram({ diagram }: { diagram: AiRequestDiagramData }) {
  const isFlowDiagram = diagram.type === "MIND_MAP" || diagram.type === "CONCEPT_MAP" || diagram.type === "FLOWCHART" || diagram.type === "RELATIONSHIPS";

  return (
    <section className="ai-request-diagram" aria-label={`Esquema gráfico: ${diagram.title}`}>
      <DiagramHeader diagram={diagram} />
      {isFlowDiagram ? <AiRequestFlowDiagram diagram={diagram} /> : null}
      {diagram.type === "TIMELINE" ? <AiRequestTimeline diagram={diagram} /> : null}
      {diagram.type === "INFOGRAPHIC" ? <AiRequestInfographic diagram={diagram} /> : null}
    </section>
  );
}

function haveSameUserIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((userId) => right.includes(userId));
}

export function AiRequestsPage() {
  const { bookId = "", chapterId } = useParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const userAiCredentials = useAuthStore((state) => state.user?.aiCredentials);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const aiModelSelection = useAiModelSelection();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const loadedAudioRef = useRef<{ requestId: string; voiceModel: string } | null>(null);
  const activeAudioRequestRef = useRef<AbortController | null>(null);
  const deviceUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelRef = useRef<HTMLDivElement | null>(null);
  const navigationPanelCloseTimeoutRef = useRef<number | null>(null);
  const activeNavigationItemRef = useRef<HTMLButtonElement | null>(null);
  const wakeLockRef = useRef<{ addEventListener?: (type: "release", listener: () => void) => void; release: () => Promise<void>; released?: boolean } | null>(null);
  const initialPromptKeyRef = useRef<string | null>(null);
  const isSubmittingRef = useRef(false);
  const [promptText, setPromptText] = useState("");
  const [requestKind, setRequestKind] = useState<AiRequestKind>("TEXT");
  const [visualType, setVisualType] = useState<AiVisualType>("AUTO");
  const [shareDrafts, setShareDrafts] = useState<Record<string, string[]>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [isSectionPickerOpen, setIsSectionPickerOpen] = useState(false);
  const [sectionSearchText, setSectionSearchText] = useState("");
  const [showOnlySelectedSections, setShowOnlySelectedSections] = useState(false);
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(() => new Set());
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [submitProgressId, setSubmitProgressId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [enteringRequestId, setEnteringRequestId] = useState<string | null>(null);
  const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
  const [updatingSharesRequestId, setUpdatingSharesRequestId] = useState<string | null>(null);
  const [openShareRequestId, setOpenShareRequestId] = useState<string | null>(null);
  const [removingRequestId, setRemovingRequestId] = useState<string | null>(null);
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
  const [selectedVoiceModel, setSelectedVoiceModel] = useState<string>(() => readStoredVoiceModel("es"));
  const [selectedDeviceVoiceUri, setSelectedDeviceVoiceUri] = useState<string>(() => readStoredDeviceVoiceUri("es"));
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

  const annotationShareUsersQuery = useQuery({
    enabled: Boolean(accessToken && bookId),
    queryKey: ["annotation-share-users", bookId],
    queryFn: async () => {
      if (!accessToken) {
        return [] as Awaited<ReturnType<typeof fetchAnnotationShareUsers>>["users"];
      }

      const response = await fetchAnnotationShareUsers(accessToken, bookId);
      return response.users;
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
    const promptKey = `${bookId}:${chapterId ?? "book"}`;

    if (requestsQuery.data?.prompt && initialPromptKeyRef.current !== promptKey) {
      initialPromptKeyRef.current = promptKey;
      setPromptText(requestsQuery.data.prompt);
    }
  }, [bookId, chapterId, requestsQuery.data?.prompt]);

  useEffect(() => {
    setShareDrafts({});
    setShareError(null);
  }, [bookId, chapterId]);

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
    if (!isSubmitting || !submitProgressId || !accessToken || typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    const pollProgress = async () => {
      try {
        const response = await fetchAiRequestRetryProgress(accessToken, submitProgressId);
        if (!cancelled && isSubmittingRef.current) {
          setSubmitStatus(`Reintentando petición a OpenCode (intento ${response.progress.attempt} de ${response.progress.maxAttempts})...`);
        }
      } catch {
        // El progreso no existe hasta que OpenCode necesita hacer el primer reintento.
      }
    };

    void pollProgress();
    const intervalId = window.setInterval(() => {
      void pollProgress();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, isSubmitting, submitProgressId]);

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
      loadedAudioRef.current = null;
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
      loadedAudioRef.current = null;
      if (navigationPanelCloseTimeoutRef.current !== null) {
        window.clearTimeout(navigationPanelCloseTimeoutRef.current);
      }
    };
  }, []);

  const isAudioPlaybackActive = playingRequestId !== null || (hasActivePlaybackSession && !isDevicePaused);

  useEffect(() => {
    if (!isAudioPlaybackActive) {
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
      return;
    }

    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ addEventListener?: (type: "release", listener: () => void) => void; release: () => Promise<void>; released?: boolean }> } }).wakeLock;
    if (!wakeLockApi) {
      return;
    }

    if (wakeLockRef.current && wakeLockRef.current.released !== true) {
      return;
    }

    wakeLockApi.request("screen").then((wakeLock) => {
      wakeLockRef.current = wakeLock;
      wakeLock.addEventListener?.("release", () => {
        if (wakeLockRef.current === wakeLock) {
          wakeLockRef.current = null;
        }
      });
    }).catch(() => {});
  }, [isAudioPlaybackActive]);

  useEffect(() => {
    return () => {
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!isAudioPlaybackActive || typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !isAudioPlaybackActive) {
        return;
      }

      if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
        return;
      }

      const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ addEventListener?: (type: "release", listener: () => void) => void; release: () => Promise<void>; released?: boolean }> } }).wakeLock;
      if (!wakeLockApi) {
        return;
      }

      if (wakeLockRef.current && wakeLockRef.current.released !== true) {
        return;
      }

      wakeLockApi.request("screen").then((wakeLock) => {
        wakeLockRef.current = wakeLock;
        wakeLock.addEventListener?.("release", () => {
          if (wakeLockRef.current === wakeLock) {
            wakeLockRef.current = null;
          }
        });
      }).catch(() => {});
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAudioPlaybackActive]);

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

  const bookLanguageCode = normalizeBookLanguageCode(bookQuery.data?.book.languageCode ?? requestsQuery.data?.book.languageCode);
  const ttsVoiceOptions = getDeepgramVoiceOptions(bookLanguageCode);
  const isDeviceTtsSupported = Boolean(getSpeechSynthesisApi());
  const deviceVoiceOptions = useMemo(() => buildDeviceVoiceOptions(availableDeviceVoices, bookLanguageCode), [availableDeviceVoices, bookLanguageCode]);
  const selectedDeviceVoice = useMemo(
    () => findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri, bookLanguageCode),
    [availableDeviceVoices, bookLanguageCode, selectedDeviceVoiceUri]
  );

  useEffect(() => {
    const profileVoiceModel = bookLanguageCode === "it"
      ? userAiCredentials?.deepgramTtsModelIt
      : userAiCredentials?.deepgramTtsModel;
    setSelectedVoiceModel(readStoredVoiceModel(bookLanguageCode, profileVoiceModel));
    setSelectedDeviceVoiceUri(readStoredDeviceVoiceUri(bookLanguageCode));
  }, [bookLanguageCode, userAiCredentials?.deepgramTtsModel, userAiCredentials?.deepgramTtsModelIt]);

  useEffect(() => {
    if (!isDeviceTtsSupported && selectedTtsEngine === "device") {
      setSelectedTtsEngine("deepgram");
    }
  }, [isDeviceTtsSupported, selectedTtsEngine]);

  useEffect(() => {
    if (selectedDeviceVoiceUri && !findDeviceVoice(availableDeviceVoices, selectedDeviceVoiceUri, bookLanguageCode)) {
      setSelectedDeviceVoiceUri(DEFAULT_DEVICE_VOICE_URI);
    }
  }, [availableDeviceVoices, bookLanguageCode, selectedDeviceVoiceUri]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(READER_TTS_ENGINE_STORAGE_KEY, selectedTtsEngine);
  }, [selectedTtsEngine]);

  useEffect(() => {
    writeStoredVoiceModel(bookLanguageCode, selectedVoiceModel);
  }, [selectedVoiceModel]);

  useEffect(() => {
    writeStoredDeviceVoiceUri(bookLanguageCode, selectedDeviceVoiceUri);
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
    loadedAudioRef.current = null;
  }, [bookId, chapterId, selectedDeviceVoiceUri, selectedTtsEngine, selectedVoiceModel]);

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

  useEffect(() => {
    if (!isNavigationPanelVisible) {
      return;
    }

    activeNavigationItemRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [chapterId, isNavigationPanelVisible]);

  const isSectionScope = Boolean(chapterId);
  const bookLanguageName = getBookLanguageName(bookLanguageCode);
  const CURRENT_SECTION_SUMMARY_PROMPT = `Eres editor literario. Resume esta sección de un libro en ${bookLanguageName} de manera clara, fiel y compacta. Escribe el resumen en ${bookLanguageName}. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.`;
  const MULTIPLE_SECTIONS_SUMMARY_PROMPT = `Eres editor literario. Resume estas secciones de un libro en ${bookLanguageName} de manera clara, fiel y compacta. Escribe el resumen en ${bookLanguageName}. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.`;
  const ALL_SECTIONS_SUMMARY_PROMPT = `Eres editor literario. Resume las secciones de un libro en ${bookLanguageName} de manera clara, fiel y compacta. Escribe el resumen en ${bookLanguageName}. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.`;
  const GRAPHIC_SUMMARY_PROMPT = `Eres editor literario. Crea un resumen gráfico en ${bookLanguageName} que organice las ideas, hechos, personajes o conceptos principales y muestre claramente sus relaciones. Sé fiel al texto, compacto y no inventes información.`;
  const backToReaderPath = requestsQuery.data?.section
    ? `/books/${bookId}?page=${requestsQuery.data.section.startPageNumber}`
    : `/books/${bookId}`;
  const requests = requestsQuery.data?.requests ?? [];
  const currentUserRole = bookQuery.data?.book.currentUserRole ?? requestsQuery.data?.book.currentUserRole;
  const canCreateRequest = isBookCommenterOrAbove(currentUserRole);
  const sharableUsers = annotationShareUsersQuery.data ?? [];
  const bookTitle = bookQuery.data?.book.title ?? requestsQuery.data?.book.title ?? "Cargando libro...";
  const deepgramBalanceErrorMessage = deepgramBalanceQuery.error instanceof Error
    ? deepgramBalanceQuery.error.message
    : "No se pudo consultar el saldo de Deepgram.";

  const groupedRequests = useMemo(
    () => requests.map((request) => ({
      ...request,
      diagram: request.kind === "DIAGRAM" ? parseAiRequestDiagram(request.responseText) : null,
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
      authorLabel: bookmark.userDisplayName?.trim() || (bookmark.username ? `@${bookmark.username}` : null),
      bookmarkId: bookmark.bookmarkId,
      createdAt: bookmark.createdAt,
      isActive: false,
      isOwnedByCurrentUser: bookmark.isOwnedByCurrentUser ?? true,
      key: `bookmark:${bookmark.bookmarkId}`,
      pageNumber: bookmark.pageNumber,
      paragraphNumber: bookmark.paragraphNumber,
      sharedWithUserIds: bookmark.sharedWithUserIds ?? [],
      title: "Marcador guardado",
      type: "bookmark",
      visibilitySource: bookmark.visibilitySource ?? (bookmark.isOwnedByCurrentUser === false ? "DIRECT" : "OWN")
    }));

    const noteItems: ReaderNavigationListItem[] = (navigationQuery.data?.notes ?? []).map((note) => ({
      authorLabel: note.userDisplayName?.trim() || (note.username ? `@${note.username}` : null),
      color: note.highlightColor,
      excerpt: notePreview(note),
      isActive: false,
      isReadOnly: note.isOwnedByCurrentUser === false,
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      noteText: note.noteText,
      pageNumber: note.pageNumber,
      paragraphNumber: note.paragraphNumber ?? 1,
      sharedWithUserIds: note.sharedWithUserIds ?? [],
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
  const hierarchicalSectionEntries = useMemo(() => {
    const ancestors: Array<{ chapterId: string; level: number }> = [];

    return sectionEntries.map((entry, index) => {
      while (ancestors.length > 0 && (ancestors[ancestors.length - 1]?.level ?? entry.level) >= entry.level) {
        ancestors.pop();
      }

      const ancestorChapterIds = ancestors.map((ancestor) => ancestor.chapterId);
      const hasChildren = (sectionEntries[index + 1]?.level ?? entry.level) > entry.level;
      ancestors.push({ chapterId: entry.chapterId, level: entry.level });

      return { ...entry, ancestorChapterIds, hasChildren };
    });
  }, [sectionEntries]);
  const currentSectionIndex = useMemo(
    () => sectionEntries.findIndex((entry) => entry.chapterId === chapterId),
    [chapterId, sectionEntries]
  );
  const currentSectionNumber = !chapterId ? 0 : currentSectionIndex >= 0 ? currentSectionIndex + 1 : null;
  const currentSectionCounter = currentSectionNumber !== null
    ? `${currentSectionNumber}/${sectionEntries.length}`
    : null;
  const bookAiRequestsHref = `/books/${bookId}/ai-requests`;
  const previousSectionChapterId = currentSectionIndex > 0
    ? sectionEntries[currentSectionIndex - 1]?.chapterId
    : null;
  const previousSectionHref = currentSectionIndex === 0
    ? bookAiRequestsHref
    : previousSectionChapterId
      ? sectionAiRequestsHref(previousSectionChapterId)
      : null;
  const nextSectionChapterId = !chapterId
    ? sectionEntries[0]?.chapterId
    : currentSectionIndex >= 0
      ? sectionEntries[currentSectionIndex + 1]?.chapterId
      : null;
  const nextSectionHref = nextSectionChapterId ? sectionAiRequestsHref(nextSectionChapterId) : null;

  useEffect(() => {
    if (!chapterId) {
      setSelectedChapterIds([]);
      return;
    }

    setSelectedChapterIds([chapterId]);
  }, [chapterId]);

  const selectedChapterIdSet = useMemo(() => new Set(selectedChapterIds), [selectedChapterIds]);
  const selectedChapterCount = selectedChapterIds.length;
  const currentSectionEntry = currentSectionIndex >= 0 ? sectionEntries[currentSectionIndex] ?? null : null;
  const currentSectionPathTitle = useMemo(() => {
    if (currentSectionEntry) {
      return formatSectionTitleWithAncestors(currentSectionEntry, navigationQuery.data?.toc);
    }
    if (requestsQuery.data?.section) {
      return formatSectionTitleWithAncestors(requestsQuery.data.section, navigationQuery.data?.toc);
    }
    return null;
  }, [currentSectionEntry, requestsQuery.data?.section, navigationQuery.data?.toc]);
  const contextTitle = currentSectionPathTitle ?? requestsQuery.data?.book.title ?? "Peticiones IA";
  const rootSectionLevel = sectionEntries.length > 0
    ? sectionEntries.reduce((minimumLevel, entry) => Math.min(minimumLevel, entry.level), sectionEntries[0]?.level ?? 0)
    : 0;
  const selectedSectionSummary = useMemo(() => {
    const selectedTitles = sectionEntries
      .filter((entry) => selectedChapterIdSet.has(entry.chapterId))
      .map((entry) => entry.title);

    if (selectedTitles.length === 0) {
      return "Ningún capítulo seleccionado";
    }
    if (selectedTitles.length <= 2) {
      return selectedTitles.join(", ");
    }
    return `${selectedTitles.slice(0, 2).join(", ")} y ${selectedTitles.length - 2} más`;
  }, [sectionEntries, selectedChapterIdSet]);
  const sectionListHasActiveFilter = sectionSearchText.trim().length > 0 || showOnlySelectedSections;
  const visibleSectionEntries = useMemo(() => {
    const normalizedSearch = sectionSearchText.trim().toLocaleLowerCase("es-ES");
    const isFiltering = normalizedSearch.length > 0 || showOnlySelectedSections;

    if (!isFiltering) {
      return hierarchicalSectionEntries.filter((entry) => !entry.ancestorChapterIds.some((ancestorId) => collapsedSectionIds.has(ancestorId)));
    }

    const visibleChapterIds = new Set<string>();
    for (const entry of hierarchicalSectionEntries) {
      const matchesSearch = !normalizedSearch || entry.title.toLocaleLowerCase("es-ES").includes(normalizedSearch);
      const matchesSelection = !showOnlySelectedSections || selectedChapterIdSet.has(entry.chapterId);
      if (!matchesSearch || !matchesSelection) {
        continue;
      }

      visibleChapterIds.add(entry.chapterId);
      entry.ancestorChapterIds.forEach((ancestorId) => visibleChapterIds.add(ancestorId));
    }

    return hierarchicalSectionEntries.filter((entry) => visibleChapterIds.has(entry.chapterId));
  }, [collapsedSectionIds, hierarchicalSectionEntries, sectionSearchText, selectedChapterIdSet, showOnlySelectedSections]);

  function selectSameLevelPreviousAndCurrentChapterIds() {
    if (!currentSectionEntry || currentSectionIndex < 0) {
      return chapterId ? [chapterId] : [];
    }

    return sectionEntries
      .slice(0, currentSectionIndex + 1)
      .filter((entry) => entry.level === currentSectionEntry.level)
      .map((entry) => entry.chapterId);
  }

  function resetAiRequestFeedback() {
    setSubmitError(null);
    setSubmitStatus(null);
  }

  function selectRequestKind(kind: AiRequestKind) {
    setRequestKind(kind);
    if (kind === "DIAGRAM") {
      setPromptText(GRAPHIC_SUMMARY_PROMPT);
    } else if (promptText === GRAPHIC_SUMMARY_PROMPT) {
      setPromptText(requestsQuery.data?.prompt ?? (isSectionScope ? CURRENT_SECTION_SUMMARY_PROMPT : ""));
    }
    resetAiRequestFeedback();
  }

  function toggleSectionBranch(targetChapterId: string) {
    setCollapsedSectionIds((current) => {
      const next = new Set(current);
      if (next.has(targetChapterId)) {
        next.delete(targetChapterId);
      } else {
        next.add(targetChapterId);
      }
      return next;
    });
  }

  function selectCurrentChapterForAiRequest() {
    if (chapterId) {
      setSelectedChapterIds([chapterId]);
      setPromptText(CURRENT_SECTION_SUMMARY_PROMPT);
      resetAiRequestFeedback();
    }
  }

  function selectPreviousAndCurrentChaptersForAiRequest() {
    if (!chapterId) {
      return;
    }

    setSelectedChapterIds(selectSameLevelPreviousAndCurrentChapterIds());
    setPromptText(MULTIPLE_SECTIONS_SUMMARY_PROMPT);
    resetAiRequestFeedback();
  }

  function selectCurrentWithPreviousContextForAiRequest() {
    if (!chapterId) {
      return;
    }

    const currentSectionTitle = currentSectionPathTitle ?? "actual";
    setSelectedChapterIds(selectSameLevelPreviousAndCurrentChapterIds());
    setPromptText(`Eres editor literario. Resume el capítulo o sección «${currentSectionTitle}», teniendo en cuenta los capítulos anteriores solo para las referencias, si las hubiera, o el contexto. Es un libro en ${bookLanguageName}; escribe el resumen en ${bookLanguageName} de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.`);
    resetAiRequestFeedback();
  }

  function selectAllChaptersForAiRequest() {
    setSelectedChapterIds(sectionEntries.filter((entry) => entry.level === rootSectionLevel).map((entry) => entry.chapterId));
    setPromptText(ALL_SECTIONS_SUMMARY_PROMPT);
    resetAiRequestFeedback();
  }

  function toggleChapterForAiRequest(targetChapterId: string) {
    setSelectedChapterIds((currentChapterIds) => currentChapterIds.includes(targetChapterId)
      ? currentChapterIds.filter((selectedChapterId) => selectedChapterId !== targetChapterId)
      : [...currentChapterIds, targetChapterId]);
    setSubmitError(null);
    setSubmitStatus(null);
  }

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

  async function handleUpdateBookmarkShares(bookmarkId: string, sharedWithUserIds: string[]) {
    if (!accessToken) {
      return;
    }

    await updateBookmarkShares(accessToken, bookId, bookmarkId, sharedWithUserIds);
    await refreshNavigationMetadata();
  }

  async function handleUpdateNoteShares(noteId: string, sharedWithUserIds: string[]) {
    if (!accessToken) {
      return;
    }

    await updateNote(accessToken, bookId, noteId, { sharedWithUserIds });
    await refreshNavigationMetadata();
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
    if (!accessToken || !canCreateRequest || retryAfterSeconds > 0 || isSubmittingRef.current) {
      return;
    }

    if (!promptText.trim()) {
      setSubmitError("La petición no puede estar vacía.");
      return;
    }

    if (isSectionScope && selectedChapterIds.length === 0) {
      setSubmitError("Selecciona al menos un capítulo para enviar la petición.");
      return;
    }

    if (!aiModelSelection.selectedModelId || aiModelSelection.data?.configured !== true) {
      setSubmitError("No se pudo cargar la configuración de modelos de IA.");
      return;
    }

    isSubmittingRef.current = true;
    const progressId = crypto.randomUUID();
    setIsSubmitting(true);
    setSubmitProgressId(progressId);
    setSubmitError(null);
    setSubmitStatus("Enviando petición a OpenCode...");
    prepareCompletionSound();

    try {
      const result = await createAiRequest(accessToken, bookId, {
        ...(chapterId ? { chapterId } : {}),
        ...(chapterId ? { chapterIds: selectedChapterIds } : {}),
        kind: requestKind,
        model: aiModelSelection.selectedModelId,
        progressId,
        promptText: promptText.trim(),
        ...(requestKind === "DIAGRAM" ? { visualType } : {})
      });
      if (!result.request) {
        throw new Error("La IA respondió, pero no se pudo recuperar la petición creada.");
      }
      setEnteringRequestId(result.request.requestId);
      await queryClient.invalidateQueries({ queryKey: ["ai-requests", bookId, chapterId ?? "book"] });
      window.setTimeout(() => {
        setEnteringRequestId((current) => current === result.request?.requestId ? null : current);
      }, AI_REQUEST_CREATION_ANIMATION_MS);
      setSubmitStatus("Petición creada correctamente.");
      playCompletionSound("success");
    } catch (error) {
      setEnteringRequestId(null);
      setSubmitStatus(null);
      if (isRetryableRateLimitError(error)) {
        const retryAfter = error.retryAfterSeconds ?? 15;
        setRetryAfterSeconds(retryAfter);
        setSubmitError(`OpenCode está limitando temporalmente las peticiones. Espera ${retryAfter} segundos antes de volver a intentarlo.`);
      } else if (error instanceof TypeError && /fetch|networkerror|network request/iu.test(error.message)) {
        setSubmitError("Se interrumpió la conexión con la API. Revisa el historial antes de reintentar: la petición podría haber terminado en segundo plano.");
      } else {
        setSubmitError(error instanceof Error ? error.message : "No se pudo crear la petición IA.");
      }
      playCompletionSound("error");
    } finally {
      isSubmittingRef.current = false;
      setSubmitProgressId(null);
      setIsSubmitting(false);
    }
  }

  async function handleDeleteRequest(request: AiRequestRecord) {
    if (!accessToken || deletingRequestId) {
      return;
    }

    const deleteLabel = request.isOwnedByCurrentUser ? "Borrar petición" : "Quitar de mis peticiones";
    const confirmation = request.isOwnedByCurrentUser
      ? "¿Borrar esta petición de IA? Esta acción no se puede deshacer."
      : "¿Quitar esta petición compartida de mis peticiones?";
    if (!window.confirm(confirmation)) {
      return;
    }

    setDeletingRequestId(request.requestId);
    setDeleteError(null);

    try {
      if (
        playingRequestId === request.requestId
        || loadingAudioRequestId === request.requestId
        || loadedAudioRef.current?.requestId === request.requestId
      ) {
        audioRef.current?.pause();
        activeAudioRequestRef.current?.abort();
        getSpeechSynthesisApi()?.cancel();
        deviceUtteranceRef.current = null;
        setPlayingRequestId(null);
        setLoadingAudioRequestId(null);
        setHasActivePlaybackSession(false);
        setIsDevicePaused(false);
        loadedAudioRef.current = null;
        if (audioRef.current) {
          audioRef.current.removeAttribute("src");
          audioRef.current.load();
        }
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }
      }

      await deleteAiRequest(accessToken, bookId, request.requestId);
      setRemovingRequestId(request.requestId);
      await new Promise((resolve) => window.setTimeout(resolve, AI_REQUEST_REMOVAL_ANIMATION_MS));
      await queryClient.invalidateQueries({ queryKey: ["ai-requests", bookId, chapterId ?? "book"] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : `No se pudo ${deleteLabel.toLocaleLowerCase("es-ES")}.`);
    } finally {
      setDeletingRequestId(null);
      setRemovingRequestId(null);
    }
  }

  async function handleUpdateRequestShares(request: AiRequestRecord) {
    if (!accessToken || !request.isOwnedByCurrentUser || updatingSharesRequestId) {
      return;
    }

    const sharedWithUserIds = shareDrafts[request.requestId] ?? request.sharedWithUserIds ?? [];
    setUpdatingSharesRequestId(request.requestId);
    setShareError(null);

    try {
      const result = await updateAiRequestShares(accessToken, bookId, request.requestId, sharedWithUserIds);
      queryClient.setQueryData<AiRequestsResponse>(["ai-requests", bookId, chapterId ?? "book"], (current) => current ? {
        ...current,
        requests: current.requests.map((item) => item.requestId === request.requestId
          ? { ...item, sharedWithUserIds: result.sharedWithUserIds }
          : item)
      } : current);
      setShareDrafts((current) => {
        const next = { ...current };
        delete next[request.requestId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["ai-requests", bookId, chapterId ?? "book"] });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "No se pudo actualizar con quién se comparte la petición.");
    } finally {
      setUpdatingSharesRequestId(null);
    }
  }

  async function handlePlayRequest(request: AiRequestRecord) {
    const audioElement = audioRef.current;
    const speechText = getAiRequestSpeechText(request);
    if (!accessToken || !audioElement || !speechText.trim()) {
      return;
    }

    if (playingRequestId === request.requestId) {
      handlePauseRequest();
      setPlayingRequestId(null);
      return;
    }

    if (
      selectedTtsEngine === "deepgram"
      && loadedAudioRef.current?.requestId === request.requestId
      && loadedAudioRef.current.voiceModel === selectedVoiceModel
      && audioElement.src
    ) {
      setAudioError(null);
      if (audioElement.ended) {
        audioElement.currentTime = 0;
      }
      audioElement.playbackRate = playbackRate;

      try {
        await audioElement.play();
        setPlayingRequestId(request.requestId);
        setHasActivePlaybackSession(true);
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : "No se pudo reanudar la respuesta.");
      }
      return;
    }

    activeAudioRequestRef.current?.abort();
    audioElement.pause();
    loadedAudioRef.current = null;
    audioElement.removeAttribute("src");
    audioElement.load();
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
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

      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.lang = getSpeechLanguage(bookLanguageCode);
      utterance.rate = playbackRate;
      utterance.voice = selectedDeviceVoice ?? pickFallbackDeviceVoice(availableDeviceVoices, bookLanguageCode);
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

      const audioUrl = URL.createObjectURL(blob);
      audioUrlRef.current = audioUrl;
      loadedAudioRef.current = {
        requestId: request.requestId,
        voiceModel: selectedVoiceModel
      };
      audioElement.src = audioUrl;
      audioElement.playbackRate = playbackRate;
      await audioElement.play();
      setPlayingRequestId(request.requestId);
    } catch (error) {
      if (!controller.signal.aborted) {
        setAudioError(error instanceof Error ? error.message : "No se pudo reproducir la respuesta.");
      }
    } finally {
      if (activeAudioRequestRef.current === controller) {
        activeAudioRequestRef.current = null;
      }
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
          <div className="reader-section-summary-ai-model">
            <AiModelBadge feature="ai-requests" label="IA" modelId={aiModelSelection.selectedModelId} />
          </div>
        </div>
      </header>

      {canCreateRequest ? <section className="panel reader-section-summary-panel ai-request-form-panel">
        {aiModelSelection.selectedModelId ? (
          <AiModelSelector
            disabled={isSubmitting || aiModelSelection.data?.configured !== true}
            models={aiModelSelection.models}
            onChange={aiModelSelection.setSelectedModelId}
            value={aiModelSelection.selectedModelId}
          />
        ) : null}
        <fieldset className="ai-request-kind-selector" disabled={isSubmitting || requestsQuery.isLoading}>
          <legend>Formato de respuesta</legend>
          <label className={requestKind === "TEXT" ? "is-selected" : undefined}>
            <input checked={requestKind === "TEXT"} name="ai-request-kind" onChange={() => selectRequestKind("TEXT")} type="radio" />
            <span><strong>Resumen escrito</strong><small>Texto organizado en párrafos</small></span>
          </label>
          <label className={requestKind === "DIAGRAM" ? "is-selected" : undefined}>
            <input checked={requestKind === "DIAGRAM"} name="ai-request-kind" onChange={() => selectRequestKind("DIAGRAM")} type="radio" />
            <span><strong>Esquema gráfico</strong><small>Conceptos y relaciones visuales</small></span>
          </label>
        </fieldset>
        {requestKind === "DIAGRAM" ? (
          <label className="ai-visual-type-selector">
            <span>Tipo de visualización</span>
            <select
              disabled={isSubmitting || requestsQuery.isLoading}
              onChange={(event) => {
                setVisualType(event.target.value as AiVisualType);
                resetAiRequestFeedback();
              }}
              value={visualType}
            >
              {AI_VISUAL_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label} · {option.description}</option>
              ))}
            </select>
            <small>{AI_VISUAL_TYPE_OPTIONS.find((option) => option.value === visualType)?.description}</small>
          </label>
        ) : null}
        <label className="reader-note-composer">
          <span>Petición</span>
          <textarea
            disabled={isSubmitting || requestsQuery.isLoading}
            onChange={(event) => {
              setPromptText(event.target.value);
              setSubmitError(null);
              setSubmitStatus(null);
            }}
            rows={6}
            value={promptText}
          />
        </label>
        {isSectionScope ? (
          <div className="ai-request-section-picker">
            <div className="ai-request-section-picker-header">
              <div>
                <p className="eyebrow">Texto enviado a la IA</p>
                <h3>Capítulos seleccionados</h3>
                <p className="subdued">
                  {selectedChapterCount === 1
                    ? "1 capítulo seleccionado"
                    : `${selectedChapterCount} capítulos seleccionados`}
                </p>
                <p className="ai-request-section-selection-summary">{selectedSectionSummary}</p>
              </div>
              <button
                aria-expanded={isSectionPickerOpen}
                className="secondary-button ai-request-section-picker-toggle"
                disabled={isSubmitting}
                onClick={() => setIsSectionPickerOpen((current) => !current)}
                type="button"
              >
                <span>{isSectionPickerOpen ? "Ocultar" : "Cambiar"}</span>
                <span className="ai-request-section-picker-toggle-icon" data-expanded={isSectionPickerOpen ? "" : undefined}>
                  <ChevronIcon />
                </span>
              </button>
            </div>
            <div className="ai-request-section-picker-actions">
              <button
                className="secondary-button"
                disabled={isSubmitting || !chapterId}
                onClick={selectCurrentChapterForAiRequest}
                type="button"
              >
                Solo este
              </button>
              <button
                className="secondary-button"
                disabled={isSubmitting || !chapterId || sectionEntries.length === 0}
                onClick={selectPreviousAndCurrentChaptersForAiRequest}
                type="button"
              >
                Anteriores y este
              </button>
              <button
                className="secondary-button"
                disabled={isSubmitting || !chapterId || sectionEntries.length === 0}
                onClick={selectCurrentWithPreviousContextForAiRequest}
                type="button"
              >
                Este con contexto anterior
              </button>
              <button
                className="secondary-button"
                disabled={isSubmitting || sectionEntries.length === 0}
                onClick={selectAllChaptersForAiRequest}
                type="button"
              >
                Todos
              </button>
            </div>
            {isSectionPickerOpen ? (
              <div className="ai-request-section-picker-body">
                <div className="ai-request-section-picker-filters">
                  <label className="ai-request-section-search">
                    <span>Buscar sección</span>
                    <input
                      disabled={isSubmitting}
                      onChange={(event) => setSectionSearchText(event.target.value)}
                      placeholder="Escribe parte del título..."
                      type="search"
                      value={sectionSearchText}
                    />
                  </label>
                  <label className="ai-request-section-selected-filter">
                    <input
                      checked={showOnlySelectedSections}
                      disabled={isSubmitting}
                      onChange={(event) => setShowOnlySelectedSections(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Mostrar solo seleccionados</span>
                  </label>
                </div>
                {sectionEntries.length > 0 ? (
                  visibleSectionEntries.length > 0 ? (
                    <div className="ai-request-section-picker-list">
                      {visibleSectionEntries.map((entry) => {
                        const isBranchExpanded = !collapsedSectionIds.has(entry.chapterId);
                        return (
                          <div
                            className="ai-request-section-picker-option"
                            key={entry.chapterId}
                            style={{ "--ai-section-depth": Math.max(0, entry.level - rootSectionLevel) } as CSSProperties}
                          >
                            {entry.hasChildren && !sectionListHasActiveFilter ? (
                              <button
                                aria-expanded={isBranchExpanded}
                                aria-label={isBranchExpanded ? `Contraer ${entry.title}` : `Expandir ${entry.title}`}
                                className="ai-request-section-branch-toggle"
                                disabled={isSubmitting}
                                onClick={() => toggleSectionBranch(entry.chapterId)}
                                title={isBranchExpanded ? "Contraer subsecciones" : "Expandir subsecciones"}
                                type="button"
                              >
                                <span data-expanded={isBranchExpanded ? "" : undefined}><ChevronIcon /></span>
                              </button>
                            ) : (
                              <span className="ai-request-section-branch-spacer" />
                            )}
                            <label className="ai-request-section-picker-option-label">
                              <input
                                checked={selectedChapterIdSet.has(entry.chapterId)}
                                disabled={isSubmitting}
                                onChange={() => toggleChapterForAiRequest(entry.chapterId)}
                                type="checkbox"
                              />
                              <span className="ai-request-section-picker-title">{entry.title}</span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="subdued">No hay secciones que coincidan con los filtros.</p>
                  )
                ) : (
                  <p className="subdued">Cargando capítulos...</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        {submitError ? <p className="error-text" role="alert">{submitError}</p> : null}
        {submitStatus ? <p className="subdued" role="status">{submitStatus}</p> : null}
        <div className="reader-note-editor-actions">
          <button
            className="primary-button"
            disabled={isSubmitting || retryAfterSeconds > 0 || requestsQuery.isLoading || aiModelSelection.data?.configured !== true || !aiModelSelection.selectedModelId || (isSectionScope && selectedChapterIds.length === 0)}
            onClick={() => void handleCreateRequest()}
            type="button"
          >
            {isSubmitting ? "Enviando..." : retryAfterSeconds > 0 ? `Reintentar en ${retryAfterSeconds}s` : "Enviar petición"}
          </button>
        </div>
      </section> : currentUserRole === "VIEWER" ? (
        <section className="panel reader-section-summary-panel ai-request-read-only-notice">
          <p className="subdued">Tu acceso es de solo lectura. Necesitas permiso para comentar para crear peticiones IA.</p>
        </section>
      ) : null}

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

      {deleteError || shareError || audioError || navigationError ? (
        <section className="panel reader-section-summary-panel">
          {deleteError ? <p className="error-text">{deleteError}</p> : null}
          {shareError ? <p className="error-text">{shareError}</p> : null}
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
        const deleteLabel = request.isOwnedByCurrentUser ? "Borrar petición" : "Quitar de mis peticiones";
        const authorLabel = request.author.displayName?.trim() || (request.author.username ? `@${request.author.username}` : "otro usuario");
        const savedSharedWithUserIds = request.sharedWithUserIds ?? [];
        const sharedWithUserIds = shareDrafts[request.requestId] ?? savedSharedWithUserIds;
        const sharesHaveChanges = !haveSameUserIds(sharedWithUserIds, savedSharedWithUserIds);
        return (
          <article
            aria-hidden={removingRequestId === request.requestId ? true : undefined}
            className={removingRequestId === request.requestId
              ? "panel reader-section-summary-panel reader-section-summary-card ai-request-card is-removing"
              : enteringRequestId === request.requestId
                ? "panel reader-section-summary-panel reader-section-summary-card ai-request-card is-entering"
                : "panel reader-section-summary-panel reader-section-summary-card ai-request-card"}
            key={request.requestId}
          >
            <div className="reader-section-summary-card-header">
              <div>
                <p className="eyebrow">{formatDate(request.createdAt)}</p>
                <h3>{request.scopeType === "BOOK" ? "Petición al libro" : request.sectionTitle ?? "Petición a la sección"}</h3>
                {!request.isOwnedByCurrentUser ? (
                  <p className="ai-request-author">Compartida por {authorLabel} · Solo lectura</p>
                ) : null}
              </div>
              <div className="reader-section-summary-card-badges">
                <AiModelBadge feature="ai-requests" label="IA" modelId={request.modelId} size="compact" />
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
                {request.isOwnedByCurrentUser && canCreateRequest && sharableUsers.length > 0 ? (
                  <button
                    aria-expanded={openShareRequestId === request.requestId}
                    aria-label={openShareRequestId === request.requestId ? "Cerrar opciones para compartir petición" : sharedWithUserIds.length > 0 ? `Compartida con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir petición (Privada)"}
                    className={`reader-note-icon-button reader-postit-share-btn ${sharedWithUserIds.length > 0 ? "shared" : ""} ${openShareRequestId === request.requestId ? "active" : ""}`}
                    disabled={updatingSharesRequestId === request.requestId}
                    onClick={() => setOpenShareRequestId((currentId) => currentId === request.requestId ? null : request.requestId)}
                    title={sharedWithUserIds.length > 0 ? `Compartida con ${sharedWithUserIds.length} ${sharedWithUserIds.length === 1 ? "persona" : "personas"}` : "Compartir petición (Privada)"}
                    type="button"
                  >
                    <ShareIcon />
                    {sharedWithUserIds.length > 0 ? <span className="reader-share-badge">{sharedWithUserIds.length}</span> : null}
                  </button>
                ) : null}
                <button
                  aria-label={deleteLabel}
                  className="reader-note-icon-button danger-icon-button"
                  disabled={deletingRequestId === request.requestId}
                  onClick={() => void handleDeleteRequest(request)}
                  title={deleteLabel}
                  type="button"
                >
                  <DeleteIcon />
                </button>
              </div>
            </div>

            {request.isOwnedByCurrentUser && canCreateRequest && sharableUsers.length > 0 && openShareRequestId === request.requestId ? (
              <div className="ai-request-share-editor reader-popover-share-container">
                <ShareWithSelector
                  disabled={updatingSharesRequestId === request.requestId}
                  emptyLabel="Esta petición solo la verás tú (Privada)."
                  label="Compartida con"
                  onChange={(userIds) => {
                    setShareDrafts((current) => ({ ...current, [request.requestId]: userIds }));
                    setShareError(null);
                  }}
                  options={sharableUsers}
                  selected={sharedWithUserIds}
                />
                {sharesHaveChanges ? (
                  <button
                    className="secondary-button ai-request-share-save"
                    disabled={updatingSharesRequestId === request.requestId}
                    onClick={() => void handleUpdateRequestShares(request)}
                    type="button"
                  >
                    {updatingSharesRequestId === request.requestId ? "Guardando..." : "Guardar destinatarios"}
                  </button>
                ) : null}
              </div>
            ) : null}

            <details className="ai-request-prompt-details">
              <summary>Ver petición enviada</summary>
              <p>{request.promptText}</p>
            </details>

            {request.kind === "DIAGRAM" && request.diagram ? (
              <AiRequestDiagram diagram={request.diagram} />
            ) : (
              <div className="reader-section-summary-copy">
                {request.responseParagraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            )}
          </article>
        );
      })}

      {requestsQuery.data ? (
        <div
          aria-label="Controles de lectura de peticiones IA"
          className="reader-floating-controls reader-section-summary-floating-controls"
          role="toolbar"
        >
          <ReaderFloatingAudioPopover
            buttonLabel="Ajustes de audio"
            closeLabel="Cerrar preferencias de audio"
            isOpen={isAudioSettingsVisible}
            menuRef={audioSettingsRef}
            onClose={() => setIsAudioSettingsVisible(false)}
            onToggle={() => setIsAudioSettingsVisible((current) => !current)}
            panelId="ai-requests-audio-settings-panel"
            title="Preferencias de audio"
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
              voiceOptions={ttsVoiceOptions}
            />
          </ReaderFloatingAudioPopover>

          <div
            aria-label={currentSectionNumber !== null ? `Sección ${currentSectionNumber} de ${sectionEntries.length}` : "Contador de secciones"}
            className="reader-floating-status"
          >
            <strong>{currentSectionCounter ?? "-/-"}</strong>
          </div>

          <ReaderNavigationPopover
            aiRequestsHref={bookAiRequestsHref}
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
              onUpdateBookmarkShares={(bookmarkId, sharedWithUserIds) => handleUpdateBookmarkShares(bookmarkId, sharedWithUserIds)}
              onUpdateNoteShares={(noteId, sharedWithUserIds) => handleUpdateNoteShares(noteId, sharedWithUserIds)}
              sharableUsers={sharableUsers}
              summaryHrefBuilder={(targetChapterId) => sectionAiRequestsHref(targetChapterId)}
            />
          </ReaderNavigationPopover>

          <button
            aria-label="Sección anterior"
            className="reader-float-button"
            disabled={!previousSectionHref}
            onClick={() => {
              if (previousSectionHref) {
                navigate(previousSectionHref);
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
            disabled={!nextSectionHref}
            onClick={() => {
              if (nextSectionHref) {
                navigate(nextSectionHref);
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
