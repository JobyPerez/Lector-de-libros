import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  appendImagesToBook,
  createImageBook,
  deleteBookPage,
  fetchAppendImagesImportProgress,
  fetchBookPage,
  fetchBookPageImage,
  fetchBooks,
  fetchPageAnnotations,
  fetchReaderNavigation,
  isRetryableRateLimitError,
  rerunOcrPage,
  uploadBookPageImage,
  updateOcrPage,
  type AppendImagesImportProgress,
  type ImageRotation,
  type ImageOcrMode,
  type ReaderBookmark,
  type ReaderNote,
  type ReaderTocEntry,
  type HighlightColor
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { getOutlineSourceMeta } from "../../app/outline-source";
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

function RotateLeftIcon() {
  return (
    <ToolbarIcon>
      <path d="M6.5 8.75H3.75V6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M3.75 8.75C4.8 6.15 7.34 4.5 10.2 4.5C14.23 4.5 17.5 7.77 17.5 11.8C17.5 15.83 14.23 19.1 10.2 19.1C7.95 19.1 5.93 18.08 4.59 16.48" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10.2 8.25V11.95L12.85 13.65" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

function RotateRightIcon() {
  return (
    <ToolbarIcon>
      <path d="M17.5 8.75H20.25V6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M20.25 8.75C19.2 6.15 16.66 4.5 13.8 4.5C9.77 4.5 6.5 7.77 6.5 11.8C6.5 15.83 9.77 19.1 13.8 19.1C16.05 19.1 18.07 18.08 19.41 16.48" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.8 8.25V11.95L11.15 13.65" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </ToolbarIcon>
  );
}

function CropIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 4.75V15.5C7 16.7426 8.00736 17.75 9.25 17.75H20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M17 19.25V8.5C17 7.25736 15.9926 6.25 14.75 6.25H4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

function DeletePageIcon() {
  return (
    <ToolbarIcon>
      <path d="M8 7.25H16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M9 7.25V5.75C9 5.34 9.34 5 9.75 5H14.25C14.66 5 15 5.34 15 5.75V7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M7.25 7.25L8 18.25C8.03 18.67 8.38 19 8.8 19H15.2C15.62 19 15.97 18.67 16 18.25L16.75 7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M10.25 10.25V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.75 10.25V16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

function PromptIcon() {
  return (
    <ToolbarIcon>
      <path d="M8 16.5L5.5 18.5L6.4 15.3L14.65 7.05C15.3963 6.30368 16.6068 6.30368 17.3531 7.05C18.0994 7.79632 18.0994 9.00684 17.3531 9.75316L9.1 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M13.5 8.2L16.2 10.9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

const defaultVisionOcrEditablePrompt = "Omite cabeceras repetidas, pies y números de página.";

function resolveVisionPromptOverride(prompt: string): string | undefined {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || normalizedPrompt === defaultVisionOcrEditablePrompt) {
    return undefined;
  }

  return normalizedPrompt;
}

type OcrPromptEditorProps = {
  disabled?: boolean;
  helperText: string;
  onChange: (value: string) => void;
  onReset: () => void;
  value: string;
};

function OcrPromptEditor({
  disabled = false,
  helperText,
  onChange,
  onReset,
  value
}: OcrPromptEditorProps) {
  const hasCustomPrompt = value.trim() !== defaultVisionOcrEditablePrompt;

  return (
    <div className="ocr-prompt-editor-panel">
      <div className="ocr-prompt-editor-header">
        <p className="ocr-prompt-editor-title">Mensaje user del OCR con IA</p>
        <button
          className="secondary-button ocr-prompt-editor-reset"
          disabled={disabled || !hasCustomPrompt}
          onClick={onReset}
          type="button"
        >
          Restablecer
        </button>
      </div>
      <label className="ocr-prompt-editor-field">
        <span>Contenido del mensaje user</span>
        <textarea
          disabled={disabled}
          maxLength={4000}
          onChange={(event) => onChange(event.target.value)}
          rows={7}
          value={value}
        />
      </label>
      <p className="helper-text">{helperText}</p>
    </div>
  );
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
type ReviewImageCropEdge = "bottom" | "left" | "right" | "top";
type ReviewImageCrop = Record<ReviewImageCropEdge, number>;
type ReviewCropHandle = "move" | "nw" | "ne" | "se" | "sw";
type ReviewCropRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};
type ReviewCropPointerSession = {
  boundsHeight: number;
  boundsWidth: number;
  handle: ReviewCropHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRect: ReviewCropRect;
};

const reviewAlignmentMarkerPattern = /^::(left|center|right)::\s*/u;
const reviewHeadingMarkerPattern = /^(#{1,6})\s+/u;
const reviewImageRotationSteps: readonly ImageRotation[] = [0, 90, 180, 270];
const defaultReviewImageCrop: ReviewImageCrop = { bottom: 0, left: 0, right: 0, top: 0 };
const maximumReviewImageCropPercent = 40;
const minimumReviewImageRemainingPercent = 15;

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
  const separatorPattern = /\n+/gu;
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
  const match = value.slice(cursor).match(/\n+/u);
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
    .split(/\n+/u)
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

function rotateReviewImageValue(currentRotation: ImageRotation, direction: -1 | 1): ImageRotation {
  const currentIndex = reviewImageRotationSteps.indexOf(currentRotation);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + reviewImageRotationSteps.length) % reviewImageRotationSteps.length;
  return reviewImageRotationSteps[nextIndex] ?? 0;
}

function formatReviewImageRotation(rotation: ImageRotation) {
  return `${rotation}°`;
}

function formatReviewImageCrop(value: number) {
  return `${value}%`;
}

function equalReviewImageCrop(left: ReviewImageCrop, right: ReviewImageCrop) {
  return left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom
    && left.left === right.left;
}

function reviewCropToRect(crop: ReviewImageCrop): ReviewCropRect {
  return {
    height: Math.max(minimumReviewImageRemainingPercent, 100 - crop.top - crop.bottom),
    width: Math.max(minimumReviewImageRemainingPercent, 100 - crop.left - crop.right),
    x: crop.left,
    y: crop.top
  };
}

function reviewRectToCrop(rect: ReviewCropRect): ReviewImageCrop {
  return {
    bottom: Math.max(0, Math.round(100 - rect.y - rect.height)),
    left: Math.max(0, Math.round(rect.x)),
    right: Math.max(0, Math.round(100 - rect.x - rect.width)),
    top: Math.max(0, Math.round(rect.y))
  };
}

function clampReviewCropRect(rect: ReviewCropRect): ReviewCropRect {
  const width = Math.max(minimumReviewImageRemainingPercent, Math.min(rect.width, 100));
  const height = Math.max(minimumReviewImageRemainingPercent, Math.min(rect.height, 100));
  const x = Math.max(0, Math.min(rect.x, 100 - width));
  const y = Math.max(0, Math.min(rect.y, 100 - height));

  return {
    height,
    width,
    x,
    y
  };
}

function resizeReviewCropRect(
  startRect: ReviewCropRect,
  handle: ReviewCropHandle,
  deltaXPercent: number,
  deltaYPercent: number
): ReviewCropRect {
  const minimumSize = minimumReviewImageRemainingPercent;
  const startRight = startRect.x + startRect.width;
  const startBottom = startRect.y + startRect.height;

  if (handle === "move") {
    return clampReviewCropRect({
      ...startRect,
      x: startRect.x + deltaXPercent,
      y: startRect.y + deltaYPercent
    });
  }

  let nextLeft = startRect.x;
  let nextTop = startRect.y;
  let nextRight = startRight;
  let nextBottom = startBottom;

  if (handle === "nw" || handle === "sw") {
    nextLeft = Math.min(Math.max(startRect.x + deltaXPercent, 0), startRight - minimumSize);
  }

  if (handle === "ne" || handle === "se") {
    nextRight = Math.max(Math.min(startRight + deltaXPercent, 100), startRect.x + minimumSize);
  }

  if (handle === "nw" || handle === "ne") {
    nextTop = Math.min(Math.max(startRect.y + deltaYPercent, 0), startBottom - minimumSize);
  }

  if (handle === "sw" || handle === "se") {
    nextBottom = Math.max(Math.min(startBottom + deltaYPercent, 100), startRect.y + minimumSize);
  }

  return clampReviewCropRect({
    height: nextBottom - nextTop,
    width: nextRight - nextLeft,
    x: nextLeft,
    y: nextTop
  });
}

function updateReviewImageCropValue(currentCrop: ReviewImageCrop, edge: ReviewImageCropEdge, nextValue: number): ReviewImageCrop {
  const normalizedValue = Math.max(0, Math.min(Math.round(nextValue), maximumReviewImageCropPercent));
  const nextCrop = { ...currentCrop, [edge]: normalizedValue };

  if (edge === "top" || edge === "bottom") {
    const oppositeEdge = edge === "top" ? "bottom" : "top";
    const maximumEdgeValue = Math.max(0, 100 - minimumReviewImageRemainingPercent - currentCrop[oppositeEdge]);
    nextCrop[edge] = Math.min(normalizedValue, maximumEdgeValue);
    return nextCrop;
  }

  const oppositeEdge = edge === "left" ? "right" : "left";
  const maximumEdgeValue = Math.max(0, 100 - minimumReviewImageRemainingPercent - currentCrop[oppositeEdge]);
  nextCrop[edge] = Math.min(normalizedValue, maximumEdgeValue);
  return nextCrop;
}

function buildReviewImageFileName(pageNumber: number, mimeType: string) {
  const extension = mimeType === "image/png"
    ? "png"
    : mimeType === "image/webp"
      ? "webp"
      : "jpg";

  return `page-${pageNumber}-edited.${extension}`;
}

function resolveReviewImageOutputMimeType(inputMimeType: string) {
  if (inputMimeType === "image/png" || inputMimeType === "image/webp" || inputMimeType === "image/jpeg") {
    return inputMimeType;
  }

  return "image/png";
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("No se pudo cargar la imagen para editarla."));
    };

    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("No se pudo generar la imagen editada."));
        return;
      }

      resolve(blob);
    }, mimeType, quality);
  });
}

