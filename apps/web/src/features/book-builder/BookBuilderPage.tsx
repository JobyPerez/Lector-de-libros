import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  appendImagesToBook,
  createImageBook,
  fetchAppendImagesImportProgress,
  fetchBookPage,
  fetchBookPageImage,
  fetchBooks,
  fetchReaderNavigation,
  rerunOcrPage,
  updateOcrPage,
  type AppendImagesImportProgress,
  type ImageOcrMode,
  type ReaderBookmark,
  type ReaderNote,
  type ReaderTocEntry,
  type HighlightColor
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { buildOcrPreviewHtml } from "./ocr-preview";

function BackIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 12H7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M12 7L7 12L12 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </svg>
  );
}

function ToolbarIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

function NavigationIcon() {
  return (
    <ToolbarIcon>
      <path d="M5.5 7.25H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 12H18.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.5 16.75H14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="17.5" cy="16.75" fill="currentColor" r="1.2" />
    </ToolbarIcon>
  );
}

function CloseIcon() {
  return (
    <ToolbarIcon>
      <path d="M8 8L16 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M16 8L8 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function PagePreviousIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M17 7L10 12L17 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function PageNextIcon() {
  return (
    <ToolbarIcon>
      <path d="M17 5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M7 7L14 12L7 17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function SaveOcrIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 5.5H15.8L18.5 8.2V18C18.5 18.8284 17.8284 19.5 17 19.5H7C6.17157 19.5 5.5 18.8284 5.5 18V7C5.5 6.17157 6.17157 5.5 7 5.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8.5 5.5V10H14.5V5.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 15H15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

function FilesIcon() {
  return (
    <ToolbarIcon>
      <path d="M8 6.5H13.8L16.5 9.2V17C16.5 17.8284 15.8284 18.5 15 18.5H8C7.17157 18.5 6.5 17.8284 6.5 17V8C6.5 7.17157 7.17157 6.5 8 6.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.5 6.7V9.5H16.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10 11.5H13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10 14.5H13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M16.5 10.5H18C18.8284 10.5 19.5 11.1716 19.5 12V16C19.5 16.8284 18.8284 17.5 18 17.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

function CameraIcon() {
  return (
    <ToolbarIcon>
      <path d="M7.5 8.5H9.2L10.4 6.8H13.6L14.8 8.5H16.5C17.6046 8.5 18.5 9.39543 18.5 10.5V16C18.5 17.1046 17.6046 18 16.5 18H7.5C6.39543 18 5.5 17.1046 5.5 16V10.5C5.5 9.39543 6.39543 8.5 7.5 8.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="12" cy="13.2" r="2.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 8.5L9.8 7.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

function cameraDevicePriority(device: MediaDeviceInfo) {
  const label = device.label.trim().toLowerCase();

  if (!label) {
    return 50;
  }

  let priority = 0;

  if (/(enlace|phone link|link to windows|movil|m[oó]vil|telefono|tel[eé]fono|virtual|obs|droidcam|epoccam|iriun|snap camera|camo)/iu.test(label)) {
    priority += 100;
  }

  if (/(webcam|integrated|integrada|built-in|builtin|hd webcam|usb camera|logitech|facetime|camera)/iu.test(label)) {
    priority -= 20;
  }

  return priority;
}

function choosePreferredCameraDevice(devices: MediaDeviceInfo[], currentDeviceId?: string) {
  const videoInputs = devices.filter((device) => device.kind === "videoinput");
  if (videoInputs.length === 0) {
    return null;
  }

  return [...videoInputs]
    .sort((left, right) => {
      const priorityDiff = cameraDevicePriority(left) - cameraDevicePriority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      if (currentDeviceId && left.deviceId === currentDeviceId) {
        return -1;
      }

      if (currentDeviceId && right.deviceId === currentDeviceId) {
        return 1;
      }

      return left.label.localeCompare(right.label, "es");
    })[0];
}

type ReviewNavigationItem =
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

function tocEntryKey(entry: ReaderTocEntry) {
  return `${entry.pageNumber}:${entry.paragraphNumber}:${entry.title}`;
}

function highlightClassName(color: HighlightColor) {
  switch (color) {
    case "GREEN":
      return "reader-text-highlight-green";
    case "BLUE":
      return "reader-text-highlight-blue";
    case "PINK":
      return "reader-text-highlight-pink";
    case "YELLOW":
    default:
      return "reader-text-highlight-yellow";
  }
}

type ReviewTextAlignment = "center" | "left" | "right";
type AppendInsertionSide = "before" | "after";

const reviewAlignmentMarkerPattern = /^::(left|center|right)::\s*/u;
const reviewHeadingMarkerPattern = /^(#{1,6})\s+/u;

function parseReviewAlignmentMarker(value: string): { alignment: ReviewTextAlignment | null; content: string } {
  const match = value.match(reviewAlignmentMarkerPattern);
  if (!match) {
    return { alignment: null, content: value };
  }

  return {
    alignment: match[1] as ReviewTextAlignment,
    content: value.slice(match[0].length)
  };
}

function findReviewBlockStart(value: string, index: number) {
  const cursor = Math.max(0, Math.min(index, value.length));
  const separatorPattern = /\n{2,}/gu;
  let start = 0;
  let match = separatorPattern.exec(value);

  while (match && match.index < cursor) {
    start = match.index + match[0].length;
    match = separatorPattern.exec(value);
  }

  return start;
}

function findReviewBlockEnd(value: string, index: number) {
  const cursor = Math.max(0, Math.min(index, value.length));
  const match = value.slice(cursor).match(/\n{2,}/u);
  return match && typeof match.index === "number" ? cursor + match.index : value.length;
}

function detectReviewSelectionAlignment(value: string, selectionStart: number, selectionEnd: number): ReviewTextAlignment | null {
  if (!value.trim()) {
    return null;
  }

  const blockStart = findReviewBlockStart(value, selectionStart);
  const blockEnd = findReviewBlockEnd(value, selectionEnd);
  const blocks = value
    .slice(blockStart, blockEnd)
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return null;
  }

  const alignments = blocks.map((block) => parseReviewAlignmentMarker(block).alignment);
  const firstAlignment = alignments[0] ?? null;
  return alignments.every((alignment) => alignment === firstAlignment) ? firstAlignment : null;
}

function stripReviewHeadingMarker(value: string) {
  return value.replace(reviewHeadingMarkerPattern, "");
}

export function BookBuilderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [createForm, setCreateForm] = useState({ authorName: "", synopsis: "", title: "" });
  const [selectedCreateFiles, setSelectedCreateFiles] = useState<File[]>([]);
  const [selectedAppendFiles, setSelectedAppendFiles] = useState<File[]>([]);
  const [selectedBookId, setSelectedBookId] = useState("");
  const [reviewBookId, setReviewBookId] = useState("");
  const [reviewPageNumber, setReviewPageNumber] = useState(1);
  const [editedText, setEditedText] = useState("");
  const [originalEditedText, setOriginalEditedText] = useState("");
  const [createOcrMode, setCreateOcrMode] = useState<ImageOcrMode>("VISION");
  const [appendOcrMode, setAppendOcrMode] = useState<ImageOcrMode>("VISION");
  const [appendInsertionSide, setAppendInsertionSide] = useState<AppendInsertionSide>("after");
  const [appendReferencePageInput, setAppendReferencePageInput] = useState("1");
  const [appendProgressId, setAppendProgressId] = useState<string | null>(null);
  const [appendImportProgress, setAppendImportProgress] = useState<AppendImagesImportProgress | null>(null);
  const [isAppendCameraModalOpen, setIsAppendCameraModalOpen] = useState(false);
  const [appendCameraStream, setAppendCameraStream] = useState<MediaStream | null>(null);
  const [isAppendCameraStarting, setIsAppendCameraStarting] = useState(false);
  const [isAppendCameraCapturing, setIsAppendCameraCapturing] = useState(false);
  const [reviewOcrMode, setReviewOcrMode] = useState<ImageOcrMode>("VISION");
  const [createError, setCreateError] = useState<string | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isRerunningOcr, setIsRerunningOcr] = useState(false);
  const [isReviewIndexVisible, setIsReviewIndexVisible] = useState(false);
  const [isReviewOcrMenuVisible, setIsReviewOcrMenuVisible] = useState(false);
  const [isReviewPageJumpActive, setIsReviewPageJumpActive] = useState(false);
  const [reviewSelectedAlignment, setReviewSelectedAlignment] = useState<ReviewTextAlignment | null>(null);
  const [reviewPageJumpValue, setReviewPageJumpValue] = useState("1");
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);
  const reviewEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const reviewPageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const reviewIndexPanelRef = useRef<HTMLElement | null>(null);
  const reviewIndexToggleRef = useRef<HTMLButtonElement | null>(null);
  const appendCameraInputRef = useRef<HTMLInputElement | null>(null);
  const appendCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const appendCameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestedAppendBookId = searchParams.get("appendBookId")?.trim() ?? "";
  const requestedInsertAfterPageParam = searchParams.get("insertAfterPage")?.trim() ?? "";
  const requestedReviewBookId = searchParams.get("reviewBookId")?.trim() ?? "";
  const requestedReviewPageParam = searchParams.get("reviewPage")?.trim() ?? "";
  const returnTo = typeof location.state === "object"
    && location.state !== null
    && "returnTo" in location.state
    && typeof location.state.returnTo === "string"
      ? location.state.returnTo
      : null;
  const isAppendOnlyMode = requestedAppendBookId.length > 0;
  const isReviewOnlyMode = requestedReviewBookId.length > 0;
  const booksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["builder-books"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      const response = await fetchBooks(accessToken);
      return response.books;
    }
  });

  const imageBooks = (booksQuery.data ?? []).filter((book) => book.sourceType === "IMAGES");
  const selectedReviewBook = imageBooks.find((book) => book.bookId === reviewBookId) ?? null;
  const selectedAppendBook = imageBooks.find((book) => book.bookId === selectedBookId) ?? null;
  const requestedReviewPage = requestedReviewPageParam ? Number(requestedReviewPageParam) : Number.NaN;
  const requestedInsertAfterPage = requestedInsertAfterPageParam ? Number(requestedInsertAfterPageParam) : Number.NaN;
  const appendReferencePageMax = Math.max(selectedAppendBook?.totalPages ?? 1, 1);
  const initialAppendReferencePage = selectedAppendBook && selectedAppendBook.bookId === requestedAppendBookId && Number.isInteger(requestedInsertAfterPage)
    ? Math.min(Math.max(requestedInsertAfterPage, 1), appendReferencePageMax)
    : undefined;
  const parsedAppendReferencePageInput = Number.parseInt(appendReferencePageInput, 10);
  const appendReferencePageNumber = Number.isFinite(parsedAppendReferencePageInput)
    ? Math.min(Math.max(parsedAppendReferencePageInput, 1), appendReferencePageMax)
    : initialAppendReferencePage;
  const appendAfterPageNumber = appendReferencePageNumber === undefined
    ? undefined
    : appendInsertionSide === "before"
      ? Math.max(appendReferencePageNumber - 1, 0)
      : appendReferencePageNumber;

  useEffect(() => {
    setAppendInsertionSide("after");
  }, [requestedAppendBookId, requestedInsertAfterPageParam]);

  useEffect(() => {
    if (initialAppendReferencePage !== undefined) {
      setAppendReferencePageInput(String(initialAppendReferencePage));
    }
  }, [initialAppendReferencePage]);

  useEffect(() => {
    if (!isAppendCameraModalOpen || !appendCameraStream || !appendCameraVideoRef.current) {
      return;
    }

    const videoElement = appendCameraVideoRef.current;
    videoElement.srcObject = appendCameraStream;
    void videoElement.play().catch(() => undefined);

    return () => {
      videoElement.pause();
      videoElement.srcObject = null;
    };
  }, [appendCameraStream, isAppendCameraModalOpen]);

  useEffect(() => {
    if (!isAppendCameraModalOpen || typeof document === "undefined") {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isAppendCameraCapturing) {
        closeAppendCameraModal();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAppendCameraCapturing, isAppendCameraModalOpen]);

  useEffect(() => {
    if (!isAppending || !appendProgressId || !accessToken) {
      return;
    }

    let cancelled = false;

    const pollProgress = async () => {
      try {
        const response = await fetchAppendImagesImportProgress(accessToken, appendProgressId);
        if (!cancelled) {
          setAppendImportProgress(response.progress);
        }
      } catch {
        // Ignore polling failures while the main request is still in progress.
      }
    };

    void pollProgress();
    const intervalId = window.setInterval(() => {
      void pollProgress();
    }, 800);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, appendProgressId, isAppending]);

  const reviewPageQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-page", reviewBookId, reviewPageNumber],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchBookPage(accessToken, reviewBookId, reviewPageNumber);
    }
  });

  const reviewNavigationQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-navigation", reviewBookId],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchReaderNavigation(accessToken, reviewBookId);
    }
  });

  useEffect(() => {
    const firstImageBook = imageBooks[0];
    const hasRequestedAppendBook = requestedAppendBookId
      ? imageBooks.some((book) => book.bookId === requestedAppendBookId)
      : false;
    const requestedReviewBook = requestedReviewBookId
      ? imageBooks.find((book) => book.bookId === requestedReviewBookId) ?? null
      : null;

    if (!firstImageBook) {
      setSelectedBookId("");
      setReviewBookId("");
      return;
    }

    if (!selectedBookId) {
      if (hasRequestedAppendBook) {
        setSelectedBookId(requestedAppendBookId);
      } else {
        setSelectedBookId(firstImageBook.bookId);
      }
    } else if (!imageBooks.some((book) => book.bookId === selectedBookId)) {
      setSelectedBookId(firstImageBook.bookId);
    }

    if (!isReviewOnlyMode) {
      setReviewBookId("");
      return;
    }

    if (!reviewBookId) {
      if (requestedReviewBook) {
        setReviewBookId(requestedReviewBook.bookId);
        setReviewPageNumber(
          Number.isInteger(requestedReviewPage)
            ? Math.min(Math.max(requestedReviewPage, 1), requestedReviewBook.totalPages)
            : 1
        );
      } else {
        setReviewBookId(firstImageBook.bookId);
        setReviewPageNumber(1);
      }
    } else if (!imageBooks.some((book) => book.bookId === reviewBookId)) {
      setReviewBookId(firstImageBook.bookId);
      setReviewPageNumber(1);
    }
  }, [imageBooks, isReviewOnlyMode, requestedAppendBookId, requestedReviewBookId, requestedReviewPage, reviewBookId, selectedBookId]);

  useEffect(() => {
    const page = reviewPageQuery.data?.page;

    if (!page) {
      return;
    }

    const nextEditedText = page.editedText ?? page.rawText ?? page.paragraphs.map((paragraph) => paragraph.paragraphText).join("\n\n");
    setEditedText(nextEditedText);
    setOriginalEditedText(nextEditedText);
    setReviewSelectedAlignment(null);
    setReviewError(null);
  }, [reviewBookId, reviewPageNumber, reviewPageQuery.data?.page]);

  useEffect(() => {
    if (isReviewPageJumpActive) {
      return;
    }

    setReviewPageJumpValue(String(reviewPageNumber));
  }, [isReviewPageJumpActive, reviewPageNumber]);

  useEffect(() => {
    if (!isReviewPageJumpActive || typeof window === "undefined") {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      reviewPageJumpInputRef.current?.focus();
      reviewPageJumpInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isReviewPageJumpActive]);

  useEffect(() => {
    let active = true;
    let nextObjectUrl: string | null = null;

    if (!isReviewOnlyMode || !accessToken || !reviewBookId || !reviewPageQuery.data?.page.hasSourceImage) {
      setReviewImageUrl(null);
      return () => {
        active = false;
      };
    }

    void fetchBookPageImage(accessToken, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.sourceFileId)
      .then((imageBlob) => {
        if (!active) {
          return;
        }

        nextObjectUrl = URL.createObjectURL(imageBlob);
        setReviewImageUrl(nextObjectUrl);
      })
      .catch(() => {
        if (active) {
          setReviewImageUrl(null);
        }
      });

    return () => {
      active = false;
      if (nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
      }
    };
  }, [accessToken, isReviewOnlyMode, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.hasSourceImage, reviewPageQuery.data?.page.sourceFileId]);

  useEffect(() => {
    if (!isReviewIndexVisible || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (reviewIndexPanelRef.current?.contains(target) || reviewIndexToggleRef.current?.contains(target)) {
        return;
      }

      setIsReviewIndexVisible(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isReviewIndexVisible]);

  function toFileArray(fileList: FileList | null): File[] {
    return fileList ? Array.from(fileList) : [];
  }

  function isSupportedImageFile(file: File): boolean {
    const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    const normalizedName = file.name.toLowerCase();

    return supportedMimeTypes.has(file.type) || /\.(jpe?g|png|webp)$/u.test(normalizedName);
  }

  function appendFiles(files: File[]) {
    const validFiles = files.filter(isSupportedImageFile);
    const invalidFiles = files.filter((file) => !isSupportedImageFile(file));

    setSelectedAppendFiles((currentFiles) => [...currentFiles, ...validFiles]);

    if (invalidFiles.length > 0) {
      const invalidNames = invalidFiles.map((file) => file.name).join(", ");
      setAppendError(`Algunas imágenes no se pueden usar todavía (${invalidNames}). Usa PNG, JPG o WEBP.`);
      return;
    }

    setAppendError(null);
  }

  function handleAppendFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    appendFiles(toFileArray(event.target.files));
    event.target.value = "";
  }

  function stopAppendCameraStream() {
    setAppendCameraStream((currentStream) => {
      currentStream?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }

  function closeAppendCameraModal() {
    setIsAppendCameraCapturing(false);
    setIsAppendCameraStarting(false);
    setIsAppendCameraModalOpen(false);
    stopAppendCameraStream();
  }

  function shouldPreferNativeCameraCapture() {
    if (typeof navigator === "undefined") {
      return false;
    }

    return /Android|iPhone|iPad|iPod|Mobile/iu.test(navigator.userAgent);
  }

  async function handleOpenAppendCamera() {
    if (isAppending || isAppendCameraStarting) {
      return;
    }

    if (shouldPreferNativeCameraCapture()) {
      appendCameraInputRef.current?.click();
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setAppendError("Este navegador no puede abrir la camara en escritorio. Usa la subida de archivos o prueba otro navegador.");
      return;
    }

    setAppendError(null);
    setIsAppendCameraStarting(true);

    try {
      const initialStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: true
      });

      const currentTrack = initialStream.getVideoTracks()[0] ?? null;
      const currentDeviceId = currentTrack?.getSettings().deviceId;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const preferredDevice = choosePreferredCameraDevice(devices, currentDeviceId);

      let stream = initialStream;
      if (preferredDevice?.deviceId && preferredDevice.deviceId !== currentDeviceId) {
        try {
          const preferredStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              deviceId: { exact: preferredDevice.deviceId }
            }
          });

          initialStream.getTracks().forEach((track) => track.stop());
          stream = preferredStream;
        } catch {
          stream = initialStream;
        }
      }

      setAppendCameraStream(stream);
      setIsAppendCameraModalOpen(true);
    } catch {
      setAppendError("No se pudo abrir la camara. Revisa el permiso del navegador y que haya una webcam disponible.");
    } finally {
      setIsAppendCameraStarting(false);
    }
  }

  function handleCaptureAppendCameraFrame() {
    const videoElement = appendCameraVideoRef.current;
    const canvasElement = appendCameraCanvasRef.current;

    if (!videoElement || !canvasElement || videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
      setAppendError("La camara todavia no esta lista para capturar una imagen.");
      return;
    }

    const renderingContext = canvasElement.getContext("2d");
    if (!renderingContext) {
      setAppendError("No se pudo capturar la imagen de la camara.");
      return;
    }

    setIsAppendCameraCapturing(true);
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    renderingContext.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);

    canvasElement.toBlob((blob) => {
      if (!blob) {
        setAppendError("No se pudo capturar la imagen de la camara.");
        setIsAppendCameraCapturing(false);
        return;
      }

      const fileName = `camara-${new Date().toISOString().replace(/[:.]/gu, "-")}.jpg`;
      appendFiles([new File([blob], fileName, { type: "image/jpeg" })]);
      closeAppendCameraModal();
    }, "image/jpeg", 0.92);
  }

  function clearAppendSelection() {
    setSelectedAppendFiles([]);
    setAppendError(null);
  }

  function handleAppendReferencePageInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const rawValue = Number.parseInt(event.target.value, 10);
    const nextValue = Number.isFinite(rawValue)
      ? Math.min(Math.max(rawValue, 1), appendReferencePageMax)
      : 1;

    setAppendReferencePageInput(String(nextValue));
  }

  function removeAppendFile(indexToRemove: number) {
    setSelectedAppendFiles((currentFiles) => currentFiles.filter((_, index) => index !== indexToRemove));
    setAppendError(null);
  }

  function describeOcrMode(mode: ImageOcrMode): string {
    return mode === "VISION"
      ? "Más preciso para fotos difíciles y páginas con ruido. Tarda más."
      : "Más rápido para páginas limpias. También recorta encabezado y pie antes del OCR.";
  }

  async function handleCreateFromImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    if (selectedCreateFiles.length === 0) {
      setCreateError("Selecciona al menos una imagen para crear el libro.");
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const formData = new FormData();
      formData.append("title", createForm.title);

      if (createForm.authorName) {
        formData.append("authorName", createForm.authorName);
      }

      if (createForm.synopsis) {
        formData.append("synopsis", createForm.synopsis);
      }

      for (const file of selectedCreateFiles) {
        formData.append("images", file);
      }

      const response = await createImageBook(accessToken, formData, { ocrMode: createOcrMode });
      await booksQuery.refetch();
      setReviewBookId(response.book.bookId);
      setReviewPageNumber(1);
      navigate(`/books/${response.book.bookId}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro desde imágenes.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleAppendImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    if (!selectedBookId) {
      setAppendError("Selecciona un libro de imágenes existente.");
      return;
    }

    if (selectedAppendFiles.length === 0) {
      setAppendError("Selecciona al menos una imagen adicional.");
      return;
    }

    setIsAppending(true);
    setAppendError(null);
    const progressId = crypto.randomUUID();
    setAppendProgressId(progressId);
    setAppendImportProgress({
      bookId: selectedBookId,
      completedFiles: 0,
      currentFileIndex: selectedAppendFiles.length > 0 ? 0 : null,
      currentFileName: selectedAppendFiles[0]?.name ?? null,
      errorMessage: null,
      stage: "ocr",
      totalFiles: selectedAppendFiles.length
    });

    try {
      const formData = new FormData();
      for (const file of selectedAppendFiles) {
        formData.append("images", file);
      }

      const response = await appendImagesToBook(accessToken, selectedBookId, formData, {
        ...(appendAfterPageNumber !== undefined ? { afterPage: appendAfterPageNumber } : {}),
        ocrMode: appendOcrMode,
        progressId
      });
      await booksQuery.refetch();
      clearAppendSelection();
      if (reviewBookId === selectedBookId) {
        setReviewPageNumber(response.insertionStartPageNumber);
      }
      navigate(`/books/${response.book.bookId}?page=${response.insertionStartPageNumber}`);
    } catch (error) {
      setAppendError(error instanceof Error ? error.message : "No se pudieron añadir nuevas páginas.");
    } finally {
      setIsAppending(false);
      setAppendProgressId(null);
      setAppendImportProgress(null);
    }
  }

  async function handleSaveOcr(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || !reviewBookId) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);

    try {
      await updateOcrPage(accessToken, reviewBookId, reviewPageNumber, { editedText });
      setOriginalEditedText(editedText);
      setReviewMessage("El texto OCR de la página se actualizó correctamente.");
      await Promise.all([reviewPageQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo guardar la edición OCR.");
    } finally {
      setIsSavingReview(false);
    }
  }

  async function handleRerunOcr(modeOverride?: ImageOcrMode) {
    if (!accessToken || !reviewBookId) {
      return;
    }

    const nextMode = modeOverride ?? reviewOcrMode;

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);
    setIsRerunningOcr(true);
    setIsReviewOcrMenuVisible(false);

    try {
      setReviewOcrMode(nextMode);
      await rerunOcrPage(accessToken, reviewBookId, reviewPageNumber, { ocrMode: nextMode });
      setReviewMessage("El OCR de la página se volvió a reconocer correctamente.");
      await Promise.all([reviewPageQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo volver a reconocer el OCR de la página.");
    } finally {
      setIsRerunningOcr(false);
      setIsSavingReview(false);
    }
  }

  function changeReviewPage(delta: -1 | 1) {
    const totalPages = selectedReviewBook?.totalPages ?? 0;
    setReviewPageNumber((currentPage) => {
      const nextPage = currentPage + delta;
      return Math.min(Math.max(nextPage, 1), Math.max(totalPages, 1));
    });
    setReviewMessage(null);
    setReviewError(null);
  }

  function jumpToReviewPage(pageNumber: number) {
    const totalPages = selectedReviewBook?.totalPages ?? 0;
    setReviewPageNumber(Math.min(Math.max(pageNumber, 1), Math.max(totalPages, 1)));
    setReviewMessage(null);
    setReviewError(null);
    setIsReviewIndexVisible(false);
  }

  function cancelReviewPageJump() {
    setIsReviewPageJumpActive(false);
    setReviewPageJumpValue(String(reviewPageNumber));
  }

  function parseReviewPageJumpValue() {
    const parsedValue = Number.parseInt(reviewPageJumpValue.trim(), 10);
    if (!Number.isFinite(parsedValue)) {
      return null;
    }

    const totalPages = selectedReviewBook?.totalPages ?? 0;
    return Math.min(Math.max(parsedValue, 1), Math.max(totalPages, 1));
  }

  function handleReviewPageJumpSubmit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const nextPageNumber = parseReviewPageJumpValue();
    if (nextPageNumber === null) {
      cancelReviewPageJump();
      return;
    }

    setIsReviewPageJumpActive(false);
    jumpToReviewPage(nextPageNumber);
  }

  function handleBackFromReview() {
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    if (selectedReviewBook) {
      navigate(`/books/${selectedReviewBook.bookId}?page=${reviewPageNumber}`);
      return;
    }

    navigate("/");
  }

  function handleBackFromAppend() {
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    if (selectedAppendBook) {
      const pageQuery = appendAfterPageNumber && appendAfterPageNumber > 0
        ? `?page=${appendAfterPageNumber}`
        : "";
      navigate(`/books/${selectedAppendBook.bookId}${pageQuery}`);
      return;
    }

    navigate("/");
  }

  function syncReviewSelectedAlignment(selectionStart: number, selectionEnd: number, nextValue = editedText) {
    setReviewSelectedAlignment(detectReviewSelectionAlignment(nextValue, selectionStart, selectionEnd));
  }

  function updateReviewEditor(nextValue: string, selectionStart: number, selectionEnd: number) {
    setEditedText(nextValue);
    syncReviewSelectedAlignment(selectionStart, selectionEnd, nextValue);

    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        reviewEditorRef.current?.focus();
        reviewEditorRef.current?.setSelectionRange(selectionStart, selectionEnd);
      });
    }
  }

  function toggleReviewInlineFormat(marker: "**" | "*") {
    const editor = reviewEditorRef.current;
    if (!editor) {
      return;
    }

    const selectionStart = editor.selectionStart ?? 0;
    const selectionEnd = editor.selectionEnd ?? selectionStart;
    const hasSelection = selectionEnd > selectionStart;
    const selectedText = editedText.slice(selectionStart, selectionEnd);
    const markerLength = marker.length;
    const hasWrappedSelection = hasSelection
      && selectionStart >= markerLength
      && editedText.slice(selectionStart - markerLength, selectionStart) === marker
      && editedText.slice(selectionEnd, selectionEnd + markerLength) === marker;

    if (hasWrappedSelection) {
      const nextValue = `${editedText.slice(0, selectionStart - markerLength)}${selectedText}${editedText.slice(selectionEnd + markerLength)}`;
      updateReviewEditor(nextValue, selectionStart - markerLength, selectionEnd - markerLength);
      return;
    }

    const content = hasSelection ? selectedText : "texto";
    const wrapped = `${marker}${content}${marker}`;
    const nextValue = `${editedText.slice(0, selectionStart)}${wrapped}${editedText.slice(selectionEnd)}`;
    const nextSelectionStart = selectionStart + markerLength;
    const nextSelectionEnd = nextSelectionStart + content.length;
    updateReviewEditor(nextValue, nextSelectionStart, nextSelectionEnd);
  }

  function toggleReviewHeading(level: 1 | 2) {
    const editor = reviewEditorRef.current;
    if (!editor) {
      return;
    }

    const selectionStart = editor.selectionStart ?? 0;
    const selectionEnd = editor.selectionEnd ?? selectionStart;
    const blockStart = findReviewBlockStart(editedText, selectionStart);
    const blockEnd = findReviewBlockEnd(editedText, selectionEnd);
    const selectedText = editedText.slice(blockStart, blockEnd);
    const segments = selectedText.split(/(\n{2,})/u);
    const marker = `${"#".repeat(level)} `;

    const currentLevels = segments
      .filter((segment, index) => index % 2 === 0)
      .map((segment) => {
        const trimmedSegment = segment.trim();
        if (!trimmedSegment) {
          return null;
        }

        const parsedSegment = parseReviewAlignmentMarker(trimmedSegment);
        const headingMatch = parsedSegment.content.match(reviewHeadingMarkerPattern);
        return headingMatch ? headingMatch[1].length : 0;
      })
      .filter((segmentLevel): segmentLevel is number => segmentLevel !== null);

    const shouldRemoveHeading = currentLevels.length > 0 && currentLevels.every((segmentLevel) => segmentLevel === level);
    const nextSelectedText = segments.map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }

      const trimmedSegment = segment.trim();
      if (!trimmedSegment) {
        return segment;
      }

      const parsedSegment = parseReviewAlignmentMarker(trimmedSegment);
      const contentWithoutHeading = stripReviewHeadingMarker(parsedSegment.content).trim();
      const content = shouldRemoveHeading ? contentWithoutHeading : `${marker}${contentWithoutHeading}`;
      return parsedSegment.alignment ? `::${parsedSegment.alignment}:: ${content}` : content;
    }).join("");

    const nextValue = `${editedText.slice(0, blockStart)}${nextSelectedText}${editedText.slice(blockEnd)}`;
    updateReviewEditor(nextValue, blockStart, blockStart + nextSelectedText.length);
  }

  function insertReviewImageTemplate() {
    const editor = reviewEditorRef.current;
    if (!editor) {
      return;
    }

    const selectionStart = editor.selectionStart ?? 0;
    const selectionEnd = editor.selectionEnd ?? selectionStart;
    const selectedText = editedText.slice(selectionStart, selectionEnd).trim();
    const imageTemplate = `![${selectedText || "descripción"}](url)`;
    const nextValue = `${editedText.slice(0, selectionStart)}${imageTemplate}${editedText.slice(selectionEnd)}`;
    const altStart = selectionStart + 2;
    const altEnd = altStart + (selectedText || "descripción").length;
    updateReviewEditor(nextValue, altStart, altEnd);
  }

  function applyReviewAlignment(alignment: ReviewTextAlignment) {
    const editor = reviewEditorRef.current;
    if (!editor) {
      return;
    }

    const selectionStart = editor.selectionStart ?? 0;
    const selectionEnd = editor.selectionEnd ?? selectionStart;
    const blockStart = findReviewBlockStart(editedText, selectionStart);
    const blockEnd = findReviewBlockEnd(editedText, selectionEnd);
    const selectedText = editedText.slice(blockStart, blockEnd);
    const segments = selectedText.split(/(\n{2,})/u);

    const currentAlignments = segments
      .filter((segment, index) => index % 2 === 0)
      .map((segment) => parseReviewAlignmentMarker(segment.trim()).alignment)
      .filter((segmentAlignment): segmentAlignment is ReviewTextAlignment => segmentAlignment !== null);
    const shouldRemoveAlignment = currentAlignments.length > 0 && currentAlignments.every((segmentAlignment) => segmentAlignment === alignment);

    const nextSelectedText = segments.map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }

      const trimmedSegment = segment.trim();
      if (!trimmedSegment) {
        return segment;
      }

      const parsedSegment = parseReviewAlignmentMarker(trimmedSegment);
      if (shouldRemoveAlignment) {
        return parsedSegment.content.trim();
      }

      return `::${alignment}:: ${parsedSegment.content.trim()}`;
    }).join("");

    const nextEditedText = `${editedText.slice(0, blockStart)}${nextSelectedText}${editedText.slice(blockEnd)}`;
    setReviewSelectedAlignment(shouldRemoveAlignment ? null : alignment);
    updateReviewEditor(nextEditedText, blockStart, blockStart + nextSelectedText.length);
  }

  const isReviewDirty = editedText !== originalEditedText;
  const reviewPreviewHtml = useMemo(
    () => buildOcrPreviewHtml(editedText, reviewPageQuery.data?.page.htmlContent ?? null),
    [editedText, reviewPageQuery.data?.page.htmlContent]
  );
  const activeTocEntryKey = useMemo(() => {
    const tocEntries = reviewNavigationQuery.data?.toc ?? [];
    let activeEntry: ReaderTocEntry | null = null;

    for (const entry of tocEntries) {
      if (entry.pageNumber <= reviewPageNumber) {
        activeEntry = entry;
      }
    }

    return activeEntry ? tocEntryKey(activeEntry) : null;
  }, [reviewNavigationQuery.data?.toc, reviewPageNumber]);
  const orderedNavigationItems = useMemo<ReviewNavigationItem[]>(() => {
    const tocItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.toc ?? []).map((entry) => ({
      isActive: activeTocEntryKey === tocEntryKey(entry),
      key: `toc:${tocEntryKey(entry)}`,
      level: entry.level,
      pageNumber: entry.pageNumber,
      paragraphNumber: entry.paragraphNumber,
      title: entry.title,
      type: "toc"
    }));

    const bookmarkItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.bookmarks ?? []).map((bookmark: ReaderBookmark) => ({
      bookmarkId: bookmark.bookmarkId,
      isActive: bookmark.pageNumber === reviewPageNumber,
      key: `bookmark:${bookmark.bookmarkId}`,
      pageNumber: bookmark.pageNumber,
      paragraphNumber: bookmark.paragraphNumber,
      title: "Marcador guardado",
      type: "bookmark"
    }));

    const noteItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.notes ?? []).map((note: ReaderNote) => ({
      color: note.highlightColor,
      excerpt: notePreview(note),
      isActive: note.pageNumber === reviewPageNumber,
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      noteText: note.noteText,
      pageNumber: note.pageNumber,
      paragraphNumber: note.paragraphNumber ?? 1,
      type: "note"
    }));

    const sortWeight = { bookmark: 1, note: 2, toc: 0 } as const;

    return [...tocItems, ...bookmarkItems, ...noteItems].sort((left, right) => {
      if (left.pageNumber !== right.pageNumber) {
        return left.pageNumber - right.pageNumber;
      }

      if (left.paragraphNumber !== right.paragraphNumber) {
        return left.paragraphNumber - right.paragraphNumber;
      }

      return sortWeight[left.type] - sortWeight[right.type];
    });
  }, [activeTocEntryKey, reviewNavigationQuery.data?.bookmarks, reviewNavigationQuery.data?.notes, reviewNavigationQuery.data?.toc, reviewPageNumber]);

  return (
    <div className="page-stack">
      {!isReviewOnlyMode ? (
        <section className="panel wide-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">{isAppendOnlyMode ? "Añadir páginas" : "Constructor de libros"}</p>
              <h2>{isAppendOnlyMode ? (selectedAppendBook?.title ?? "Cargando libro...") : "OCR desde imágenes"}</h2>
            </div>
            {isAppendOnlyMode ? (
              <button
                aria-label="Volver al lector"
                className="secondary-button reader-header-icon-button"
                onClick={handleBackFromAppend}
                title="Volver al lector"
                type="button"
              >
                <BackIcon />
              </button>
            ) : (
              <Link className="secondary-button link-button" to="/">
                Volver
              </Link>
            )}
          </div>

          <div className={isAppendOnlyMode ? "builder-board builder-board-append" : "builder-board"}>
            {!isAppendOnlyMode ? (
              <article className="builder-form-card">
                <h3>Crear un libro nuevo</h3>
                <p className="subdued">Sube varias imágenes de páginas en orden. El backend ejecutará OCR, guardará las imágenes en Oracle y abrirá el lector listo para seguir leyendo.</p>

                <form className="stack-form" onSubmit={handleCreateFromImages}>
                  <label>
                    Título del libro
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))}
                      placeholder="Mi libro escaneado"
                      required
                      value={createForm.title}
                    />
                  </label>

                  <label>
                    Autor
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, authorName: event.target.value }))}
                      placeholder="Autor o autora"
                      value={createForm.authorName}
                    />
                  </label>

                  <label>
                    Sinopsis
                    <textarea
                      onChange={(event) => setCreateForm((current) => ({ ...current, synopsis: event.target.value }))}
                      placeholder="Descripción opcional"
                      rows={4}
                      value={createForm.synopsis}
                    />
                  </label>

                  <label>
                    Imágenes de páginas
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={(event) => setSelectedCreateFiles(toFileArray(event.target.files))}
                      type="file"
                    />
                  </label>

                  <p className="helper-text">Formatos soportados: PNG, JPG y WEBP.</p>

                  <label>
                    Modo OCR
                    <select onChange={(event) => setCreateOcrMode(event.target.value as ImageOcrMode)} value={createOcrMode}>
                      <option value="VISION">OCR preciso con IA</option>
                      <option value="LOCAL">OCR rápido</option>
                    </select>
                  </label>

                  <p className="helper-text">{describeOcrMode(createOcrMode)}</p>
                  <p className="helper-text">El sistema recorta automáticamente la parte superior e inferior de la página para evitar encabezados y números de página.</p>

                  {selectedCreateFiles.length > 0 ? (
                    <div className="file-pill-list">
                      {selectedCreateFiles.map((file) => (
                        <span className="file-pill" key={file.name}>{file.name}</span>
                      ))}
                    </div>
                  ) : null}

                  {createError ? <p className="error-text">{createError}</p> : null}

                  <button className="primary-button" disabled={isCreating} type="submit">
                    {isCreating ? "Procesando OCR..." : "Crear libro desde imágenes"}
                  </button>
                </form>
              </article>
            ) : null}

            <article className={isAppendOnlyMode ? "builder-form-card builder-form-card-append" : "builder-form-card"}>
              {!isAppendOnlyMode ? (
                <>
                  <h3>Añadir páginas a un libro existente</h3>
                  <p className="subdued">Úsalo para seguir ampliando un libro que ya empezaste a leer. Si vienes desde el lector, las páginas nuevas se insertarán justo después de la página en la que estabas.</p>
                </>
              ) : null}

              <form className="stack-form" id="append-pages" onSubmit={handleAppendImages}>
                {!isAppendOnlyMode ? (
                  <label>
                    Libro de imágenes
                    <select onChange={(event) => setSelectedBookId(event.target.value)} value={selectedBookId}>
                      <option value="">Selecciona un libro</option>
                      {imageBooks.map((book) => (
                        <option key={book.bookId} value={book.bookId}>{book.title}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {selectedAppendBook && appendReferencePageNumber !== undefined ? (
                  <div className="selected-book-banner">
                    <span>Las páginas añadidas se insertarán</span>
                    <div className="append-placement-picker" role="radiogroup" aria-label="Posición respecto a la página actual">
                      <button
                        aria-checked={appendInsertionSide === "before"}
                        className={appendInsertionSide === "before" ? "append-placement-option active" : "append-placement-option"}
                        onClick={() => setAppendInsertionSide("before")}
                        role="radio"
                        type="button"
                      >
                        Antes
                      </button>
                      <button
                        aria-checked={appendInsertionSide === "after"}
                        className={appendInsertionSide === "after" ? "append-placement-option active" : "append-placement-option"}
                        onClick={() => setAppendInsertionSide("after")}
                        role="radio"
                        type="button"
                      >
                        Después
                      </button>
                    </div>
                    <span>de la página</span>
                    <label className="append-reference-page-field" aria-label="Página de referencia">
                      <input
                        className="append-reference-page-input"
                        inputMode="numeric"
                        max={appendReferencePageMax}
                        min={1}
                        onChange={handleAppendReferencePageInputChange}
                        type="number"
                        value={appendReferencePageNumber}
                      />
                    </label>
                    <span>{`/ ${appendReferencePageMax}.`}</span>
                  </div>
                ) : null}

                <div className="capture-input-grid">
                  <label aria-label="Nuevas imágenes" className="capture-action-card capture-action-card-icon-only" title="Nuevas imágenes">
                    <span className="capture-action-icon" aria-hidden="true">
                      <FilesIcon />
                    </span>
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      className="capture-action-input"
                      disabled={isAppending}
                      multiple
                      onChange={handleAppendFileSelection}
                      type="file"
                    />
                  </label>

                  <button
                    aria-label="Añadir desde cámara"
                    className="capture-action-card capture-action-card-icon-only"
                    disabled={isAppending || isAppendCameraStarting}
                    onClick={handleOpenAppendCamera}
                    title="Añadir desde cámara"
                    type="button"
                  >
                    <span className="capture-action-icon" aria-hidden="true">
                      <CameraIcon />
                    </span>
                  </button>
                </div>

                <input
                  accept="image/*"
                  capture="environment"
                  className="capture-action-input-hidden"
                  onChange={handleAppendFileSelection}
                  ref={appendCameraInputRef}
                  type="file"
                />

                {selectedAppendFiles.length > 0 ? (
                  <div className="file-pill-list file-pill-list-append">
                    {selectedAppendFiles.map((file, index) => (
                      <span
                        className={[
                          "file-pill",
                          "file-pill-removable",
                          isAppending && (appendImportProgress?.completedFiles ?? 0) > index ? "file-pill-completed" : "",
                          isAppending && appendImportProgress?.stage === "ocr" && appendImportProgress.currentFileIndex === index ? "file-pill-processing" : "",
                          isAppending && (appendImportProgress?.completedFiles ?? 0) <= index && appendImportProgress?.currentFileIndex !== index ? "file-pill-pending" : ""
                        ].filter(Boolean).join(" ")}
                        key={`${file.name}-${index}`}
                      >
                        <span>{file.name}</span>
                        {isAppending && (appendImportProgress?.completedFiles ?? 0) > index ? (
                          <span className="file-pill-status file-pill-status-completed">Hecho</span>
                        ) : null}
                        {isAppending && appendImportProgress?.stage === "ocr" && appendImportProgress.currentFileIndex === index ? (
                          <span className="file-pill-status">OCR...</span>
                        ) : null}
                        <button
                          aria-label={`Eliminar ${file.name}`}
                          className="file-pill-remove"
                          disabled={isAppending}
                          onClick={() => removeAppendFile(index)}
                          type="button"
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}

                {isAppending && appendImportProgress?.stage === "saving" ? (
                  <p className="helper-text">OCR completado. Guardando páginas en el libro...</p>
                ) : null}

                <div className="selected-book-banner">
                  <span>Modo OCR</span>
                  <div className="append-placement-picker" role="radiogroup" aria-label="Modo OCR">
                    <button
                      aria-checked={appendOcrMode === "VISION"}
                      className={appendOcrMode === "VISION" ? "append-placement-option active" : "append-placement-option"}
                      onClick={() => setAppendOcrMode("VISION")}
                      role="radio"
                      type="button"
                    >
                      Preciso con IA
                    </button>
                    <button
                      aria-checked={appendOcrMode === "LOCAL"}
                      className={appendOcrMode === "LOCAL" ? "append-placement-option active" : "append-placement-option"}
                      onClick={() => setAppendOcrMode("LOCAL")}
                      role="radio"
                      type="button"
                    >
                      Rápido local
                    </button>
                  </div>
                </div>

                {appendError ? <p className="error-text">{appendError}</p> : null}

                <button className="secondary-button" disabled={isAppending} type="submit">
                  {isAppending ? "Procesando OCR..." : "Añadir páginas"}
                </button>
              </form>

              {!isAppendOnlyMode ? (
                <div className="book-option-list">
                  <h3>Tus libros de imágenes</h3>
                  {booksQuery.isLoading ? <p className="subdued">Cargando libros...</p> : null}
                  {!booksQuery.isLoading && imageBooks.length === 0 ? <p className="subdued">Todavía no tienes libros creados desde imágenes.</p> : null}
                  {imageBooks.map((book) => (
                    <Link className="book-option-card" key={book.bookId} to={`/books/${book.bookId}`}>
                      <strong>{book.title}</strong>
                      <span>{book.totalPages} páginas, {book.totalParagraphs} párrafos</span>
                    </Link>
                  ))}
                </div>
              ) : null}
            </article>
          </div>

          {isAppendCameraModalOpen ? (
            <div className="camera-capture-backdrop" role="presentation">
              <div aria-label="Captura desde camara" aria-modal="true" className="camera-capture-modal" role="dialog">
                <div className="camera-capture-header">
                  <div>
                    <p className="eyebrow">Camara</p>
                    <h3>Capturar pagina</h3>
                  </div>
                  <button
                    aria-label="Cerrar camara"
                    className="secondary-button reader-header-icon-button"
                    disabled={isAppendCameraCapturing}
                    onClick={closeAppendCameraModal}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="camera-capture-preview">
                  {appendCameraStream ? (
                    <>
                      <video muted playsInline ref={appendCameraVideoRef} />
                      <div className="camera-capture-overlay-actions">
                        <button
                          className="primary-button camera-capture-primary-button"
                          disabled={!appendCameraStream || isAppendCameraCapturing}
                          onClick={handleCaptureAppendCameraFrame}
                          type="button"
                        >
                          {isAppendCameraCapturing ? "Guardando..." : "Tomar foto"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="subdued">Abriendo camara...</p>
                  )}
                </div>

                <canvas className="camera-capture-canvas" ref={appendCameraCanvasRef} />

                <div className="camera-capture-actions">
                  <button className="secondary-button" disabled={isAppendCameraCapturing} onClick={closeAppendCameraModal} type="button">
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {isReviewOnlyMode ? (
      <>
      <section className="panel wide-panel review-ocr-panel" id="review-ocr">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Edición</p>
            <h2>{selectedReviewBook?.title ?? "Cargando libro..."}</h2>
          </div>
          <button
            aria-label="Volver al lector"
            className="secondary-button reader-header-icon-button"
            onClick={handleBackFromReview}
            title="Volver al lector"
            type="button"
          >
            <BackIcon />
          </button>
        </div>

        {imageBooks.length === 0 ? (
          <div className="empty-state">
            <p>Todavía no hay libros creados desde imágenes para revisar.</p>
          </div>
        ) : (
          <>
            {reviewPageQuery.isLoading ? <p className="subdued">Cargando página para revisión...</p> : null}
            {reviewPageQuery.isError ? <p className="error-text">No se pudo cargar la página seleccionada.</p> : null}

            <div className="builder-review-grid">
              <article className={isRerunningOcr ? "review-panel review-panel-processing" : "review-panel"}>
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">Imagen original</p>
                  </div>
                </div>

                {reviewImageUrl ? (
                  <div className={isRerunningOcr ? "review-image-frame is-processing" : "review-image-frame"}>
                    <img alt={`Página ${reviewPageNumber} para revisión OCR`} className="preview-image" src={reviewImageUrl} />
                    {isRerunningOcr ? (
                      <div aria-live="polite" className="review-image-processing-overlay">
                        <span className="review-processing-spinner" />
                        <strong>Reconociendo OCR...</strong>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="empty-state compact-state">
                    <p>No hay imagen asociada a esta página.</p>
                  </div>
                )}
              </article>

              <article className="review-panel">
                <form className="stack-form review-editor-form" id="ocr-review-form" onSubmit={handleSaveOcr}>
                  {reviewPreviewHtml ? (
                    <div>
                      <p className="page-label">Previsualización de la página guardada</p>
                      <article className="reader-prose reader-prose-rich review-preview-panel">
                        <div
                          className="reader-rich-content"
                          dangerouslySetInnerHTML={{ __html: reviewPreviewHtml }}
                        />
                      </article>
                    </div>
                  ) : null}

                  <label className="review-editor-label">
                    <span className="page-label">Edición de la página</span>
                    <textarea
                      className="ocr-editor"
                      onChange={(event) => {
                        setEditedText(event.target.value);
                        syncReviewSelectedAlignment(event.target.selectionStart, event.target.selectionEnd, event.target.value);
                      }}
                      onClick={(event) => syncReviewSelectedAlignment(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.currentTarget.value)}
                      onKeyUp={(event) => syncReviewSelectedAlignment(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.currentTarget.value)}
                      onSelect={(event) => syncReviewSelectedAlignment(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.currentTarget.value)}
                      ref={reviewEditorRef}
                      rows={18}
                      value={editedText}
                    />
                  </label>

                  <div aria-label="Barra de formato del editor OCR" className="review-format-toolbar" role="toolbar">
                    <button
                      className="review-format-button"
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => toggleReviewHeading(1)}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Título principal"
                      type="button"
                    >
                      <span>T1</span>
                    </button>
                    <button
                      className="review-format-button"
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => toggleReviewHeading(2)}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Subtítulo"
                      type="button"
                    >
                      <span>T2</span>
                    </button>
                    <button
                      className="review-format-button"
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => toggleReviewInlineFormat("**")}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Negrita"
                      type="button"
                    >
                      <strong>B</strong>
                    </button>
                    <button
                      className="review-format-button"
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => toggleReviewInlineFormat("*")}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Cursiva"
                      type="button"
                    >
                      <em>I</em>
                    </button>
                    <button
                      className={reviewSelectedAlignment === "left" ? "review-format-button active" : "review-format-button"}
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => applyReviewAlignment("left")}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Alinear a la izquierda"
                      type="button"
                    >
                      <span>L</span>
                    </button>
                    <button
                      className={reviewSelectedAlignment === "center" ? "review-format-button active" : "review-format-button"}
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => applyReviewAlignment("center")}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Centrar bloque"
                      type="button"
                    >
                      <span>C</span>
                    </button>
                    <button
                      className={reviewSelectedAlignment === "right" ? "review-format-button active" : "review-format-button"}
                      disabled={isSavingReview || !reviewBookId}
                      onClick={() => applyReviewAlignment("right")}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Alinear a la derecha"
                      type="button"
                    >
                      <span>R</span>
                    </button>
                    <button
                      className="review-format-button review-format-button-wide"
                      disabled={isSavingReview || !reviewBookId}
                      onClick={insertReviewImageTemplate}
                      onMouseDown={(event) => event.preventDefault()}
                      title="Insertar imagen"
                      type="button"
                    >
                      <span>IMG</span>
                    </button>
                  </div>

                  <p className="helper-text">Separa párrafos dejando una línea en blanco entre ellos. También puedes usar # y ## para títulos, **texto** para negrita, *texto* para cursiva, ::left::, ::center:: o ::right:: para alinear un bloque y ![alt](url) para incrustar una imagen.</p>

                  {reviewError ? <p className="error-text">{reviewError}</p> : null}
                  {reviewMessage ? <p className="success-text">{reviewMessage}</p> : null}
                </form>
              </article>
            </div>
          </>
        )}
      </section>
      {imageBooks.length > 0 ? (
        <>
          {isReviewIndexVisible ? (
            <aside aria-label="Índice de páginas para OCR" className="reader-navigation-panel" ref={reviewIndexPanelRef} role="dialog">
              <div className="reader-navigation-header">
                <div>
                  <p className="eyebrow">Navegación</p>
                  <h3>Índice y notas</h3>
                </div>
                <button
                  aria-label="Cerrar índice"
                  className="reader-icon-ghost"
                  onClick={() => setIsReviewIndexVisible(false)}
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
                            onClick={() => jumpToReviewPage(item.pageNumber)}
                            style={{ "--toc-level": String(Math.max(0, item.level - 1)) } as React.CSSProperties}
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
                              onClick={() => jumpToReviewPage(item.pageNumber)}
                              type="button"
                            >
                              <div className="reader-navigation-item-topline">
                                <span className="reader-navigation-chip reader-navigation-chip-bookmark">■</span>
                                <strong>{item.title}</strong>
                                <span className="reader-navigation-inline-meta">{formatPageAnchor(item.pageNumber)}</span>
                              </div>
                            </button>
                          </article>
                        );
                      }

                      return (
                        <article className={item.isActive ? "reader-note-card reader-navigation-item-note active" : "reader-note-card reader-navigation-item-note"} key={item.key}>
                          <button
                            className="reader-note-jump"
                            onClick={() => jumpToReviewPage(item.pageNumber)}
                            type="button"
                          >
                            <div className="reader-navigation-item-topline">
                              <span className={item.color ? `reader-navigation-chip reader-navigation-chip-note ${highlightClassName(item.color)}` : "reader-navigation-chip reader-navigation-chip-note"} />
                              <strong>{item.excerpt}</strong>
                              <span className="reader-navigation-inline-meta">{formatRelativeAnchor(item.pageNumber, item.paragraphNumber)}</span>
                            </div>
                          </button>
                          <p>{item.noteText}</p>
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
                  <span>{reviewNavigationQuery.data?.notes.length ?? 0}</span>
                </div>
                <p className="reader-navigation-empty">Las notas y marcadores aparecen integrados dentro del índice según su posición en el libro.</p>
              </section>
            </aside>
          ) : null}

          <div aria-label="Controles de edición OCR" className="review-floating-controls" role="toolbar">
            <div aria-live="polite" className="reader-floating-status review-floating-status">
              <form className="reader-page-jump-form" onSubmit={(event) => handleReviewPageJumpSubmit(event)}>
                <label className="reader-page-jump-label">
                  <input
                    aria-label="Página actual"
                    className="reader-page-jump-input"
                    inputMode="numeric"
                    max={selectedReviewBook?.totalPages || undefined}
                    min={1}
                    onBlur={() => {
                      handleReviewPageJumpSubmit();
                    }}
                    onChange={(event) => setReviewPageJumpValue(event.target.value.replace(/[^\d]/gu, ""))}
                    onFocus={() => setIsReviewPageJumpActive(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelReviewPageJump();
                      }
                    }}
                    onPointerDown={() => setIsReviewPageJumpActive(true)}
                    ref={reviewPageJumpInputRef}
                    size={Math.max(String(selectedReviewBook?.totalPages || reviewPageNumber).length, 2)}
                    type="text"
                    value={isReviewPageJumpActive ? reviewPageJumpValue : String(reviewPageNumber)}
                  />
                  <strong>/ {selectedReviewBook?.totalPages ?? 0}</strong>
                </label>
              </form>
            </div>

            <button
              aria-expanded={isReviewIndexVisible}
              aria-label="Abrir índice de páginas"
              className={isReviewIndexVisible ? "reader-float-button active" : "reader-float-button"}
              onClick={() => setIsReviewIndexVisible((current) => !current)}
              ref={reviewIndexToggleRef}
              title="Índice de páginas"
              type="button"
            >
              <NavigationIcon />
            </button>

            <button
              aria-label="Página anterior"
              className="reader-float-button"
              disabled={reviewPageNumber <= 1}
              onClick={() => changeReviewPage(-1)}
              title="Página anterior"
              type="button"
            >
              <PagePreviousIcon />
            </button>

            <button
              aria-label="Página siguiente"
              className="reader-float-button"
              disabled={reviewPageNumber >= (selectedReviewBook?.totalPages ?? 0)}
              onClick={() => changeReviewPage(1)}
              title="Página siguiente"
              type="button"
            >
              <PageNextIcon />
            </button>

            <div className="review-floating-ocr-menu">
              {isReviewOcrMenuVisible ? (
                <div aria-label="Opciones de OCR" className="review-floating-ocr-panel" role="dialog">
                  <p className="review-floating-ocr-title">Volver a reconocer con</p>
                  <button
                    className={reviewOcrMode === "VISION" ? "review-ocr-option active" : "review-ocr-option"}
                    disabled={isSavingReview || !reviewBookId}
                    onClick={() => void handleRerunOcr("VISION")}
                    type="button"
                  >
                    <strong>Preciso con IA</strong>
                    <span>Mayor precisión para páginas difíciles.</span>
                  </button>
                  <button
                    className={reviewOcrMode === "LOCAL" ? "review-ocr-option active" : "review-ocr-option"}
                    disabled={isSavingReview || !reviewBookId}
                    onClick={() => void handleRerunOcr("LOCAL")}
                    type="button"
                  >
                    <strong>Rápido local</strong>
                    <span>Más veloz para páginas limpias.</span>
                  </button>
                </div>
              ) : null}

              <button
                aria-expanded={isReviewOcrMenuVisible}
                aria-label={isRerunningOcr ? "Reconociendo OCR" : "Opciones de OCR"}
                className={isRerunningOcr
                  ? "reader-float-button review-ocr-text-button review-ocr-text-button-loading"
                  : (isReviewOcrMenuVisible ? "reader-float-button review-ocr-text-button active" : "reader-float-button review-ocr-text-button")}
                disabled={isSavingReview || !reviewBookId}
                onClick={() => setIsReviewOcrMenuVisible((current) => !current)}
                title={isRerunningOcr ? "Reconociendo OCR..." : "Opciones de OCR"}
                type="button"
              >
                <span>OCR</span>
              </button>
            </div>

            <button
              aria-label={isSavingReview ? "Guardando correcciones" : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar correcciones")}
              className="reader-float-button primary"
              disabled={isSavingReview || !reviewBookId || !isReviewDirty}
              form="ocr-review-form"
              title={isSavingReview ? "Guardando correcciones..." : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar correcciones")}
              type="submit"
            >
              <SaveOcrIcon />
            </button>
          </div>
        </>
      ) : null}
      </>
      ) : null}
    </div>
  );
}