async function renderReviewImageBlob(
  sourceBlob: Blob,
  options: {
    crop: ReviewImageCrop;
    maxDimension?: number;
    mimeType: string;
    quality?: number;
    rotation: ImageRotation;
  }
): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("La edición de imágenes requiere un entorno de navegador.");
  }

  const image = await loadImageFromBlob(sourceBlob);
  const quarterTurn = options.rotation === 90 || options.rotation === 270;
  const orientedWidth = quarterTurn ? image.naturalHeight : image.naturalWidth;
  const orientedHeight = quarterTurn ? image.naturalWidth : image.naturalHeight;
  const rotatedCanvas = document.createElement("canvas");
  rotatedCanvas.width = Math.max(1, orientedWidth);
  rotatedCanvas.height = Math.max(1, orientedHeight);
  const rotatedContext = rotatedCanvas.getContext("2d");

  if (!rotatedContext) {
    throw new Error("No se pudo preparar la vista previa de la imagen.");
  }

  switch (options.rotation) {
    case 90:
      rotatedContext.translate(rotatedCanvas.width, 0);
      rotatedContext.rotate(Math.PI / 2);
      break;
    case 180:
      rotatedContext.translate(rotatedCanvas.width, rotatedCanvas.height);
      rotatedContext.rotate(Math.PI);
      break;
    case 270:
      rotatedContext.translate(0, rotatedCanvas.height);
      rotatedContext.rotate(-Math.PI / 2);
      break;
    default:
      break;
  }

  rotatedContext.drawImage(image, 0, 0);

  const cropLeft = Math.round((rotatedCanvas.width * options.crop.left) / 100);
  const cropRight = Math.round((rotatedCanvas.width * options.crop.right) / 100);
  const cropTop = Math.round((rotatedCanvas.height * options.crop.top) / 100);
  const cropBottom = Math.round((rotatedCanvas.height * options.crop.bottom) / 100);
  const croppedWidth = Math.max(1, rotatedCanvas.width - cropLeft - cropRight);
  const croppedHeight = Math.max(1, rotatedCanvas.height - cropTop - cropBottom);
  const scale = options.maxDimension && Math.max(croppedWidth, croppedHeight) > options.maxDimension
    ? options.maxDimension / Math.max(croppedWidth, croppedHeight)
    : 1;
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = Math.max(1, Math.round(croppedWidth * scale));
  outputCanvas.height = Math.max(1, Math.round(croppedHeight * scale));
  const outputContext = outputCanvas.getContext("2d");

  if (!outputContext) {
    throw new Error("No se pudo renderizar la imagen editada.");
  }

  outputContext.drawImage(
    rotatedCanvas,
    cropLeft,
    cropTop,
    croppedWidth,
    croppedHeight,
    0,
    0,
    outputCanvas.width,
    outputCanvas.height
  );

  return canvasToBlob(outputCanvas, options.mimeType, options.quality);
}

type OcrRetryContext = "create" | "review";

type OcrRetryState = {
  context: OcrRetryContext;
  secondsRemaining: number;
};

const maximumClientOcrRateLimitRetries = 3;

function buildOcrRetryCountdownLabel(secondsRemaining: number) {
  const normalizedSeconds = Math.max(Math.ceil(secondsRemaining), 1);
  return `GitHub Models limitó temporalmente el OCR. Reintentando automáticamente en ${normalizedSeconds} s.`;
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
  const [isReviewCropMode, setIsReviewCropMode] = useState(false);
  const [reviewImageCrop, setReviewImageCrop] = useState<ReviewImageCrop>(defaultReviewImageCrop);
  const [reviewCropDraft, setReviewCropDraft] = useState<ReviewCropRect>(() => reviewCropToRect(defaultReviewImageCrop));
  const [originalReviewImageCrop, setOriginalReviewImageCrop] = useState<ReviewImageCrop>(defaultReviewImageCrop);
  const [reviewImageRotation, setReviewImageRotation] = useState<ImageRotation>(0);
  const [originalReviewImageRotation, setOriginalReviewImageRotation] = useState<ImageRotation>(0);
  const [createOcrMode, setCreateOcrMode] = useState<ImageOcrMode>("VISION");
  const [appendOcrMode, setAppendOcrMode] = useState<ImageOcrMode>("VISION");
  const [appendInsertionSide, setAppendInsertionSide] = useState<AppendInsertionSide>("after");
  const [appendReferencePageInput, setAppendReferencePageInput] = useState("1");
  const [appendProgressId, setAppendProgressId] = useState<string | null>(null);
  const [appendImportProgress, setAppendImportProgress] = useState<AppendImagesImportProgress | null>(null);
  const [isCreateCameraModalOpen, setIsCreateCameraModalOpen] = useState(false);
  const [createCameraStream, setCreateCameraStream] = useState<MediaStream | null>(null);
  const [isCreateCameraStarting, setIsCreateCameraStarting] = useState(false);
  const [isCreateCameraCapturing, setIsCreateCameraCapturing] = useState(false);
  const [isAppendCameraModalOpen, setIsAppendCameraModalOpen] = useState(false);
  const [appendCameraStream, setAppendCameraStream] = useState<MediaStream | null>(null);
  const [isAppendCameraStarting, setIsAppendCameraStarting] = useState(false);
  const [isAppendCameraCapturing, setIsAppendCameraCapturing] = useState(false);
  const [reviewOcrMode, setReviewOcrMode] = useState<ImageOcrMode>("VISION");
  const [createPromptOverride, setCreatePromptOverride] = useState(defaultVisionOcrEditablePrompt);
  const [appendPromptOverride, setAppendPromptOverride] = useState(defaultVisionOcrEditablePrompt);
  const [reviewPromptOverride, setReviewPromptOverride] = useState(defaultVisionOcrEditablePrompt);
  const [isCreatePromptEditorOpen, setIsCreatePromptEditorOpen] = useState(false);
  const [isAppendPromptEditorOpen, setIsAppendPromptEditorOpen] = useState(false);
  const [isReviewPromptEditorOpen, setIsReviewPromptEditorOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isDeletingReviewPage, setIsDeletingReviewPage] = useState(false);
  const [isRerunningOcr, setIsRerunningOcr] = useState(false);
  const [ocrRetryState, setOcrRetryState] = useState<OcrRetryState | null>(null);
  const [isReviewIndexVisible, setIsReviewIndexVisible] = useState(false);
  const [isReviewOcrMenuVisible, setIsReviewOcrMenuVisible] = useState(false);
  const [isReviewPageJumpActive, setIsReviewPageJumpActive] = useState(false);
  const [reviewSelectedAlignment, setReviewSelectedAlignment] = useState<ReviewTextAlignment | null>(null);
  const [reviewPageJumpValue, setReviewPageJumpValue] = useState("1");
  const [reviewImageSourceBlob, setReviewImageSourceBlob] = useState<Blob | null>(null);
  const [reviewImageStageUrl, setReviewImageStageUrl] = useState<string | null>(null);
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);
  const reviewEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const reviewCropPointerSessionRef = useRef<ReviewCropPointerSession | null>(null);
  const reviewCropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const reviewPageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const reviewIndexPanelRef = useRef<HTMLElement | null>(null);
  const reviewIndexToggleRef = useRef<HTMLButtonElement | null>(null);
  const createCameraInputRef = useRef<HTMLInputElement | null>(null);
  const createCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const createCameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const appendCameraInputRef = useRef<HTMLInputElement | null>(null);
  const appendCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const appendCameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isMountedRef = useRef(true);
  const ocrRetryIntervalRef = useRef<number | null>(null);
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
  const reviewableBooks = (booksQuery.data ?? []).filter((book) => book.sourceType === "IMAGES" || book.sourceType === "PDF");
  const selectedReviewBook = reviewableBooks.find((book) => book.bookId === reviewBookId) ?? null;
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
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (ocrRetryIntervalRef.current !== null) {
        window.clearInterval(ocrRetryIntervalRef.current);
        ocrRetryIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setAppendInsertionSide("after");
  }, [requestedAppendBookId, requestedInsertAfterPageParam]);

  useEffect(() => {
    if (initialAppendReferencePage !== undefined) {
      setAppendReferencePageInput(String(initialAppendReferencePage));
    }
  }, [initialAppendReferencePage]);

  useEffect(() => {
    if (createOcrMode !== "VISION") {
      setIsCreatePromptEditorOpen(false);
    }
  }, [createOcrMode]);

  useEffect(() => {
    if (appendOcrMode !== "VISION") {
      setIsAppendPromptEditorOpen(false);
    }
  }, [appendOcrMode]);

  useEffect(() => {
    if (reviewOcrMode !== "VISION") {
      setIsReviewPromptEditorOpen(false);
    }
  }, [reviewOcrMode]);

  useEffect(() => {
    setReviewPromptOverride(defaultVisionOcrEditablePrompt);
    setIsReviewPromptEditorOpen(false);
  }, [reviewBookId, reviewPageNumber]);

  useEffect(() => {
    if (!isCreateCameraModalOpen || !createCameraStream || !createCameraVideoRef.current) {
      return;
    }

    const videoElement = createCameraVideoRef.current;
    videoElement.srcObject = createCameraStream;
    void videoElement.play().catch(() => undefined);

    return () => {
      videoElement.pause();
      videoElement.srcObject = null;
    };
  }, [createCameraStream, isCreateCameraModalOpen]);

  useEffect(() => {
    if (!isCreateCameraModalOpen || typeof document === "undefined") {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isCreateCameraCapturing) {
        closeCreateCameraModal();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCreateCameraCapturing, isCreateCameraModalOpen]);

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

  const reviewAnnotationsQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-page-annotations", reviewBookId, reviewPageNumber],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchPageAnnotations(accessToken, reviewBookId, reviewPageNumber);
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
    const firstReviewableBook = reviewableBooks[0];
    const hasRequestedAppendBook = requestedAppendBookId
      ? imageBooks.some((book) => book.bookId === requestedAppendBookId)
      : false;
    const requestedReviewBook = requestedReviewBookId
      ? reviewableBooks.find((book) => book.bookId === requestedReviewBookId) ?? null
      : null;

    if (!firstImageBook) {
      setSelectedBookId("");
    } else if (!selectedBookId) {
      if (hasRequestedAppendBook) {
        setSelectedBookId(requestedAppendBookId);
      } else {
        setSelectedBookId(firstImageBook.bookId);
      }
    } else if (!imageBooks.some((book) => book.bookId === selectedBookId)) {
      setSelectedBookId(firstImageBook.bookId);
    }

    if (!firstReviewableBook) {
      setReviewBookId("");
      if (isReviewOnlyMode) {
        return;
      }
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
        setReviewBookId(firstReviewableBook?.bookId ?? "");
        setReviewPageNumber(1);
      }
    } else if (!reviewableBooks.some((book) => book.bookId === reviewBookId)) {
      setReviewBookId(firstReviewableBook?.bookId ?? "");
      setReviewPageNumber(1);
    }
  }, [imageBooks, isReviewOnlyMode, requestedAppendBookId, requestedReviewBookId, requestedReviewPage, reviewBookId, reviewableBooks, selectedBookId]);

  useEffect(() => {
    const page = reviewPageQuery.data?.page;

    if (!page) {
      return;
    }

    const nextEditedText = page.editedText ?? page.rawText ?? page.paragraphs.map((paragraph) => paragraph.paragraphText).join("\n");
    setEditedText(nextEditedText);
    setOriginalEditedText(nextEditedText);
    setIsReviewCropMode(false);
    setReviewImageCrop(defaultReviewImageCrop);
    setReviewCropDraft(reviewCropToRect(defaultReviewImageCrop));
    setOriginalReviewImageCrop(defaultReviewImageCrop);
    setReviewImageRotation(page.sourceImageRotation);
    setOriginalReviewImageRotation(page.sourceImageRotation);
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

    if (!isReviewOnlyMode || !accessToken || !reviewBookId || !reviewPageQuery.data?.page.hasSourceImage) {
      setReviewImageSourceBlob(null);
      setReviewImageStageUrl(null);
      setReviewImageUrl(null);
      return () => {
        active = false;
      };
    }

    void fetchBookPageImage(
      accessToken,
      reviewBookId,
      reviewPageNumber,
      `${reviewPageQuery.data?.page.sourceFileId ?? ""}:${reviewPageQuery.data?.page.updatedAt ?? ""}`
    )
      .then((imageBlob) => {
        if (!active) {
          return;
        }

        setReviewImageSourceBlob(imageBlob);
      })
      .catch(() => {
        if (active) {
          setReviewImageSourceBlob(null);
          setReviewImageUrl(null);
        }
      });

    return () => {
      active = false;
    };
  }, [accessToken, isReviewOnlyMode, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.hasSourceImage, reviewPageQuery.data?.page.sourceFileId, reviewPageQuery.data?.page.updatedAt]);

  useEffect(() => {
    let active = true;
    let stageObjectUrl: string | null = null;

    if (!reviewImageSourceBlob) {
      setReviewImageStageUrl(null);
      return () => {
        active = false;
      };
    }

    void renderReviewImageBlob(reviewImageSourceBlob, {
      crop: defaultReviewImageCrop,
      maxDimension: 1600,
      mimeType: "image/png",
      rotation: reviewImageRotation
    })
      .then((stageBlob) => {
        if (!active) {
          return;
        }

        stageObjectUrl = URL.createObjectURL(stageBlob);
        setReviewImageStageUrl(stageObjectUrl);
      })
      .catch(() => {
        if (active) {
          setReviewImageStageUrl(null);
        }
      });

    return () => {
      active = false;
      if (stageObjectUrl) {
        URL.revokeObjectURL(stageObjectUrl);
      }
    };
  }, [reviewImageRotation, reviewImageSourceBlob]);

  useEffect(() => {
    let active = true;
    let previewObjectUrl: string | null = null;

    if (!reviewImageSourceBlob) {
      setReviewImageUrl(null);
      return () => {
        active = false;
      };
    }

    void renderReviewImageBlob(reviewImageSourceBlob, {
      crop: reviewImageCrop,
      maxDimension: 1600,
      mimeType: "image/png",
      rotation: reviewImageRotation
    })
      .then((previewBlob) => {
        if (!active) {
          return;
        }

        previewObjectUrl = URL.createObjectURL(previewBlob);
        setReviewImageUrl(previewObjectUrl);
      })
      .catch(() => {
        if (active) {
          setReviewImageUrl(null);
        }
      });

    return () => {
      active = false;
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
      }
    };
  }, [reviewImageCrop, reviewImageRotation, reviewImageSourceBlob]);

  useEffect(() => {
    if (!isReviewCropMode) {
      reviewCropPointerSessionRef.current = null;
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const session = reviewCropPointerSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      event.preventDefault();

      const deltaXPercent = session.boundsWidth > 0
        ? ((event.clientX - session.startClientX) / session.boundsWidth) * 100
        : 0;
      const deltaYPercent = session.boundsHeight > 0
        ? ((event.clientY - session.startClientY) / session.boundsHeight) * 100
        : 0;

      setReviewCropDraft(resizeReviewCropRect(session.startRect, session.handle, deltaXPercent, deltaYPercent));
    }

    function handlePointerEnd(event: PointerEvent) {
      const session = reviewCropPointerSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      reviewCropPointerSessionRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [isReviewCropMode]);

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

  function createFiles(files: File[]) {
    const validFiles = files.filter(isSupportedImageFile);
    const invalidFiles = files.filter((file) => !isSupportedImageFile(file));

    setSelectedCreateFiles((currentFiles) => [...currentFiles, ...validFiles]);

    if (invalidFiles.length > 0) {
      const invalidNames = invalidFiles.map((file) => file.name).join(", ");
      setCreateError(`Algunas imágenes no se pueden usar todavía (${invalidNames}). Usa PNG, JPG o WEBP.`);
      return;
    }

    setCreateError(null);
  }

  function handleCreateFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    createFiles(toFileArray(event.target.files));
    event.target.value = "";
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

  function stopCreateCameraStream() {
    setCreateCameraStream((currentStream) => {
      currentStream?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }

  function closeCreateCameraModal() {
    setIsCreateCameraCapturing(false);
    setIsCreateCameraStarting(false);
    setIsCreateCameraModalOpen(false);
    stopCreateCameraStream();
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

  async function handleOpenCreateCamera() {
    if (isCreating || isCreateCameraStarting) {
      return;
    }

    if (shouldPreferNativeCameraCapture()) {
      createCameraInputRef.current?.click();
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCreateError("Este navegador no puede abrir la camara en escritorio. Usa la subida de archivos o prueba otro navegador.");
      return;
    }

    setCreateError(null);
    setIsCreateCameraStarting(true);

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

      setCreateCameraStream(stream);
      setIsCreateCameraModalOpen(true);
    } catch {
      setCreateError("No se pudo abrir la camara. Revisa el permiso del navegador y que haya una webcam disponible.");
    } finally {
      setIsCreateCameraStarting(false);
    }
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

  function handleCaptureCreateCameraFrame() {
    const videoElement = createCameraVideoRef.current;
    const canvasElement = createCameraCanvasRef.current;

    if (!videoElement || !canvasElement || videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
      setCreateError("La camara todavia no esta lista para capturar una imagen.");
      return;
    }

    const renderingContext = canvasElement.getContext("2d");
    if (!renderingContext) {
      setCreateError("No se pudo capturar la imagen de la camara.");
      return;
    }

    setIsCreateCameraCapturing(true);
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    renderingContext.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);

    canvasElement.toBlob((blob) => {
      if (!blob) {
        setCreateError("No se pudo capturar la imagen de la camara.");
        setIsCreateCameraCapturing(false);
        return;
      }

      const fileName = `camara-${new Date().toISOString().replace(/[:.]/gu, "-")}.jpg`;
      createFiles([new File([blob], fileName, { type: "image/jpeg" })]);
      closeCreateCameraModal();
    }, "image/jpeg", 0.92);
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
    setAppendPromptOverride(defaultVisionOcrEditablePrompt);
    setIsAppendPromptEditorOpen(false);
  }

  function clearCreateSelection() {
    setSelectedCreateFiles([]);
    setCreateError(null);
    setCreatePromptOverride(defaultVisionOcrEditablePrompt);
    setIsCreatePromptEditorOpen(false);
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

  function removeCreateFile(indexToRemove: number) {
    setSelectedCreateFiles((currentFiles) => currentFiles.filter((_, index) => index !== indexToRemove));
    setCreateError(null);
  }

  async function waitForOcrRetry(context: OcrRetryContext, retryAfterSeconds: number) {
    if (typeof window === "undefined") {
      return;
    }

    let remainingSeconds = Math.max(Math.ceil(retryAfterSeconds), 1);
    setOcrRetryState({ context, secondsRemaining: remainingSeconds });

    await new Promise<void>((resolve) => {
      if (ocrRetryIntervalRef.current !== null) {
        window.clearInterval(ocrRetryIntervalRef.current);
      }

      ocrRetryIntervalRef.current = window.setInterval(() => {
        remainingSeconds -= 1;

        if (remainingSeconds <= 0) {
          if (ocrRetryIntervalRef.current !== null) {
            window.clearInterval(ocrRetryIntervalRef.current);
            ocrRetryIntervalRef.current = null;
          }

          resolve();
          return;
        }

        if (isMountedRef.current) {
          setOcrRetryState({ context, secondsRemaining: remainingSeconds });
        }
      }, 1000);
    });

    if (isMountedRef.current) {
      setOcrRetryState((currentState) => currentState?.context === context ? null : currentState);
    }
  }

  async function runOcrRequestWithRetry<T>(context: OcrRetryContext, action: () => Promise<T>): Promise<T> {
    let retryCount = 0;

    while (true) {
      try {
        const result = await action();
        if (isMountedRef.current) {
          setOcrRetryState((currentState) => currentState?.context === context ? null : currentState);
        }
        return result;
      } catch (error) {
        if (!isRetryableRateLimitError(error) || retryCount >= maximumClientOcrRateLimitRetries) {
          if (isMountedRef.current) {
            setOcrRetryState((currentState) => currentState?.context === context ? null : currentState);
          }
          throw error;
        }

        retryCount += 1;
        await waitForOcrRetry(context, error.retryAfterSeconds ?? 15);
      }
    }
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

      const response = await runOcrRequestWithRetry("create", () => createImageBook(accessToken, formData, {
        ocrMode: createOcrMode,
        ...(createOcrMode === "VISION" && resolveVisionPromptOverride(createPromptOverride)
          ? { promptOverride: resolveVisionPromptOverride(createPromptOverride) }
          : {})
      }));
      await booksQuery.refetch();
      clearCreateSelection();
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
      totalFiles: selectedAppendFiles.length,
      waitMessage: null,
      waitSecondsRemaining: null
    });

    try {
      const formData = new FormData();
      for (const file of selectedAppendFiles) {
        formData.append("images", file);
      }

      const response = await appendImagesToBook(accessToken, selectedBookId, formData, {
        ...(appendAfterPageNumber !== undefined ? { afterPage: appendAfterPageNumber } : {}),
        ocrMode: appendOcrMode,
        ...(appendOcrMode === "VISION" && resolveVisionPromptOverride(appendPromptOverride)
          ? { promptOverride: resolveVisionPromptOverride(appendPromptOverride) }
          : {}),
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

  async function persistReviewImageEdits() {
    if (!accessToken || !reviewBookId || !reviewImageSourceBlob) {
      throw new Error("La imagen original no está disponible para guardar los ajustes.");
    }

    const outputMimeType = resolveReviewImageOutputMimeType(reviewImageSourceBlob.type);
    const editedImageBlob = await renderReviewImageBlob(reviewImageSourceBlob, {
      crop: reviewImageCrop,
      mimeType: outputMimeType,
      rotation: reviewImageRotation,
      ...(outputMimeType === "image/png" ? {} : { quality: 0.92 })
    });
    const formData = new FormData();
    formData.append("image", editedImageBlob, buildReviewImageFileName(reviewPageNumber, outputMimeType));
    await uploadBookPageImage(accessToken, reviewBookId, reviewPageNumber, formData);
  }

  function confirmReviewTextReplacement(actionLabel: string) {
    if (reviewPageAnnotationCount === 0) {
      return true;
    }

    const summaryParts = [
      reviewPageBookmarkCount > 0 ? `${reviewPageBookmarkCount} ${reviewPageBookmarkCount === 1 ? "marcador" : "marcadores"}` : null,
      reviewPageHighlightCount > 0 ? `${reviewPageHighlightCount} ${reviewPageHighlightCount === 1 ? "resaltado" : "resaltados"}` : null,
      reviewPageNoteCount > 0 ? `${reviewPageNoteCount} ${reviewPageNoteCount === 1 ? "nota" : "notas"}` : null
    ].filter(Boolean).join(", ");

    return window.confirm(
      `Esta página tiene ${summaryParts}. Al ${actionLabel}, el sistema intentará recolocar esas anotaciones automáticamente en los nuevos párrafos. Revisa la página después por si alguna necesitara ajuste manual. ¿Continuar?`
    );
  }

  async function handleSaveOcr(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || !reviewBookId) {
      return;
    }

    const hasTextChanges = editedText !== originalEditedText;
    const hasImageChanges = reviewImageRotation !== originalReviewImageRotation || !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);

    if (!hasTextChanges && !hasImageChanges) {
      return;
    }

    if (hasTextChanges && !confirmReviewTextReplacement("guardar el OCR")) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);

    try {
      if (hasImageChanges) {
        await persistReviewImageEdits();
      }

      if (hasTextChanges) {
        await updateOcrPage(accessToken, reviewBookId, reviewPageNumber, { editedText });
      }

      setOriginalEditedText(editedText);
      setReviewMessage(
        hasTextChanges && hasImageChanges
          ? (reviewPageAnnotationCount > 0 ? "El texto OCR, la imagen ajustada y el remapeo de anotaciones se guardaron correctamente." : "El texto OCR y la imagen ajustada se guardaron correctamente.")
          : hasTextChanges
            ? (reviewPageAnnotationCount > 0 ? "El texto OCR de la página se actualizó y se intentó conservar las anotaciones existentes." : "El texto OCR de la página se actualizó correctamente.")
            : "La imagen ajustada de la página se guardó correctamente."
      );

      if (hasTextChanges || hasImageChanges) {
        await Promise.all([reviewPageQuery.refetch(), reviewAnnotationsQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch()]);
      }
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudieron guardar los cambios de la página.");
    } finally {
      setIsSavingReview(false);
    }
  }

  async function handleRerunOcr(modeOverride?: ImageOcrMode, promptOverride?: string) {
    if (!accessToken || !reviewBookId) {
      return;
    }

    const nextMode = modeOverride ?? reviewOcrMode;
    const hasPendingImageEdits = reviewImageRotation !== originalReviewImageRotation || !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);
    const normalizedPromptOverride = nextMode === "VISION" && promptOverride ? resolveVisionPromptOverride(promptOverride) : undefined;

    if (!confirmReviewTextReplacement("volver a ejecutar el OCR")) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);
    setIsRerunningOcr(true);
    setIsReviewOcrMenuVisible(false);

    try {
      if (hasPendingImageEdits) {
        await persistReviewImageEdits();
      }

      setReviewOcrMode(nextMode);
      await runOcrRequestWithRetry("review", () => rerunOcrPage(accessToken, reviewBookId, reviewPageNumber, {
        ocrMode: nextMode,
        ...(normalizedPromptOverride ? { promptOverride: normalizedPromptOverride } : {})
      }));
      setReviewPromptOverride(defaultVisionOcrEditablePrompt);
      setIsReviewPromptEditorOpen(false);
      setReviewMessage(reviewPageAnnotationCount > 0
        ? "El OCR de la página se volvió a reconocer y se intentó conservar las anotaciones existentes."
        : "El OCR de la página se volvió a reconocer correctamente.");
      await Promise.all([reviewPageQuery.refetch(), reviewAnnotationsQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo volver a reconocer el OCR de la página.");
    } finally {
      setIsRerunningOcr(false);
      setIsSavingReview(false);
    }
  }

  async function handleDeleteReviewPage() {
    if (!accessToken || !reviewBookId || !selectedReviewBook || isDeletingReviewPage || isSavingReview) {
      return;
    }

    const confirmed = window.confirm(`Se borrará la página ${reviewPageNumber} de este libro. Esta acción no se puede deshacer. ¿Continuar?`);
    if (!confirmed) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsDeletingReviewPage(true);
    setIsReviewOcrMenuVisible(false);
    setIsReviewIndexVisible(false);

    try {
      const response = await deleteBookPage(accessToken, reviewBookId, reviewPageNumber);
      await Promise.all([booksQuery.refetch(), reviewNavigationQuery.refetch()]);

      if (response.nextPageNumber === null) {
        if (response.book.sourceType === "IMAGES") {
          navigate({
            hash: "#append-pages",
            pathname: "/builder",
            search: `?appendBookId=${encodeURIComponent(reviewBookId)}&insertAfterPage=0`
          });
          return;
        }

        navigate("/");
        return;
      }

      setReviewPageNumber(response.nextPageNumber);
      setReviewPageJumpValue(String(response.nextPageNumber));
      setReviewMessage(`La página ${response.deletedPageNumber} se borró correctamente.`);

      if (response.nextPageNumber === reviewPageNumber) {
        await Promise.all([reviewPageQuery.refetch(), reviewAnnotationsQuery.refetch()]);
      }
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo borrar la página.");
    } finally {
      setIsDeletingReviewPage(false);
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

  function rotateReviewImage(direction: -1 | 1) {
    if (isReviewCropMode) {
      return;
    }

    setReviewImageRotation((currentRotation) => rotateReviewImageValue(currentRotation, direction));
    setReviewMessage(null);
    setReviewError(null);
  }

  function beginReviewCropMode() {
    setReviewCropDraft(reviewCropToRect(reviewImageCrop));
    setIsReviewCropMode(true);
    setReviewMessage(null);
    setReviewError(null);
  }

  function cancelReviewCropMode() {
    setReviewCropDraft(reviewCropToRect(reviewImageCrop));
    setIsReviewCropMode(false);
  }

  function applyReviewCropDraft() {
    setReviewImageCrop(reviewRectToCrop(reviewCropDraft));
    setIsReviewCropMode(false);
    setReviewMessage(null);
    setReviewError(null);
  }

  function startReviewCropDrag(handle: ReviewCropHandle, event: React.PointerEvent<HTMLDivElement | HTMLButtonElement>) {
    if (!reviewCropSurfaceRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const bounds = reviewCropSurfaceRef.current.getBoundingClientRect();
    reviewCropPointerSessionRef.current = {
      boundsHeight: bounds.height,
      boundsWidth: bounds.width,
      handle,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: reviewCropDraft
    };
  }

  function resetReviewImageAdjustments() {
    setIsReviewCropMode(false);
    setReviewImageCrop(originalReviewImageCrop);
    setReviewCropDraft(reviewCropToRect(originalReviewImageCrop));
    setReviewImageRotation(originalReviewImageRotation);
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
        return headingMatch?.[1]?.length ?? 0;
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

  const reviewImageRotationDirty = reviewImageRotation !== originalReviewImageRotation;
  const reviewImageCropDirty = !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);
  const hasReviewImage = Boolean(reviewPageQuery.data?.page.hasSourceImage);
  const shouldShowReviewSourcePanel = hasReviewImage || selectedReviewBook?.sourceType !== "PDF";
  const canRerunReviewOcr = hasReviewImage && selectedReviewBook?.sourceType === "IMAGES";
  const hasPendingReviewImageEdits = reviewImageRotationDirty || reviewImageCropDirty;
  const isReviewDirty = editedText !== originalEditedText || hasPendingReviewImageEdits;
  const reviewPageBookmarkCount = reviewAnnotationsQuery.data?.bookmarks.length ?? 0;
  const reviewPageHighlightCount = reviewAnnotationsQuery.data?.highlights.length ?? 0;
  const reviewPageNoteCount = reviewAnnotationsQuery.data?.notes.length ?? 0;
  const reviewPageAnnotationCount = reviewPageBookmarkCount + reviewPageHighlightCount + reviewPageNoteCount;
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
  const reviewOutlineSourceMeta = getOutlineSourceMeta(reviewNavigationQuery.data?.tocSource ?? "NONE");

  return (
    <div className="page-stack builder-layout">
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
              <Link
                aria-label="Volver a la estantería"
                className="secondary-button link-button reader-header-icon-button"
                title="Volver a la estantería"
                to="/"
              >
                <BackIcon />
              </Link>
            )}
          </div>

          <div className={isAppendOnlyMode ? "builder-board builder-board-append" : "builder-board"}>
            {!isAppendOnlyMode ? (
              <article className="builder-form-card">
                <h3>Crear un libro nuevo</h3>

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

                  <div className="capture-input-grid">
                    <label aria-label="Imágenes del nuevo libro" className="capture-action-card capture-action-card-icon-only" title="Añadir imágenes">
                      <span className="capture-action-icon" aria-hidden="true">
                        <FilesIcon />
                      </span>
                      <input
                        accept="image/png,image/jpeg,image/webp"
                        className="capture-action-input"
                        disabled={isCreating}
                        multiple
                        onChange={handleCreateFileSelection}
                        type="file"
                      />
                    </label>

                    <button
                      aria-label="Añadir desde cámara"
                      className="capture-action-card capture-action-card-icon-only"
                      disabled={isCreating || isCreateCameraStarting}
                      onClick={handleOpenCreateCamera}
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
                    onChange={handleCreateFileSelection}
                    ref={createCameraInputRef}
                    type="file"
                  />

                  <div className="selected-book-banner append-ocr-banner">
                    <span>Modo OCR</span>
                    <div className="ocr-prompt-trigger-anchor">
                      <div className="ocr-prompt-trigger-group">
                        <div className="append-placement-picker" role="radiogroup" aria-label="Modo OCR para crear el libro">
                          <button
                            aria-checked={createOcrMode === "VISION"}
                            className={createOcrMode === "VISION" ? "append-placement-option active" : "append-placement-option"}
                            onClick={() => setCreateOcrMode("VISION")}
                            role="radio"
                            type="button"
                          >
                            Preciso con IA
                          </button>
                          <button
                            aria-checked={createOcrMode === "LOCAL"}
                            className={createOcrMode === "LOCAL" ? "append-placement-option active" : "append-placement-option"}
                            onClick={() => setCreateOcrMode("LOCAL")}
                            role="radio"
                            type="button"
                          >
                            Rápido local
                          </button>
                        </div>
                        {createOcrMode === "VISION" ? (
                          <button
                            aria-expanded={isCreatePromptEditorOpen}
                            aria-label="Editar prompt de Preciso con IA"
                            className={isCreatePromptEditorOpen ? "ocr-prompt-toggle active" : "ocr-prompt-toggle"}
                            disabled={isCreating}
                            onClick={() => setIsCreatePromptEditorOpen((current) => !current)}
                            title="Editar prompt de Preciso con IA"
                            type="button"
                          >
                            <PromptIcon />
                          </button>
                        ) : null}
                      </div>
                      {createOcrMode === "VISION" && isCreatePromptEditorOpen ? (
                        <OcrPromptEditor
                          disabled={isCreating}
                          helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para crear este libro. Si lo restableces, vuelve al mensaje user por defecto."
                          onChange={setCreatePromptOverride}
                          onReset={() => setCreatePromptOverride(defaultVisionOcrEditablePrompt)}
                          value={createPromptOverride}
                        />
                      ) : null}
                    </div>
                  </div>

                  {selectedCreateFiles.length > 0 ? (
                    <div className="file-pill-list file-pill-list-append">
                      {selectedCreateFiles.map((file, index) => (
                        <span className="file-pill file-pill-removable" key={`${file.name}-${index}`}>
                          <span>{file.name}</span>
                          <button
                            aria-label={`Eliminar ${file.name}`}
                            className="file-pill-remove"
                            disabled={isCreating}
                            onClick={() => removeCreateFile(index)}
                            type="button"
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {selectedCreateFiles.length > 0 ? (
                    <button className="secondary-button" disabled={isCreating} onClick={clearCreateSelection} type="button">
                      Limpiar selección
                    </button>
                  ) : null}

                  {createError ? <p className="error-text">{createError}</p> : null}
                  {isCreating && ocrRetryState?.context === "create" ? (
                    <p aria-live="polite" className="helper-text ocr-waiting-text">{buildOcrRetryCountdownLabel(ocrRetryState.secondsRemaining)}</p>
                  ) : null}

                  <button className="primary-button" disabled={isCreating} type="submit">
                    {isCreating ? "Procesando OCR..." : "Crear libro desde imágenes"}
                  </button>
                </form>
              </article>
            ) : null}

            {isAppendOnlyMode ? (
              <article className="builder-form-card builder-form-card-append">
                <form className="stack-form" id="append-pages" onSubmit={handleAppendImages}>
                  {selectedAppendBook && appendReferencePageNumber !== undefined ? (
                    <div className="selected-book-banner append-position-banner">
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
                            isAppending && appendImportProgress?.stage === "waiting" && appendImportProgress.currentFileIndex === index ? "file-pill-waiting" : "",
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
                          {isAppending && appendImportProgress?.stage === "waiting" && appendImportProgress.currentFileIndex === index ? (
                            <span className="file-pill-status">Espera {appendImportProgress.waitSecondsRemaining ?? 0} s</span>
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
                  {isAppending && appendImportProgress?.stage === "waiting" ? (
                    <p aria-live="polite" className="helper-text ocr-waiting-text">
                      {buildOcrRetryCountdownLabel(appendImportProgress.waitSecondsRemaining ?? 1)}
                    </p>
                  ) : null}

                  <div className="selected-book-banner append-ocr-banner">
                    <span>Modo OCR</span>
                    <div className="ocr-prompt-trigger-anchor">
                      <div className="ocr-prompt-trigger-group">
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
                        {appendOcrMode === "VISION" ? (
                          <button
                            aria-expanded={isAppendPromptEditorOpen}
                            aria-label="Editar prompt de Preciso con IA"
                            className={isAppendPromptEditorOpen ? "ocr-prompt-toggle active" : "ocr-prompt-toggle"}
                            disabled={isAppending}
                            onClick={() => setIsAppendPromptEditorOpen((current) => !current)}
                            title="Editar prompt de Preciso con IA"
                            type="button"
                          >
                            <PromptIcon />
                          </button>
                        ) : null}
                      </div>
                      {appendOcrMode === "VISION" && isAppendPromptEditorOpen ? (
                        <OcrPromptEditor
                          disabled={isAppending}
                          helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para añadir estas páginas. Si lo restableces, vuelve al mensaje user por defecto."
                          onChange={setAppendPromptOverride}
                          onReset={() => setAppendPromptOverride(defaultVisionOcrEditablePrompt)}
                          value={appendPromptOverride}
                        />
                      ) : null}
                    </div>
                  </div>

                  {appendError ? <p className="error-text">{appendError}</p> : null}
                  {!appendError && appendImportProgress?.stage === "failed" && appendImportProgress.errorMessage ? (
                    <p className="error-text">{appendImportProgress.errorMessage}</p>
                  ) : null}

                  <button className="secondary-button" disabled={isAppending} type="submit">
                    {isAppending ? "Procesando OCR..." : "Añadir páginas"}
                  </button>
                </form>
              </article>
            ) : null}
          </div>

          {isCreateCameraModalOpen ? (
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
                    disabled={isCreateCameraCapturing}
                    onClick={closeCreateCameraModal}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="camera-capture-preview">
                  {createCameraStream ? (
                    <>
                      <video muted playsInline ref={createCameraVideoRef} />
                      <div className="camera-capture-overlay-actions">
                        <button
                          className="primary-button camera-capture-primary-button"
                          disabled={!createCameraStream || isCreateCameraCapturing}
                          onClick={handleCaptureCreateCameraFrame}
                          type="button"
                        >
                          {isCreateCameraCapturing ? "Guardando..." : "Tomar foto"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="subdued">Abriendo camara...</p>
                  )}
                </div>

                <canvas className="camera-capture-canvas" ref={createCameraCanvasRef} />

                <div className="camera-capture-actions">
                  <button className="secondary-button" disabled={isCreateCameraCapturing} onClick={closeCreateCameraModal} type="button">
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ) : null}

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

        {reviewableBooks.length === 0 ? (
          <div className="empty-state">
            <p>Todavía no hay libros PDF o creados desde imágenes para revisar.</p>
          </div>
        ) : (
          <>
            {reviewPageQuery.isLoading ? <p className="subdued">Cargando página para revisión...</p> : null}
            {reviewPageQuery.isError ? <p className="error-text">No se pudo cargar la página seleccionada.</p> : null}

            <div className={shouldShowReviewSourcePanel ? "builder-review-grid" : "builder-review-grid builder-review-grid-single"}>
              {shouldShowReviewSourcePanel ? (
              <article className={isRerunningOcr ? "review-panel review-panel-processing" : "review-panel"}>
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">{hasReviewImage ? "Imagen original" : "Contenido fuente"}</p>
                    {hasReviewImage ? (
                      <p className={hasPendingReviewImageEdits ? "helper-text review-image-rotation-status is-pending" : "helper-text review-image-rotation-status"}>
                        {isReviewCropMode
                          ? "Ajusta el marco con el ratón o con el dedo y aplica el recorte."
                          : hasPendingReviewImageEdits
                            ? "Ajustes pendientes por guardar."
                            : "Imagen guardada."}
                      </p>
                    ) : null}
                  </div>

                  {hasReviewImage ? (
                    <div aria-label="Controles de imagen" className="review-image-rotation-controls" role="toolbar">
                      <button
                        className="review-image-rotation-button"
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => rotateReviewImage(-1)}
                        title="Girar 90° a la izquierda"
                        type="button"
                      >
                        <RotateLeftIcon />
                      </button>
                      <button
                        className="review-image-rotation-button"
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => rotateReviewImage(1)}
                        title="Girar 90° a la derecha"
                        type="button"
                      >
                        <RotateRightIcon />
                      </button>
                      <button
                        className={isReviewCropMode ? "review-image-mode-button active" : "review-image-mode-button"}
                        disabled={isSavingReview || !reviewBookId}
                        onClick={() => {
                          if (isReviewCropMode) {
                            cancelReviewCropMode();
                            return;
                          }

                          beginReviewCropMode();
                        }}
                        type="button"
                      >
                        <CropIcon />
                        <span>{isReviewCropMode ? "Cancelar recorte" : "Recortar"}</span>
                      </button>
                      <button
                        className="secondary-button review-image-reset-button"
                        disabled={isSavingReview || (!hasPendingReviewImageEdits && !isReviewCropMode)}
                        onClick={resetReviewImageAdjustments}
                        type="button"
                      >
                        Restablecer
                      </button>
                    </div>
                  ) : null}
                </div>

                {isReviewCropMode ? (
                  reviewImageStageUrl ? (
                    <div className="review-crop-workspace">
                      <div className="review-image-frame review-crop-frame">
                        <div className="review-crop-surface" ref={reviewCropSurfaceRef}>
                          <img
                            alt={`Página ${reviewPageNumber} para recorte`}
                            className="preview-image review-crop-stage-image"
                            src={reviewImageStageUrl}
                          />
                          <div className="review-crop-mask review-crop-mask-top" style={{ height: `${reviewCropDraft.y}%` }} />
                          <div className="review-crop-mask review-crop-mask-bottom" style={{ height: `${100 - reviewCropDraft.y - reviewCropDraft.height}%` }} />
                          <div className="review-crop-mask review-crop-mask-left" style={{ height: `${reviewCropDraft.height}%`, top: `${reviewCropDraft.y}%`, width: `${reviewCropDraft.x}%` }} />
                          <div className="review-crop-mask review-crop-mask-right" style={{ height: `${reviewCropDraft.height}%`, top: `${reviewCropDraft.y}%`, width: `${100 - reviewCropDraft.x - reviewCropDraft.width}%` }} />
                          <div
                            className="review-crop-selection"
                            onPointerDown={(event) => startReviewCropDrag("move", event)}
                            style={{ height: `${reviewCropDraft.height}%`, left: `${reviewCropDraft.x}%`, top: `${reviewCropDraft.y}%`, width: `${reviewCropDraft.width}%` }}
                          >
                            <div className="review-crop-selection-grid" />
                            <span className="review-crop-selection-label">Marco de recorte</span>
                            <button aria-label="Ajustar esquina superior izquierda" className="review-crop-handle review-crop-handle-nw" onPointerDown={(event) => startReviewCropDrag("nw", event)} type="button" />
                            <button aria-label="Ajustar esquina superior derecha" className="review-crop-handle review-crop-handle-ne" onPointerDown={(event) => startReviewCropDrag("ne", event)} type="button" />
                            <button aria-label="Ajustar esquina inferior derecha" className="review-crop-handle review-crop-handle-se" onPointerDown={(event) => startReviewCropDrag("se", event)} type="button" />
                            <button aria-label="Ajustar esquina inferior izquierda" className="review-crop-handle review-crop-handle-sw" onPointerDown={(event) => startReviewCropDrag("sw", event)} type="button" />
                          </div>
                        </div>
                      </div>

                      <div className="review-crop-actions">
                        <button className="secondary-button" disabled={isSavingReview} onClick={cancelReviewCropMode} type="button">
                          Cancelar
                        </button>
                        <button className="primary-button" disabled={isSavingReview} onClick={applyReviewCropDraft} type="button">
                          Aplicar recorte
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-state compact-state">
                      <p>Preparando la imagen para recortarla...</p>
                    </div>
                  )
                ) : (
                  reviewImageUrl ? (
                    <div className={isRerunningOcr ? "review-image-frame is-processing" : "review-image-frame"}>
                      <img
                        alt={`Página ${reviewPageNumber} para revisión OCR`}
                        className="preview-image"
                        src={reviewImageUrl}
                      />
                      {isRerunningOcr ? (
                        <div aria-live="polite" className="review-image-processing-overlay">
                          <span className="review-processing-spinner" />
                          <div className="review-processing-copy">
                            <strong>{ocrRetryState?.context === "review" ? "Esperando cupo de GitHub Models..." : "Reconociendo OCR..."}</strong>
                            {ocrRetryState?.context === "review" ? <span>{buildOcrRetryCountdownLabel(ocrRetryState.secondsRemaining)}</span> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="empty-state compact-state">
                      <p>No hay imagen asociada a esta página.</p>
                    </div>
                  )
                )}
              </article>
              ) : null}

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
      {reviewableBooks.length > 0 ? (
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
                  <div className="reader-navigation-section-heading-copy">
                    <strong>Índice del libro</strong>
                    {reviewOutlineSourceMeta ? <span className="reader-navigation-source-badge" title={reviewOutlineSourceMeta.description}>{reviewOutlineSourceMeta.badgeLabel}</span> : null}
                  </div>
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
              disabled={isDeletingReviewPage || reviewPageNumber <= 1}
              onClick={() => changeReviewPage(-1)}
              title="Página anterior"
              type="button"
            >
              <PagePreviousIcon />
            </button>

            <button
              aria-label="Página siguiente"
              className="reader-float-button"
              disabled={isDeletingReviewPage || reviewPageNumber >= (selectedReviewBook?.totalPages ?? 0)}
              onClick={() => changeReviewPage(1)}
              title="Página siguiente"
              type="button"
            >
              <PageNextIcon />
            </button>

            <button
              aria-label={isDeletingReviewPage ? "Borrando página" : "Borrar página"}
              className="reader-float-button danger"
              disabled={isDeletingReviewPage || isSavingReview || !reviewBookId || isReviewCropMode}
              onClick={() => void handleDeleteReviewPage()}
              title={isDeletingReviewPage ? "Borrando página..." : "Borrar página"}
              type="button"
            >
              <DeletePageIcon />
            </button>

            {canRerunReviewOcr ? (
            <div className="review-floating-ocr-menu">
              {isReviewOcrMenuVisible ? (
                <div aria-label="Opciones de OCR" className="review-floating-ocr-panel" role="dialog">
                  <p className="review-floating-ocr-title">Volver a reconocer con</p>
                  <div className="review-ocr-option-stack">
                    <div className="review-ocr-option-row">
                      <button
                        className={reviewOcrMode === "VISION" ? "review-ocr-option active" : "review-ocr-option"}
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => void handleRerunOcr("VISION", reviewPromptOverride)}
                        type="button"
                      >
                        <strong>Preciso con IA</strong>
                        <span>Mayor precisión para páginas difíciles.</span>
                      </button>
                      <button
                        aria-expanded={isReviewPromptEditorOpen}
                        aria-label="Editar prompt de Preciso con IA"
                        className={isReviewPromptEditorOpen ? "ocr-prompt-toggle active" : "ocr-prompt-toggle"}
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => setIsReviewPromptEditorOpen((current) => !current)}
                        title="Editar prompt de Preciso con IA"
                        type="button"
                      >
                        <PromptIcon />
                      </button>
                    </div>
                    {isReviewPromptEditorOpen ? (
                      <OcrPromptEditor
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para volver a reconocer esta página. Si lo restableces, vuelve al mensaje user por defecto."
                        onChange={setReviewPromptOverride}
                        onReset={() => setReviewPromptOverride(defaultVisionOcrEditablePrompt)}
                        value={reviewPromptOverride}
                      />
                    ) : null}
                  </div>
                  <button
                    className={reviewOcrMode === "LOCAL" ? "review-ocr-option active" : "review-ocr-option"}
                    disabled={isSavingReview || !reviewBookId || isReviewCropMode}
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
                disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                onClick={() => setIsReviewOcrMenuVisible((current) => !current)}
                title={isRerunningOcr ? "Reconociendo OCR..." : "Opciones de OCR"}
                type="button"
              >
                <span>OCR</span>
              </button>
            </div>
            ) : null}

            <button
              aria-label={isSavingReview ? "Guardando cambios" : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar cambios")}
              className="reader-float-button primary"
              disabled={isSavingReview || isDeletingReviewPage || !reviewBookId || !isReviewDirty || isReviewCropMode}
              form="ocr-review-form"
              title={isSavingReview ? "Guardando cambios..." : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar cambios")}
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
