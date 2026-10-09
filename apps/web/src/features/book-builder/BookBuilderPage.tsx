import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  appendImagesToBook,
  cancelAppendImagesImport,
  createImageBook,
  deleteBookPage,
  fetchAppendImagesImportProgress,
  fetchAwsCostMonthToDate,
  fetchBookPage,
  fetchBookPageImage,
  fetchBooks,
  fetchPageAnnotations,
  fetchReaderNavigation,
  isRetryableRateLimitError,
  rerunOcrPage,
  uploadBookPageImage,
  saveVisualPageDocument,
  type AppendImagesImportProgress,
  type ImageRotation,
  type ImageOcrMode,
  type OcrWaitReason,
  type ReaderBookmark,
  type ReaderHighlight,
  type ReaderNote,
  type ReaderTocEntry,
  type VisualPageDocument,
  type HighlightColor
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { BOOK_LANGUAGE_OPTIONS, getBookLanguageLabel, normalizeBookLanguageCode, type BookLanguageCode } from "../../app/book-language";
import { formatExactDate, formatRelativeDate } from "../../app/date-format";
import { playCompletionSound, prepareCompletionSound, type CompletionSound } from "../../app/notification-sound";
import { formatSectionTitleWithAncestors } from "../../app/outline-source";
import { bookmarkToneClassName } from "../reader/ReaderFloatingPanels";
import { AiMissingBanner } from "../../components/AiMissingBanner";
import { AwsCostBadge } from "../../components/AwsCostBadge";
import { ImageViewerModal } from "../../components/ImageViewerModal";
import { AdvancedLayoutCheckbox, OcrModelSelect, OcrPromptEditor, defaultOcrMode, normalizeOcrOptions, useOcrModelSelection } from "../../components/OcrConfig";
import { usePageSwipe } from "../../hooks/usePageSwipe";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { DocumentScannerModal } from "./DocumentScannerModal";
import { readingDraftSyncAction, type ReadingDraftVersion } from "./reading-blocks";
import { VisualPageEditor } from "./VisualPageEditor";
import { clearVisualGeometry, pushVisualHistory, redoVisualHistory, undoVisualHistory, visualDocumentFromPage, visualDocumentSaveError, type VisualHistory } from "./visual-page";

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

function CheckIcon() {
  return (
    <ToolbarIcon>
      <path d="M5.5 12.5L10 17L18.5 7.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function BookmarkIcon() {
  return (
    <ToolbarIcon>
      <path d="M7 5.5H17C17.5523 5.5 18 5.94772 18 6.5V19L12 15.25L6 19V6.5C6 5.94772 6.44772 5.5 7 5.5Z" fill="currentColor" />
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

function ResetIcon() {
  return (
    <ToolbarIcon>
      <path d="M18.7 9.3C17.65 6.64 15.04 4.75 12 4.75C7.99694 4.75 4.75 7.99694 4.75 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M19.25 5.5V9.5H15.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5.3 14.7C6.35 17.36 8.96 19.25 12 19.25C16.0031 19.25 19.25 16.0031 19.25 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M4.75 18.5V14.5H8.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
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

function AddPagesIcon() {
  return (
    <ToolbarIcon>
      <path d="M12 6.75V17.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
      <path d="M6.75 12H17.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </ToolbarIcon>
  );
}

function ActionsMenuIcon() {
  return (
    <ToolbarIcon>
      <circle cx="6.5" cy="12" fill="currentColor" r="1.5" />
      <circle cx="12" cy="12" fill="currentColor" r="1.5" />
      <circle cx="17.5" cy="12" fill="currentColor" r="1.5" />
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

function documentCameraConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
    height: { ideal: 2160 },
    width: { ideal: 3840 }
  };
}

const defaultVisionOcrEditablePrompt = "";

const imageFileNameCollator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

function sortImageFilesByNameNatural(files: File[]): File[] {
  return [...files].sort((left, right) => imageFileNameCollator.compare(left.name, right.name));
}

function moveFileInList(files: File[], fromIndex: number, toIndex: number): File[] {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= files.length || toIndex >= files.length || fromIndex === toIndex) {
    return files;
  }

  const nextFiles = [...files];
  const [moved] = nextFiles.splice(fromIndex, 1);
  if (!moved) {
    return files;
  }

  nextFiles.splice(toIndex, 0, moved);
  return nextFiles;
}

function extensionForImageMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function normalizePastedImageFile(file: File, index: number): File {
  if (file.name && /\.(jpe?g|png|webp)$/iu.test(file.name.trim())) {
    return file;
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const extension = extensionForImageMimeType(file.type);
  const fileName = `pegado-${stamp}-${index + 1}.${extension}`;
  return new File([file], fileName, { type: file.type || `image/${extension}` });
}

type FileTransferSource = {
  files?: FileList | null;
  items?: DataTransferItemList | null;
} | null;

function extractImageFilesFromTransfer(source: FileTransferSource): File[] {
  if (!source) return [];
  const collected: File[] = [];
  if (source.files && source.files.length > 0) {
    collected.push(...Array.from(source.files));
  }
  if (collected.length === 0 && source.items) {
    for (const item of Array.from(source.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) collected.push(file);
    }
  }
  return collected.map((file, index) => normalizePastedImageFile(file, index));
}

function transferContainsFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  try {
    if (Array.from(dataTransfer.types ?? []).includes("Files")) return true;
  } catch {
    return (dataTransfer.files?.length ?? 0) > 0;
  }
  return (dataTransfer.files?.length ?? 0) > 0;
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
      createdAt: string;
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

function formatAnnotationAnchor(pageNumber: number, paragraphNumber: number, toc: ReaderTocEntry[]) {
  const section = toc.reduce<ReaderTocEntry | null>((currentSection, entry) => {
    const startsBeforeAnnotation = entry.pageNumber < pageNumber
      || (entry.pageNumber === pageNumber && entry.paragraphNumber <= paragraphNumber);

    if (!startsBeforeAnnotation) {
      return currentSection;
    }

    if (!currentSection
      || entry.pageNumber > currentSection.pageNumber
      || (entry.pageNumber === currentSection.pageNumber && entry.paragraphNumber >= currentSection.paragraphNumber)) {
      return entry;
    }

    return currentSection;
  }, null);

  const sectionTitle = formatSectionTitleWithAncestors(section, toc);
  return `Pág. ${pageNumber} · ${sectionTitle ? `Sección: ${sectionTitle}` : "Sin sección"}`;
}

function formatPageAnchor(pageNumber: number) {
  return `Pág. ${pageNumber}`;
}

function isReviewKeyboardNavigationEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input,textarea,select,[contenteditable],[role='textbox'],[role='combobox'],[role='listbox']"));
}

function notePreview(note: ReaderNote) {
  const sourceExcerpt = note.highlightedText?.trim();
  if (sourceExcerpt) {
    return sourceExcerpt;
  }

  return note.noteText;
}

function highlightPreview(highlight: ReaderHighlight) {
  return highlight.highlightedText.trim() || "Resaltado sin texto";
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

type AppendInsertionSide = "before" | "after";
type ScannerTarget = "append" | "create";
type ReviewImageCropEdge = "bottom" | "left" | "right" | "top";
type ReviewImageCrop = Record<ReviewImageCropEdge, number>;
type ReviewCropHandle = "move" | "nw" | "ne" | "se" | "sw" | "n" | "s" | "e" | "w";
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

const reviewImageRotationSteps: readonly ImageRotation[] = [0, 90, 180, 270];
const defaultReviewImageCrop: ReviewImageCrop = { bottom: 0, left: 0, right: 0, top: 0 };
const maximumReviewImageCropPercent = 40;
const minimumReviewImageRemainingPercent = 15;

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

  if (handle === "nw" || handle === "sw" || handle === "w") {
    nextLeft = Math.min(Math.max(startRect.x + deltaXPercent, 0), startRight - minimumSize);
  }

  if (handle === "ne" || handle === "se" || handle === "e") {
    nextRight = Math.max(Math.min(startRight + deltaXPercent, 100), startRect.x + minimumSize);
  }

  if (handle === "nw" || handle === "ne" || handle === "n") {
    nextTop = Math.min(Math.max(startRect.y + deltaYPercent, 0), startBottom - minimumSize);
  }

  if (handle === "sw" || handle === "se" || handle === "s") {
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

function reviewImageDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("No se pudo preparar la vista de la imagen."));
    reader.readAsDataURL(blob);
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
  reason: OcrWaitReason;
  secondsRemaining: number;
};

type ReviewOcrToastState = string;

type AppendResumeState = {
  completedFiles: number;
  insertionStartPageNumber: number | null;
  nextAfterPage: number | null;
};

type AppendOcrFailureChoice = "retry" | "skip";

type AppendOcrFailureState = {
  fileName: string;
  message: string;
  pageIndex: number;
  totalPages: number;
};

type BuilderWakeLockSentinel = {
  addEventListener?: (type: "release", listener: () => void) => void;
  release: () => Promise<void>;
  released?: boolean;
};

type BuilderWakeLockApi = {
  request: (type: "screen") => Promise<BuilderWakeLockSentinel>;
};

const maximumClientOcrTransientRetries = 3;
const appendCancelHoldMilliseconds = 5000;
const reviewOcrToastSuccessMilliseconds = 3000;

function buildOcrRetryCountdownLabel(secondsRemaining: number, reason: OcrWaitReason = "rate-limit") {
  const normalizedSeconds = Math.max(Math.ceil(secondsRemaining), 1);
  if (reason === "unavailable") {
    return `El servicio de OCR de OpenCode no está disponible temporalmente. Reintentando automáticamente en ${normalizedSeconds} s.`;
  }
  if (reason === "invalid-response") {
    return `OpenCode devolvió una respuesta no válida. Reintentando automáticamente en ${normalizedSeconds} s.`;
  }
  return `OpenCode limitó temporalmente el OCR. Reintentando automáticamente en ${normalizedSeconds} s.`;
}

function getBuilderWakeLockApi() {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
    return null;
  }

  return (navigator as Navigator & { wakeLock?: BuilderWakeLockApi }).wakeLock ?? null;
}

export function BookBuilderPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accessToken = useAuthStore((state) => state.accessToken);
  const hasAwsCredentials = useAuthStore((state) => state.user?.aiCredentials?.hasAwsCredentials === true);
  const [createForm, setCreateForm] = useState<{ authorName: string; languageCode: BookLanguageCode; synopsis: string; title: string }>({ authorName: "", languageCode: "es", synopsis: "", title: "" });
  const [selectedCreateFiles, setSelectedCreateFiles] = useState<File[]>([]);
  const [selectedAppendFiles, setSelectedAppendFiles] = useState<File[]>([]);
  const [selectedBookId, setSelectedBookId] = useState("");
  const [reviewBookId, setReviewBookId] = useState("");
  const [reviewPageNumber, setReviewPageNumber] = useState(1);
  const [reviewPageId, setReviewPageId] = useState(searchParams.get("reviewPageId")?.trim() ?? "");
  const [visualHistory, setVisualHistory] = useState<VisualHistory | null>(null);
  const [originalVisualDocument, setOriginalVisualDocument] = useState("");
  const savedVisualDocument = useMemo(() => originalVisualDocument ? JSON.parse(originalVisualDocument) as VisualPageDocument : null, [originalVisualDocument]);
  const visualDocument = visualHistory?.present ?? null;
  const visualDocumentDirty = Boolean(visualDocument && JSON.stringify(visualDocument) !== originalVisualDocument);
  const [selectedElementKey, setSelectedElementKey] = useState<string | null>(null);
  const [isVisualEditorBusy, setIsVisualEditorBusy] = useState(false);
  const [reviewBlockLoadError, setReviewBlockLoadError] = useState<string | null>(null);
  const [reviewPartialSave, setReviewPartialSave] = useState(false);
  const [reviewDraftConflict, setReviewDraftConflict] = useState(false);
  const [isReviewCropMode, setIsReviewCropMode] = useState(false);
  const [reviewImageCrop, setReviewImageCrop] = useState<ReviewImageCrop>(defaultReviewImageCrop);
  const [reviewCropDraft, setReviewCropDraft] = useState<ReviewCropRect>(() => reviewCropToRect(defaultReviewImageCrop));
  const [originalReviewImageCrop, setOriginalReviewImageCrop] = useState<ReviewImageCrop>(defaultReviewImageCrop);
  const [reviewImageRotation, setReviewImageRotation] = useState<ImageRotation>(0);
  const [originalReviewImageRotation, setOriginalReviewImageRotation] = useState<ImageRotation>(0);
  const [createOcrMode, setCreateOcrMode] = useState<ImageOcrMode>(defaultOcrMode);
  const [appendOcrMode, setAppendOcrMode] = useState<ImageOcrMode>(defaultOcrMode);
  const [createAdvancedLayout, setCreateAdvancedLayout] = useState(false);
  const [appendAdvancedLayout, setAppendAdvancedLayout] = useState(false);
  const [reviewAdvancedLayout, setReviewAdvancedLayout] = useState(false);
  const [appendInsertionSide, setAppendInsertionSide] = useState<AppendInsertionSide>("after");
  const [appendReferencePageInput, setAppendReferencePageInput] = useState("1");
  const [appendProgressId, setAppendProgressId] = useState<string | null>(null);
  const [appendImportProgress, setAppendImportProgress] = useState<AppendImagesImportProgress | null>(null);
  const [appendProgressOffset, setAppendProgressOffset] = useState(0);
  const [appendResumeState, setAppendResumeState] = useState<AppendResumeState | null>(null);
  const [appendOcrFailure, setAppendOcrFailure] = useState<AppendOcrFailureState | null>(null);
  const [appendCancelHoldProgress, setAppendCancelHoldProgress] = useState(0);
  const [isAppendCancelRequested, setIsAppendCancelRequested] = useState(false);
  const [isCreateCameraModalOpen, setIsCreateCameraModalOpen] = useState(false);
  const [createCameraStream, setCreateCameraStream] = useState<MediaStream | null>(null);
  const [isCreateCameraStarting, setIsCreateCameraStarting] = useState(false);
  const [isCreateCameraCapturing, setIsCreateCameraCapturing] = useState(false);
  const [isAppendCameraModalOpen, setIsAppendCameraModalOpen] = useState(false);
  const [appendCameraStream, setAppendCameraStream] = useState<MediaStream | null>(null);
  const [isAppendCameraStarting, setIsAppendCameraStarting] = useState(false);
  const [isAppendCameraCapturing, setIsAppendCameraCapturing] = useState(false);
  const [scannerRequest, setScannerRequest] = useState<{ files: File[]; target: ScannerTarget } | null>(null);
  const [shouldAdjustCreateBorders, setShouldAdjustCreateBorders] = useState(false);
  const [shouldAdjustAppendBorders, setShouldAdjustAppendBorders] = useState(false);
  const [isCreateDragging, setIsCreateDragging] = useState(false);
  const [isAppendDragging, setIsAppendDragging] = useState(false);
  const [reviewOcrMode, setReviewOcrMode] = useState<ImageOcrMode>(defaultOcrMode);
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
  const [reviewOcrToast, setReviewOcrToast] = useState<ReviewOcrToastState | null>(null);
  const [selectedViewerImage, setSelectedViewerImage] = useState<{ alt?: string; src: string; title?: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isDeletingReviewPage, setIsDeletingReviewPage] = useState(false);
  const [isRerunningOcr, setIsRerunningOcr] = useState(false);
  const [ocrRetryState, setOcrRetryState] = useState<OcrRetryState | null>(null);
  const [isReviewIndexVisible, setIsReviewIndexVisible] = useState(false);
  const [reviewNavigationTab, setReviewNavigationTab] = useState<"index" | "notes">("index");
  const [isReviewOcrMenuVisible, setIsReviewOcrMenuVisible] = useState(false);
  const [isReviewPageJumpActive, setIsReviewPageJumpActive] = useState(false);
  const [isFloatingReviewHeaderExpanded, setIsFloatingReviewHeaderExpanded] = useState(false);
  const [floatingReviewHeaderDockStyle, setFloatingReviewHeaderDockStyle] = useState<CSSProperties | null>(null);
  const [reviewPageJumpValue, setReviewPageJumpValue] = useState("1");
  const [reviewImageSourceBlob, setReviewImageSourceBlob] = useState<{ blob: Blob; key: string } | null>(null);
  const [reviewImageLoadingKey, setReviewImageLoadingKey] = useState<string | null>(null);
  const [reviewImageStageUrl, setReviewImageStageUrl] = useState<string | null>(null);
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);
  const reviewDraftVersionRef = useRef<ReadingDraftVersion | null>(null);
  const reviewDraftDirtyRef = useRef(false);
  const reviewPageNavigationPendingRef = useRef(false);
  reviewDraftDirtyRef.current = visualDocumentDirty
    || reviewPartialSave
    || reviewImageRotation !== originalReviewImageRotation
    || !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop)
    || isVisualEditorBusy
    || (isReviewCropMode && !equalReviewImageCrop(reviewRectToCrop(reviewCropDraft), reviewImageCrop));
  const reviewCropPointerSessionRef = useRef<ReviewCropPointerSession | null>(null);
  const reviewCropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const reviewSwipeSurfaceRef = useRef<HTMLFormElement | null>(null);
  const reviewPageJumpInputRef = useRef<HTMLInputElement | null>(null);
  const reviewIndexPanelRef = useRef<HTMLElement | null>(null);
  const reviewIndexToggleRef = useRef<HTMLButtonElement | null>(null);
  const reviewOcrPanelRef = useRef<HTMLDivElement | null>(null);
  const reviewOcrToggleRef = useRef<HTMLButtonElement | null>(null);
  const reviewPanelRef = useRef<HTMLElement | null>(null);
  const floatingReviewHeaderRef = useRef<HTMLDivElement | null>(null);
  const activeReviewNavItemRef = useRef<HTMLButtonElement | null>(null);
  const createCameraInputRef = useRef<HTMLInputElement | null>(null);
  const createCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const createCameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const appendCameraInputRef = useRef<HTMLInputElement | null>(null);
  const appendCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const appendCameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isMountedRef = useRef(true);
  const ocrRetryIntervalRef = useRef<number | null>(null);
  const reviewOcrToastTimeoutRef = useRef<number | null>(null);
  const appendWakeLockRef = useRef<BuilderWakeLockSentinel | null>(null);
  const appendOcrFailureResolverRef = useRef<((choice: AppendOcrFailureChoice) => void) | null>(null);
  const appendCancelHoldTimeoutRef = useRef<number | null>(null);
  const appendCancelHoldIntervalRef = useRef<number | null>(null);
  const isAppendCancelRequestedRef = useRef(false);
  const activeOcrOperationsRef = useRef(new Set<"append" | OcrRetryContext>());
  const createDragCounterRef = useRef(0);
  const appendDragCounterRef = useRef(0);
  const requestedAppendBookId = searchParams.get("appendBookId")?.trim() ?? "";
  const requestedInsertAfterPageParam = searchParams.get("insertAfterPage")?.trim() ?? "";
  const requestedInsertSideParam = searchParams.get("insertSide")?.trim() ?? "";
  const requestedReviewBookId = searchParams.get("reviewBookId")?.trim() ?? "";
  const requestedReviewPageParam = searchParams.get("reviewPage")?.trim() ?? "";
  const requestedReviewPageId = searchParams.get("reviewPageId")?.trim() ?? "";
  useEffect(() => {
    if (requestedReviewPageId) setReviewPageId(requestedReviewPageId);
  }, [requestedReviewPageId]);
  const returnTo = typeof location.state === "object"
    && location.state !== null
    && "returnTo" in location.state
    && typeof location.state.returnTo === "string"
      ? location.state.returnTo
      : null;
  const isAppendOnlyMode = requestedAppendBookId.length > 0;
  const isReviewOnlyMode = requestedReviewBookId.length > 0;
  const operationContext = isAppendOnlyMode ? "append" : isReviewOnlyMode ? "review" : "builder";
  const createSelection = useOcrModelSelection(`${operationContext}:create`);
  const appendSelection = useOcrModelSelection(`${operationContext}:append:${requestedAppendBookId || selectedBookId}`);
  const { models: ocrModelOptions, selectedModelId: selectedOcrModel, selectedModel: selectedOcrModelOption, setSelectedModelId: setOcrModelOverride, canRunOcr, compatibilityMessage } = useOcrModelSelection(`${operationContext}:review:${requestedReviewBookId || reviewBookId}`);
  const reviewOcrModelLabel = selectedOcrModelOption?.name ?? selectedOcrModel;
  const awsCostQuery = useQuery({
    enabled: Boolean(accessToken) && hasAwsCredentials,
    queryFn: () => fetchAwsCostMonthToDate(accessToken as string),
    queryKey: ["aws-cost-month-to-date"],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60 * 60 * 1000
  });
  const awsTextractCostLabel = awsCostQuery.data
    ? `${awsCostQuery.data.total.toFixed(2)} ${awsCostQuery.data.currency}`
    : "—";
  const booksQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["builder-books"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Missing access token.");
      }

      const response = await fetchBooks(accessToken, { scope: "all" });
      return response.books;
    }
  });

  const editableBooks = (booksQuery.data ?? []).filter((book) => book.currentUserRole === undefined
    || book.currentUserRole === "OWNER"
    || book.currentUserRole === "EDITOR");
  const imageBooks = editableBooks.filter((book) => book.sourceType === "IMAGES");
  const reviewableBooks = editableBooks.filter((book) => book.sourceType === "IMAGES" || book.sourceType === "PDF" || book.sourceType === "EPUB");
  const selectedReviewBook = reviewableBooks.find((book) => book.bookId === reviewBookId) ?? null;
  const selectedAppendBook = imageBooks.find((book) => book.bookId === selectedBookId) ?? null;
  const requestedReviewPage = requestedReviewPageParam ? Number(requestedReviewPageParam) : Number.NaN;
  const requestedInsertAfterPage = requestedInsertAfterPageParam ? Number(requestedInsertAfterPageParam) : Number.NaN;
  // insertSide=before preselecciona "Antes" en el banner de posición (la galería lo usa
  // para sus botones de inserción). insertAfterPage=0 heredado equivale a antes de la 1.
  const initialAppendInsertionSide: AppendInsertionSide =
    requestedInsertSideParam === "before" || (requestedInsertSideParam !== "after" && requestedInsertAfterPage === 0)
      ? "before"
      : "after";
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
  const appendCompletedFileCount = Math.min(
    selectedAppendFiles.length,
    Math.max(0, appendProgressOffset + (isAppending ? appendImportProgress?.completedFiles ?? 0 : appendResumeState?.completedFiles ?? 0))
  );
  const appendCurrentFileIndex = isAppending && appendImportProgress?.currentFileIndex !== null && appendImportProgress?.currentFileIndex !== undefined
    ? Math.min(selectedAppendFiles.length - 1, appendProgressOffset + appendImportProgress.currentFileIndex)
    : null;
  const appendProgressStage = appendImportProgress?.stage ?? null;
  const appendProgressTotalFiles = selectedAppendFiles.length;
  const appendProgressCompletedPercent = appendProgressTotalFiles > 0
    ? Math.round((appendCompletedFileCount / appendProgressTotalFiles) * 100)
    : 0;

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (ocrRetryIntervalRef.current !== null) {
        window.clearInterval(ocrRetryIntervalRef.current);
        ocrRetryIntervalRef.current = null;
      }
      if (reviewOcrToastTimeoutRef.current !== null) {
        window.clearTimeout(reviewOcrToastTimeoutRef.current);
        reviewOcrToastTimeoutRef.current = null;
      }
      clearAppendCancelHold();
      void releaseAppendScreenWakeLock();
    };
  }, []);

  useEffect(() => {
    isAppendCancelRequestedRef.current = isAppendCancelRequested;
  }, [isAppendCancelRequested]);

  useEffect(() => {
    setAppendInsertionSide(initialAppendInsertionSide);
    resetAppendResumeState();
  }, [requestedAppendBookId, requestedInsertAfterPageParam, requestedInsertSideParam]);

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
    resetAppendResumeState();
  }, [selectedBookId, appendInsertionSide]);

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

  useEffect(() => {
    if (!isAppending || typeof document === "undefined") {
      return;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const activeElement = document.activeElement;
    document.body.style.overflow = "hidden";
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    void ensureAppendScreenWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void ensureAppendScreenWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearAppendCancelHold();
      void releaseAppendScreenWakeLock();
    };
  }, [isAppending]);

  const reviewPageQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode),
    queryKey: ["builder-page-visual", reviewBookId, reviewPageId ? { pageId: reviewPageId } : reviewPageNumber, "include-inactive"],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchBookPage(accessToken, reviewBookId, reviewPageNumber, { includeInactive: true, ...(reviewPageId ? { pageId: reviewPageId } : {}) });
    }
  });
  const reviewPageIdentity = `${reviewBookId}:${reviewPageQuery.data?.page.pageId ?? reviewPageId}`;
  const reviewPageIdentityRef = useRef(reviewPageIdentity);
  reviewPageIdentityRef.current = reviewPageIdentity;
  useEffect(() => {
    const page = reviewPageQuery.data?.page;
    if (!page || reviewPageQuery.isFetching || (reviewPageId && page.pageId !== reviewPageId)) return;
    setReviewPageId(page.pageId);
    setReviewPageNumber(page.pageNumber);
  }, [reviewPageId, reviewPageQuery.data?.page, reviewPageQuery.isFetching]);

  const reviewAnnotationsQuery = useQuery({
    enabled: Boolean(accessToken && reviewBookId && isReviewOnlyMode && reviewPageQuery.data?.page.pageNumber === reviewPageNumber),
    queryKey: ["builder-page-annotations", reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.pageId],
    queryFn: async () => {
      if (!accessToken || !reviewBookId) {
        throw new Error("Missing access token.");
      }

      return fetchPageAnnotations(accessToken, reviewBookId, reviewPageNumber, { includeInactive: true });
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
  const reviewSourceImageKey = reviewPageQuery.data?.page.hasSourceImage
    ? `${reviewBookId}:${reviewPageQuery.data.page.pageId}:${reviewPageQuery.data.page.sourceFileId ?? ""}:${reviewPageQuery.data.page.updatedAt ?? ""}`
    : null;

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
    } else if (hasRequestedAppendBook) {
      if (selectedBookId !== requestedAppendBookId) {
        setSelectedBookId(requestedAppendBookId);
      }
    } else if (!selectedBookId) {
      setSelectedBookId(firstImageBook.bookId);
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

    if (!page || reviewPageQuery.isFetching || (reviewPageId && page.pageId !== reviewPageId)) {
      return;
    }

    const remoteVersion = { identity: `${reviewBookId}:${page.pageId}`, updatedAt: page.updatedAt };
    const syncAction = readingDraftSyncAction(reviewDraftVersionRef.current, remoteVersion, reviewDraftDirtyRef.current);
    if (syncAction === "preserve") return;
    if (syncAction === "conflict") {
      setReviewDraftConflict(true);
      return;
    }
    reviewDraftVersionRef.current = remoteVersion;
    reviewDraftDirtyRef.current = false;
    setReviewDraftConflict(false);
    setReviewPartialSave(false);

    setSelectedElementKey(null);
    try {
      const document = visualDocumentFromPage(page);
      setVisualHistory({ past: [], present: document, future: [] });
      setOriginalVisualDocument(JSON.stringify(document));
      setReviewBlockLoadError(null);
    } catch (error) {
      setVisualHistory(null);
      setReviewBlockLoadError(error instanceof Error ? error.message : "No se pudo cargar el documento visual.");
    }
    setIsReviewCropMode(false);
    setReviewImageCrop(defaultReviewImageCrop);
    setReviewCropDraft(reviewCropToRect(defaultReviewImageCrop));
    setOriginalReviewImageCrop(defaultReviewImageCrop);
    setReviewImageRotation(page.sourceImageRotation);
    setOriginalReviewImageRotation(page.sourceImageRotation);
  }, [reviewBookId, reviewPageId, reviewPageQuery.data?.page, reviewPageQuery.dataUpdatedAt, reviewPageQuery.isFetching]);

  useEffect(() => {
    setReviewError(null);
    setReviewMessage(null);
  }, [reviewBookId, reviewPageNumber]);

  useEffect(() => {
    if (isReviewPageJumpActive) {
      return;
    }

    setReviewPageJumpValue(String(reviewPageNumber));
  }, [isReviewPageJumpActive, reviewPageNumber]);

  usePageSwipe({
    canGoNext: reviewPageNumber < (selectedReviewBook?.totalPages ?? 0),
    canGoPrevious: reviewPageNumber > 1,
    enabled: isReviewOnlyMode && !isReviewCropMode && !isVisualEditorBusy && !isSavingReview && !isDeletingReviewPage && !isRerunningOcr,
    ignoreSelector: ".visual-page-editor,.visual-dialog,.review-floating-controls,.reader-header-floating-dock,.reader-navigation-panel,.review-floating-ocr-panel,.review-crop-workspace",
    onNext: () => changeReviewPage(1),
    onPrevious: () => changeReviewPage(-1),
    ref: reviewSwipeSurfaceRef
  });

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

    if (!isReviewOnlyMode || !accessToken || !reviewBookId || !reviewSourceImageKey || reviewPartialSave) {
      setReviewImageSourceBlob(null);
      setReviewImageStageUrl(null);
      setReviewImageUrl(null);
      setReviewImageLoadingKey(null);
      return () => {
        active = false;
      };
    }

    setReviewImageLoadingKey(reviewSourceImageKey);

    void fetchBookPageImage(
      accessToken,
      reviewBookId,
      reviewPageNumber,
      `${reviewPageQuery.data?.page.sourceFileId ?? ""}:${reviewPageQuery.data?.page.updatedAt ?? ""}`,
      false,
      reviewPageQuery.data?.page.pageId
    )
      .then((imageBlob) => {
        if (!active) {
          return;
        }

        setReviewImageSourceBlob({ blob: imageBlob, key: reviewSourceImageKey });
      })
      .catch(() => {
        if (active) {
          setReviewImageSourceBlob(null);
          setReviewImageUrl(null);
          setReviewImageLoadingKey((current) => current === reviewSourceImageKey ? null : current);
        }
      });

    return () => {
      active = false;
    };
  }, [accessToken, isReviewOnlyMode, reviewBookId, reviewPageNumber, reviewPageQuery.data?.page.pageId, reviewPageQuery.data?.page.sourceFileId, reviewSourceImageKey, reviewPartialSave]);

  useEffect(() => {
    let active = true;
    setReviewImageStageUrl(null);
    const sourceBlob = reviewImageSourceBlob?.blob ?? null;

    if (!sourceBlob) {
      setReviewImageStageUrl(null);
      return () => {
        active = false;
      };
    }

    void renderReviewImageBlob(sourceBlob, {
      crop: defaultReviewImageCrop,
      maxDimension: 1600,
      mimeType: "image/png",
      rotation: reviewImageRotation
    })
      .then(reviewImageDataUrl)
      .then((stageUrl) => {
        if (!active) {
          return;
        }

        setReviewImageStageUrl(stageUrl);
      })
      .catch(() => {
        if (active) {
          setReviewImageStageUrl(null);
        }
      });

    return () => {
      active = false;
    };
  }, [reviewImageRotation, reviewImageSourceBlob]);

  useEffect(() => {
    let active = true;
    const sourceBlob = reviewImageSourceBlob?.blob ?? null;
    const sourceKey = reviewImageSourceBlob?.key ?? null;

    if (!sourceBlob) {
      setReviewImageUrl(null);
      return () => {
        active = false;
      };
    }

    void renderReviewImageBlob(sourceBlob, {
      crop: reviewImageCrop,
      maxDimension: 1600,
      mimeType: "image/png",
      rotation: reviewImageRotation
    })
      .then(reviewImageDataUrl)
      .then((previewUrl) => {
        if (!active) {
          return;
        }

        setReviewImageUrl(previewUrl);
        if (sourceKey === reviewSourceImageKey) {
          setReviewImageLoadingKey((current) => current === sourceKey ? null : current);
        }
      })
      .catch(() => {
        if (active) {
          setReviewImageUrl(null);
          if (sourceKey === reviewSourceImageKey) {
            setReviewImageLoadingKey((current) => current === sourceKey ? null : current);
          }
        }
      });

    return () => {
      active = false;
    };
  }, [reviewImageCrop, reviewImageRotation, reviewImageSourceBlob, reviewSourceImageKey]);

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

  useEffect(() => {
    if (!isReviewOcrMenuVisible || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (reviewOcrPanelRef.current?.contains(target) || reviewOcrToggleRef.current?.contains(target)) {
        return;
      }

      setIsReviewOcrMenuVisible(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsReviewOcrMenuVisible(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isReviewOcrMenuVisible]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function updateFloatingReviewHeaderPosition() {
      const panelRect = reviewPanelRef.current?.getBoundingClientRect();
      const viewportPadding = 12;
      const panelInset = 10;

      if (panelRect) {
        const nextTop = Math.max(viewportPadding, panelRect.top + panelInset);
        const nextRight = Math.max(viewportPadding, window.innerWidth - panelRect.right + panelInset);
        setFloatingReviewHeaderDockStyle((current) => {
          const top = `${nextTop}px`;
          const right = `${nextRight}px`;
          if (current?.top === top && current?.right === right) {
            return current;
          }

          return { right, top };
        });
      } else {
        setFloatingReviewHeaderDockStyle(null);
      }
    }

    updateFloatingReviewHeaderPosition();
    window.addEventListener("resize", updateFloatingReviewHeaderPosition);
    window.addEventListener("scroll", updateFloatingReviewHeaderPosition, { passive: true });

    return () => {
      window.removeEventListener("resize", updateFloatingReviewHeaderPosition);
      window.removeEventListener("scroll", updateFloatingReviewHeaderPosition);
    };
  }, [isReviewOnlyMode]);

  useEffect(() => {
    if (!isFloatingReviewHeaderExpanded || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const targetNode = event.target as Node;
      if (floatingReviewHeaderRef.current?.contains(targetNode)) {
        return;
      }

      setIsFloatingReviewHeaderExpanded(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFloatingReviewHeaderExpanded(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFloatingReviewHeaderExpanded]);

  function toFileArray(fileList: FileList | null): File[] {
    return fileList ? Array.from(fileList) : [];
  }

  function isSupportedImageFile(file: File): boolean {
    const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    const normalizedName = file.name.toLowerCase();

    return supportedMimeTypes.has(file.type) || /\.(jpe?g|png|webp)$/u.test(normalizedName);
  }

  function createFiles(files: File[]) {
    const validFiles = sortImageFilesByNameNatural(files.filter(isSupportedImageFile));
    const invalidFiles = files.filter((file) => !isSupportedImageFile(file));

    if (validFiles.length > 0) {
      if (shouldAdjustCreateBorders) {
        setScannerRequest({ files: validFiles, target: "create" });
      } else {
        setSelectedCreateFiles((currentFiles) => [...currentFiles, ...validFiles]);
      }
    }

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

  function resetAppendResumeState() {
    setAppendResumeState(null);
    setAppendProgressOffset(0);
    setAppendImportProgress(null);
    setIsAppendCancelRequested(false);
    isAppendCancelRequestedRef.current = false;
    setAppendCancelHoldProgress(0);
    setAppendOcrFailure(null);
  }

  function appendFiles(files: File[]) {
    const validFiles = sortImageFilesByNameNatural(files.filter(isSupportedImageFile));
    const invalidFiles = files.filter((file) => !isSupportedImageFile(file));

    if (validFiles.length > 0) {
      if (shouldAdjustAppendBorders) {
        setScannerRequest({ files: validFiles, target: "append" });
      } else {
        resetAppendResumeState();
        setSelectedAppendFiles((currentFiles) => [...currentFiles, ...validFiles]);
      }
    }

    if (invalidFiles.length > 0) {
      const invalidNames = invalidFiles.map((file) => file.name).join(", ");
      setAppendError(`Algunas imágenes no se pueden usar todavía (${invalidNames}). Usa PNG, JPG o WEBP.`);
      return;
    }

    setAppendError(null);
  }

  function handleScannerComplete(files: File[]) {
    const target = scannerRequest?.target;
    setScannerRequest(null);

    if (target === "create") {
      setSelectedCreateFiles((currentFiles) => [...currentFiles, ...files]);
      return;
    }
    if (target === "append") {
      resetAppendResumeState();
      setSelectedAppendFiles((currentFiles) => [...currentFiles, ...files]);
    }
  }

  function handleAppendFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    appendFiles(toFileArray(event.target.files));
    event.target.value = "";
  }

  function handleCreateDragEnter(event: React.DragEvent) {
    if (isCreating || !transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    createDragCounterRef.current += 1;
    setIsCreateDragging(true);
  }

  function handleCreateDragOver(event: React.DragEvent) {
    if (isCreating || !transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsCreateDragging(true);
  }

  function handleCreateDragLeave(event: React.DragEvent) {
    if (!isCreateDragging) return;
    createDragCounterRef.current = Math.max(0, createDragCounterRef.current - 1);
    if (createDragCounterRef.current === 0) setIsCreateDragging(false);
  }

  function handleCreateDrop(event: React.DragEvent) {
    if (isCreating) return;
    const files = extractImageFilesFromTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    createDragCounterRef.current = 0;
    setIsCreateDragging(false);
    createFiles(files);
  }

  function handleAppendDragEnter(event: React.DragEvent) {
    if (isAppending || !transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    appendDragCounterRef.current += 1;
    setIsAppendDragging(true);
  }

  function handleAppendDragOver(event: React.DragEvent) {
    if (isAppending || !transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsAppendDragging(true);
  }

  function handleAppendDragLeave(event: React.DragEvent) {
    if (!isAppendDragging) return;
    appendDragCounterRef.current = Math.max(0, appendDragCounterRef.current - 1);
    if (appendDragCounterRef.current === 0) setIsAppendDragging(false);
  }

  function handleAppendDrop(event: React.DragEvent) {
    if (isAppending) return;
    const files = extractImageFilesFromTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    appendDragCounterRef.current = 0;
    setIsAppendDragging(false);
    appendFiles(files);
  }

  useEffect(() => {
    if (isReviewOnlyMode || typeof document === "undefined") return;
    function handleGlobalPaste(event: ClipboardEvent) {
      const files = extractImageFilesFromTransfer(event.clipboardData);
      if (!files.length) return;
      if (isAppendOnlyMode) {
        if (isAppending) return;
        event.preventDefault();
        appendFiles(files);
      } else {
        if (isCreating) return;
        event.preventDefault();
        createFiles(files);
      }
    }
    document.addEventListener("paste", handleGlobalPaste);
    return () => document.removeEventListener("paste", handleGlobalPaste);
  }, [isAppendOnlyMode, isReviewOnlyMode, isAppending, isCreating, shouldAdjustAppendBorders, shouldAdjustCreateBorders]);

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
        video: documentCameraConstraints()
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
            video: documentCameraConstraints(preferredDevice.deviceId)
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
        video: documentCameraConstraints()
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
            video: documentCameraConstraints(preferredDevice.deviceId)
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
    resetAppendResumeState();
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
    resetAppendResumeState();
  }

  function removeAppendFile(indexToRemove: number) {
    resetAppendResumeState();
    setSelectedAppendFiles((currentFiles) => currentFiles.filter((_, index) => index !== indexToRemove));
    setAppendError(null);
  }

  function removeCreateFile(indexToRemove: number) {
    setSelectedCreateFiles((currentFiles) => currentFiles.filter((_, index) => index !== indexToRemove));
    setCreateError(null);
  }

  function moveCreateFile(fromIndex: number, direction: -1 | 1) {
    if (isCreating) {
      return;
    }

    setSelectedCreateFiles((currentFiles) => moveFileInList(currentFiles, fromIndex, fromIndex + direction));
  }

  function moveAppendFile(fromIndex: number, direction: -1 | 1) {
    if (isAppending) {
      return;
    }

    const completedFiles = Math.min(appendResumeState?.completedFiles ?? 0, selectedAppendFiles.length);
    const toIndex = fromIndex + direction;
    if (fromIndex < completedFiles || toIndex < completedFiles) {
      return;
    }

    setSelectedAppendFiles((currentFiles) => {
      const completed = Math.min(appendResumeState?.completedFiles ?? 0, currentFiles.length);
      if (fromIndex < completed || toIndex < completed) {
        return currentFiles;
      }

      return moveFileInList(currentFiles, fromIndex, toIndex);
    });
  }

  function clearAppendCancelHold() {
    if (appendCancelHoldTimeoutRef.current !== null) {
      window.clearTimeout(appendCancelHoldTimeoutRef.current);
      appendCancelHoldTimeoutRef.current = null;
    }

    if (appendCancelHoldIntervalRef.current !== null) {
      window.clearInterval(appendCancelHoldIntervalRef.current);
      appendCancelHoldIntervalRef.current = null;
    }

    setAppendCancelHoldProgress(0);
  }

  async function releaseAppendScreenWakeLock() {
    const wakeLock = appendWakeLockRef.current;
    appendWakeLockRef.current = null;

    if (!wakeLock) {
      return;
    }

    try {
      await wakeLock.release();
    } catch {
      // Algunos navegadores liberan el bloqueo automaticamente al cambiar de app.
    }
  }

  async function ensureAppendScreenWakeLock() {
    const wakeLockApi = getBuilderWakeLockApi();
    if (!wakeLockApi) {
      return;
    }

    if (appendWakeLockRef.current && appendWakeLockRef.current.released !== true) {
      return;
    }

    try {
      const wakeLock = await wakeLockApi.request("screen");
      appendWakeLockRef.current = wakeLock;
      wakeLock.addEventListener?.("release", () => {
        if (appendWakeLockRef.current === wakeLock) {
          appendWakeLockRef.current = null;
        }
      });
    } catch {
      // Si falla, el OCR continua sin molestar al usuario con un error extra.
    }
  }

  async function requestAppendCancellation() {
    if (!accessToken || !appendProgressId || isAppendCancelRequested) {
      return;
    }

    setIsAppendCancelRequested(true);
    isAppendCancelRequestedRef.current = true;

    try {
      const response = await cancelAppendImagesImport(accessToken, appendProgressId);
      setAppendImportProgress(response.progress);
    } catch (error) {
      setIsAppendCancelRequested(false);
      isAppendCancelRequestedRef.current = false;
      setAppendError(error instanceof Error ? error.message : "No se pudo solicitar la cancelación.");
    }
  }

  function beginAppendCancelHold() {
    if (!isAppending || isAppendCancelRequested) {
      return;
    }

    clearAppendCancelHold();
    const startedAt = Date.now();
    setAppendCancelHoldProgress(0);

    appendCancelHoldIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setAppendCancelHoldProgress(Math.min(elapsed / appendCancelHoldMilliseconds, 1));
    }, 100);

    appendCancelHoldTimeoutRef.current = window.setTimeout(() => {
      clearAppendCancelHold();
      void requestAppendCancellation();
    }, appendCancelHoldMilliseconds);
  }

  async function waitForOcrRetry(context: OcrRetryContext, retryAfterSeconds: number, reason: OcrWaitReason) {
    if (typeof window === "undefined") {
      return;
    }

    let remainingSeconds = Math.max(Math.ceil(retryAfterSeconds), 1);
    setOcrRetryState({ context, reason, secondsRemaining: remainingSeconds });

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
          setOcrRetryState({ context, reason, secondsRemaining: remainingSeconds });
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
        if (!isRetryableRateLimitError(error) || retryCount >= maximumClientOcrTransientRetries) {
          if (isMountedRef.current) {
            setOcrRetryState((currentState) => currentState?.context === context ? null : currentState);
          }
          throw error;
        }

        retryCount += 1;
        const retryReason: OcrWaitReason = error.code === "OCR_PROVIDER_UNAVAILABLE"
          ? "unavailable"
          : error.code === "OCR_INVALID_RESPONSE"
            ? "invalid-response"
            : "rate-limit";
        await waitForOcrRetry(context, error.retryAfterSeconds ?? 15, retryReason);
      }
    }
  }

  function requestAppendOcrFailureChoice(failure: AppendOcrFailureState): Promise<AppendOcrFailureChoice> {
    setAppendOcrFailure(failure);

    return new Promise((resolve) => {
      appendOcrFailureResolverRef.current = resolve;
    });
  }

  function resolveAppendOcrFailure(choice: AppendOcrFailureChoice) {
    const resolver = appendOcrFailureResolverRef.current;
    appendOcrFailureResolverRef.current = null;
    setAppendOcrFailure(null);
    resolver?.(choice);
  }

  async function handleCreateFromImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createSelection.canRunOcr(createOcrMode, createAdvancedLayout)) {
      setCreateError(createSelection.compatibilityMessage);
      return;
    }

    if (!accessToken || activeOcrOperationsRef.current.has("create")) {
      return;
    }

    if (selectedCreateFiles.length === 0) {
      setCreateError("Selecciona al menos una imagen para crear el libro.");
      return;
    }

    activeOcrOperationsRef.current.add("create");
    setIsCreating(true);
    setCreateError(null);
    prepareCompletionSound();

    try {
      const formData = new FormData();
      formData.append("title", createForm.title);
      formData.append("languageCode", createForm.languageCode);

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
        ...normalizeOcrOptions(createOcrMode, createAdvancedLayout, createSelection.selectedModelId, createPromptOverride)
      }));
      await booksQuery.refetch();
      clearCreateSelection();
      setReviewBookId(response.book.bookId);
      setReviewPageNumber(1);
      playCompletionSound("success");
      navigate(`/books/${response.book.bookId}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "No se pudo crear el libro desde imágenes.");
      playCompletionSound("error");
    } finally {
      activeOcrOperationsRef.current.delete("create");
      setIsCreating(false);
    }
  }

  async function handleAppendImages(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!appendSelection.canRunOcr(appendOcrMode, appendAdvancedLayout)) {
      setAppendError(appendSelection.compatibilityMessage);
      return;
    }

    if (!accessToken || activeOcrOperationsRef.current.has("append")) {
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

    const alreadyCompletedFiles = Math.min(appendResumeState?.completedFiles ?? 0, selectedAppendFiles.length);
    const pendingAppendFiles = selectedAppendFiles.slice(alreadyCompletedFiles);
    const requestAfterPage = appendResumeState?.nextAfterPage ?? appendAfterPageNumber;

    if (pendingAppendFiles.length === 0) {
      setAppendError("Todas las páginas seleccionadas ya están añadidas.");
      return;
    }

    activeOcrOperationsRef.current.add("append");
    setIsAppending(true);
    setAppendError(null);
    setIsAppendCancelRequested(false);
    setAppendProgressOffset(alreadyCompletedFiles);
    void ensureAppendScreenWakeLock();
    prepareCompletionSound();
    setAppendImportProgress({
      bookId: selectedBookId,
      completedFiles: 0,
      currentFileIndex: pendingAppendFiles.length > 0 ? 0 : null,
      currentFileName: pendingAppendFiles[0]?.name ?? null,
      errorMessage: null,
      insertedPages: 0,
      insertionStartPageNumber: appendResumeState?.insertionStartPageNumber ?? null,
      nextAfterPage: requestAfterPage ?? null,
      stage: "ocr",
      totalFiles: pendingAppendFiles.length,
      waitMessage: null,
      waitReason: null,
      waitSecondsRemaining: null
    });

    let completionSound: CompletionSound | null = null;
    let skippedFailedOcr = false;

    try {
      let completedFiles = alreadyCompletedFiles;
      let insertionStartPageNumber = appendResumeState?.insertionStartPageNumber ?? null;
      let nextAfterPage = requestAfterPage ?? null;
      let lastBookId = selectedBookId;

      for (const [pendingIndex, file] of pendingAppendFiles.entries()) {
        const absoluteFileIndex = alreadyCompletedFiles + pendingIndex;

        if (isAppendCancelRequestedRef.current) {
          break;
        }

        while (true) {
          const progressId = crypto.randomUUID();
          const formData = new FormData();
          formData.append("images", file);
          formData.append("languageCode", normalizeBookLanguageCode(selectedAppendBook?.languageCode));
          setAppendProgressId(progressId);
          setAppendProgressOffset(completedFiles);
          setAppendImportProgress({
            bookId: selectedBookId,
            completedFiles: 0,
            currentFileIndex: 0,
            currentFileName: file.name,
            errorMessage: null,
            insertedPages: 0,
            insertionStartPageNumber,
            nextAfterPage,
            stage: "ocr",
            totalFiles: 1,
            waitMessage: null,
            waitReason: null,
            waitSecondsRemaining: null
          });

          try {
            const response = await appendImagesToBook(accessToken, selectedBookId, formData, {
              ...(nextAfterPage !== undefined && nextAfterPage !== null ? { afterPage: nextAfterPage } : {}),
              ...normalizeOcrOptions(appendOcrMode, appendAdvancedLayout, appendSelection.selectedModelId, appendPromptOverride),
              progressId
            });

            if (response.cancelled) {
              completedFiles += response.addedPages;
              insertionStartPageNumber = insertionStartPageNumber ?? response.insertionStartPageNumber;
              nextAfterPage = response.nextAfterPage ?? nextAfterPage;
              setAppendResumeState({ completedFiles, insertionStartPageNumber, nextAfterPage });
              setAppendProgressOffset(completedFiles);
              setAppendError(response.addedPages > 0
                ? `Añadido cancelado. Se añadieron ${completedFiles} de ${selectedAppendFiles.length} páginas.`
                : "Añadido cancelado antes de insertar páginas nuevas.");
              return;
            }

            completedFiles += response.addedPages;
            insertionStartPageNumber = insertionStartPageNumber ?? response.insertionStartPageNumber;
            nextAfterPage = response.nextAfterPage ?? nextAfterPage;
            lastBookId = response.book.bookId;
            setAppendResumeState({ completedFiles, insertionStartPageNumber, nextAfterPage });
            setAppendProgressOffset(completedFiles);
            setAppendImportProgress((currentProgress) => currentProgress
              ? { ...currentProgress, completedFiles: 0, currentFileIndex: null, currentFileName: null, stage: "ocr" }
              : currentProgress);
            break;
          } catch (error) {
            let latestProgress: AppendImagesImportProgress | null = null;
            try {
              const response = await fetchAppendImagesImportProgress(accessToken, progressId);
              latestProgress = response.progress;
              setAppendImportProgress(response.progress);
            } catch {
              // El error principal ya explica el fallo; el progreso solo mejora la reanudación.
            }

            const insertedPages = latestProgress?.insertedPages ?? latestProgress?.completedFiles ?? 0;
            if (insertedPages > 0) {
              completedFiles = Math.min(selectedAppendFiles.length, completedFiles + insertedPages);
              insertionStartPageNumber = insertionStartPageNumber ?? latestProgress?.insertionStartPageNumber ?? null;
              nextAfterPage = latestProgress?.nextAfterPage ?? nextAfterPage;
              setAppendResumeState({ completedFiles, insertionStartPageNumber, nextAfterPage });
              setAppendProgressOffset(completedFiles);
              setAppendImportProgress((currentProgress) => currentProgress
                ? { ...currentProgress, completedFiles: 0, currentFileIndex: null, currentFileName: null, stage: "ocr" }
                : currentProgress);
              break;
            }

            const message = error instanceof Error ? error.message : "No se pudo hacer OCR de esta página.";
            setAppendImportProgress((currentProgress) => currentProgress
              ? { ...currentProgress, errorMessage: message, stage: "failed" }
              : currentProgress);
            const choice = await requestAppendOcrFailureChoice({
              fileName: file.name,
              message,
              pageIndex: absoluteFileIndex + 1,
              totalPages: selectedAppendFiles.length
            });

            if (choice === "retry") {
              continue;
            }

            skippedFailedOcr = true;

            const skipFormData = new FormData();
            skipFormData.append("images", file);
            skipFormData.append("languageCode", normalizeBookLanguageCode(selectedAppendBook?.languageCode));
            const skipProgressId = crypto.randomUUID();
            setAppendProgressId(skipProgressId);
            setAppendImportProgress({
              bookId: selectedBookId,
              completedFiles: 0,
              currentFileIndex: 0,
              currentFileName: file.name,
              errorMessage: null,
              insertedPages: 0,
              insertionStartPageNumber,
              nextAfterPage,
              stage: "saving",
              totalFiles: 1,
              waitMessage: null,
              waitReason: null,
              waitSecondsRemaining: null
            });
            const skipResponse = await appendImagesToBook(accessToken, selectedBookId, skipFormData, {
              ...(nextAfterPage !== undefined && nextAfterPage !== null ? { afterPage: nextAfterPage } : {}),
              ocrMode: appendOcrMode,
              progressId: skipProgressId,
              skipOcr: true
            });

            completedFiles += skipResponse.addedPages;
            insertionStartPageNumber = insertionStartPageNumber ?? skipResponse.insertionStartPageNumber;
            nextAfterPage = skipResponse.nextAfterPage ?? nextAfterPage;
            lastBookId = skipResponse.book.bookId;
            setAppendResumeState({ completedFiles, insertionStartPageNumber, nextAfterPage });
            setAppendProgressOffset(completedFiles);
            setAppendImportProgress((currentProgress) => currentProgress
              ? { ...currentProgress, completedFiles: 0, currentFileIndex: null, currentFileName: null, stage: "ocr" }
              : currentProgress);
            break;
          }
        }
      }

      await booksQuery.refetch();

      if (isAppendCancelRequestedRef.current) {
        setAppendResumeState({ completedFiles, insertionStartPageNumber, nextAfterPage });
        setAppendError(completedFiles > alreadyCompletedFiles
          ? `Añadido cancelado. Se añadieron ${completedFiles} de ${selectedAppendFiles.length} páginas.`
          : "Añadido cancelado antes de insertar páginas nuevas.");
        return;
      }

      const targetPageNumber = insertionStartPageNumber ?? requestAfterPage ?? 1;
      clearAppendSelection();
      if (reviewBookId === selectedBookId) {
        setReviewPageNumber(targetPageNumber);
        setReviewPageId("");
      }
      completionSound = skippedFailedOcr ? "error" : "success";
      if (returnTo && returnTo.startsWith(`/books/${lastBookId}/pages`)) {
        navigate(returnTo);
      } else {
        navigate(`/books/${lastBookId}?page=${targetPageNumber}`);
      }
    } catch (error) {
      setAppendError(error instanceof Error ? error.message : "No se pudieron añadir nuevas páginas.");
      completionSound = "error";
    } finally {
      activeOcrOperationsRef.current.delete("append");
      setIsAppending(false);
      setAppendProgressId(null);
      setIsAppendCancelRequested(false);
      if (completionSound) {
        playCompletionSound(completionSound);
      }
    }
  }

  async function persistReviewImageEdits(expectedVersion: string) {
    const pageId = reviewPageQuery.data?.page.pageId;
    if (!accessToken || !reviewBookId || !reviewImageSourceBlob || !pageId || reviewImageSourceBlob.key !== reviewSourceImageKey || reviewDraftVersionRef.current?.identity !== reviewPageIdentity) {
      throw new Error("La imagen original no está disponible para guardar los ajustes.");
    }

    const outputMimeType = resolveReviewImageOutputMimeType(reviewImageSourceBlob.blob.type);
    const editedImageBlob = await renderReviewImageBlob(reviewImageSourceBlob.blob, {
      crop: reviewImageCrop,
      mimeType: outputMimeType,
      rotation: reviewImageRotation,
      ...(outputMimeType === "image/png" ? {} : { quality: 0.92 })
    });
    const formData = new FormData();
    formData.append("image", editedImageBlob, buildReviewImageFileName(reviewPageNumber, outputMimeType));
    formData.append("expectedUpdatedAt", expectedVersion);
    return uploadBookPageImage(accessToken, reviewBookId, reviewPageNumber, formData, pageId);
  }

  async function preservePartialReviewSave(message: string) {
    const partialMessage = `Guardado parcial: la imagen se guardo, pero el texto y los metadatos no. Se conserva tu borrador sin marcarlo como guardado. La imagen local ya no corresponde al original del servidor; conserva el borrador y vuelve a cargar la pagina para reconciliarlo antes de continuar. ${message}`;
    setReviewPartialSave(true);
    setReviewBlockLoadError(partialMessage);
    setReviewError(partialMessage);
    reviewDraftDirtyRef.current = true;
    setReviewImageSourceBlob(null);
    setReviewImageStageUrl(null);
    setReviewImageUrl(null);
    setReviewImageLoadingKey(null);
    // Refresh remote identity only; the dirty draft must not be initialized.
    await reviewPageQuery.refetch();
  }

  function confirmReviewTextReplacement(actionLabel: string, replacesVisualContent = false) {
    if (reviewPageAnnotationCount === 0 && !replacesVisualContent) {
      return true;
    }

    const summaryParts = [
      reviewPageBookmarkCount > 0 ? `${reviewPageBookmarkCount} ${reviewPageBookmarkCount === 1 ? "marcador" : "marcadores"}` : null,
      reviewPageHighlightCount > 0 ? `${reviewPageHighlightCount} ${reviewPageHighlightCount === 1 ? "resaltado" : "resaltados"}` : null,
      reviewPageNoteCount > 0 ? `${reviewPageNoteCount} ${reviewPageNoteCount === 1 ? "nota" : "notas"}` : null
    ].filter(Boolean).join(", ");

    return window.confirm(
      [replacesVisualContent ? "Volver a ejecutar el OCR reemplazará el contenido de la página, incluidos los estilos editoriales y la maquetación manual, tanto guardados como pendientes de guardar." : null,
        reviewPageAnnotationCount > 0 ? `Esta página tiene ${summaryParts}. Al ${actionLabel}, el sistema intentará recolocar esas anotaciones automáticamente en los nuevos párrafos. Revisa la página después por si alguna necesitara ajuste manual.` : null,
        "¿Continuar?"].filter(Boolean).join(" ")
    );
  }

  async function handleSaveOcr(event?: React.FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();

    if (!accessToken || !reviewBookId || reviewBlockLoadError || reviewPartialSave || !visualDocument || isSavingReview || isReviewCropMode || isVisualEditorBusy || !reviewPageQuery.data?.page.pageId || reviewPageQuery.isFetching || reviewDraftVersionRef.current?.identity !== reviewPageIdentity) {
      return false;
    }

    const hasDocumentChanges = visualDocumentDirty;
    const hasImageChanges = reviewImageRotation !== originalReviewImageRotation || !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);

    if (!hasDocumentChanges && !hasImageChanges) {
      return false;
    }

    if (reviewDraftConflict) {
      setReviewError("La pagina ha cambiado en el servidor. Conserva tu borrador y vuelve a cargar la pagina antes de guardar para evitar sobrescribir la version remota.");
      return false;
    }

    if (hasDocumentChanges && !confirmReviewTextReplacement("guardar el documento visual")) {
      return false;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);

    let imageSaved = false;
    let draftSaved = false;
    try {
      const initialVersion = reviewDraftVersionRef.current?.updatedAt;
      if (!initialVersion) throw new Error("La version de la pagina no esta disponible. Vuelve a cargar antes de guardar.");
      const validationError = visualDocumentSaveError(visualDocument, hasImageChanges);
      if (validationError) throw new Error(validationError);
      let expectedUpdatedAt: string = initialVersion;
      const documentForSave = hasImageChanges ? clearVisualGeometry(visualDocument) : visualDocument;
      if (hasImageChanges) {
        const result = await persistReviewImageEdits(expectedUpdatedAt);
        imageSaved = true;
        expectedUpdatedAt = result.updatedAt;
        reviewDraftVersionRef.current = { identity: reviewPageIdentity, updatedAt: expectedUpdatedAt };
        setVisualHistory({ past: [], present: documentForSave, future: [] });
      }

      const result = await saveVisualPageDocument(accessToken, reviewBookId, reviewPageNumber, { expectedUpdatedAt, document: documentForSave }, reviewPageQuery.data.page.pageId);
      expectedUpdatedAt = result.updatedAt;
      draftSaved = true;

      setVisualHistory({ past: [], present: result.document, future: [] });
      setOriginalVisualDocument(JSON.stringify(result.document));
      if (hasImageChanges) {
        setReviewImageRotation(0);
        setOriginalReviewImageRotation(0);
        setReviewImageCrop(defaultReviewImageCrop);
        setOriginalReviewImageCrop(defaultReviewImageCrop);
        setReviewCropDraft(reviewCropToRect(defaultReviewImageCrop));
      }
      reviewDraftVersionRef.current = { identity: reviewPageIdentity, updatedAt: expectedUpdatedAt };
      reviewDraftDirtyRef.current = false;
      setReviewMessage(hasImageChanges ? "La imagen ajustada y el documento visual se guardaron correctamente." : "El documento visual se guardo correctamente.");

      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(reviewBookId) && query.queryKey[0] !== "builder-page-visual" });
      await Promise.all([reviewPageQuery.refetch(), reviewAnnotationsQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch()]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudieron guardar los cambios de la pagina.";
      if (draftSaved) {
        setReviewError(`Los cambios se guardaron, pero no se pudo actualizar la pagina: ${message}`);
        return true;
      }
      if (imageSaved && !draftSaved) {
        await preservePartialReviewSave(message);
      } else {
        setReviewError(message);
        if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
          setReviewDraftConflict(true);
          await reviewPageQuery.refetch();
        }
      }
      return false;
    } finally {
      setIsSavingReview(false);
    }
  }

  function showReviewOcrToast(message: string) {
    setReviewOcrToast(message);

    if (reviewOcrToastTimeoutRef.current !== null) {
      window.clearTimeout(reviewOcrToastTimeoutRef.current);
    }

    reviewOcrToastTimeoutRef.current = window.setTimeout(() => {
      setReviewOcrToast(null);
      reviewOcrToastTimeoutRef.current = null;
    }, reviewOcrToastSuccessMilliseconds);
  }

  async function handleRerunOcr(modeOverride?: ImageOcrMode, promptOverride?: string) {
    // OCR reads the source image, so an uneditable text/metadata mismatch must not block recovery.
    if (!accessToken || !reviewBookId || reviewPartialSave || reviewDraftConflict || activeOcrOperationsRef.current.has("review") || !reviewPageQuery.data?.page.pageId || reviewPageQuery.isFetching || reviewDraftVersionRef.current?.identity !== reviewPageIdentity) {
      return;
    }

    const nextMode = modeOverride ?? reviewOcrMode;
    if (!canRunOcr(nextMode, reviewAdvancedLayout)) {
      setReviewError(compatibilityMessage);
      return;
    }
    const hasPendingImageEdits = reviewImageRotation !== originalReviewImageRotation || !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);

    if (!confirmReviewTextReplacement("volver a ejecutar el OCR", true)) {
      return;
    }

    activeOcrOperationsRef.current.add("review");
    setReviewError(null);
    setReviewMessage(null);
    setIsSavingReview(true);
    setIsRerunningOcr(true);
    setIsReviewOcrMenuVisible(false);
    prepareCompletionSound();

    let imageSaved = false;
    let ocrSaved = false;
    try {
      if (hasPendingImageEdits) {
        const expectedUpdatedAt = reviewDraftVersionRef.current?.updatedAt;
        if (!expectedUpdatedAt) throw new Error("La version de la pagina no esta disponible. Vuelve a cargar antes de guardar.");
        const result = await persistReviewImageEdits(expectedUpdatedAt);
        imageSaved = true;
        reviewDraftVersionRef.current = { identity: reviewPageIdentity, updatedAt: result.updatedAt };
        if (visualDocument) setVisualHistory({ past: [], present: clearVisualGeometry(visualDocument), future: [] });
      }

      setReviewOcrMode(nextMode);
      if (nextMode === "LOCAL") setReviewAdvancedLayout(false);
      const expectedUpdatedAt = reviewDraftVersionRef.current?.updatedAt;
      if (!expectedUpdatedAt) throw new Error("La version de la pagina no esta disponible. Vuelve a cargar antes de ejecutar el OCR.");
      await runOcrRequestWithRetry("review", () => rerunOcrPage(accessToken, reviewBookId, reviewPageNumber, {
        expectedUpdatedAt,
        ...normalizeOcrOptions(nextMode, reviewAdvancedLayout, selectedOcrModel, promptOverride ?? reviewPromptOverride)
      }, reviewPageQuery.data.page.pageId));
      ocrSaved = true;
      setReviewPromptOverride(defaultVisionOcrEditablePrompt);
      setIsReviewPromptEditorOpen(false);
      const rerunOcrMessage = reviewPageAnnotationCount > 0
        ? "El OCR de la página se volvió a reconocer y se intentó conservar las anotaciones existentes."
        : "El OCR de la página se volvió a reconocer correctamente.";
      if (reviewPageIdentityRef.current === reviewPageIdentity) reviewDraftVersionRef.current = null;
      const [refreshed] = await Promise.all([reviewPageQuery.refetch(), reviewAnnotationsQuery.refetch(), reviewNavigationQuery.refetch(), booksQuery.refetch(),
        ...["book-pages", "book", "book-page", "book-page-image", "reader-annotations", "reader-navigation", "reader-readable-neighbors", "progress", "ai-requests", "section-summary"].map((key) =>
          queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === key && query.queryKey[1] === reviewBookId }))]);
      if (!refreshed.data || refreshed.error) throw refreshed.error ?? new Error("No se pudo recargar la pagina tras el OCR.");
      const page = refreshed.data.page;
      // Only replace the page confirmed for OCR, never a draft opened while it was running.
      const currentVersion = reviewDraftVersionRef.current as ReadingDraftVersion | null;
      if (reviewPageIdentityRef.current === reviewPageIdentity && `${reviewBookId}:${page.pageId}` === reviewPageIdentity && (!currentVersion || currentVersion.identity === reviewPageIdentity)) {
        const document = visualDocumentFromPage(page);
        setVisualHistory({ past: [], present: document, future: [] });
        setOriginalVisualDocument(JSON.stringify(document));
        reviewDraftVersionRef.current = { identity: reviewPageIdentity, updatedAt: page.updatedAt };
        reviewDraftDirtyRef.current = false;
        setReviewDraftConflict(false);
        setReviewBlockLoadError(null);
        setSelectedElementKey(null);
        setIsReviewCropMode(false);
        setReviewImageCrop(defaultReviewImageCrop);
        setReviewCropDraft(reviewCropToRect(defaultReviewImageCrop));
        setOriginalReviewImageCrop(defaultReviewImageCrop);
        setReviewImageRotation(page.sourceImageRotation);
        setOriginalReviewImageRotation(page.sourceImageRotation);
      }
      setReviewMessage(rerunOcrMessage);
      showReviewOcrToast(rerunOcrMessage);
      playCompletionSound("success");
    } catch (error) {
      const rerunOcrErrorMessage = error instanceof Error ? error.message : "No se pudo volver a reconocer el OCR de la página.";
      if (imageSaved && !ocrSaved) await preservePartialReviewSave(rerunOcrErrorMessage);
      else setReviewError(rerunOcrErrorMessage);
      playCompletionSound("error");
    } finally {
      activeOcrOperationsRef.current.delete("review");
      setIsRerunningOcr(false);
      setIsSavingReview(false);
    }
  }

  async function handleDeleteReviewPage() {
    if (!accessToken || !reviewBookId || !reviewPageQuery.data?.page.pageId || reviewPageQuery.isFetching || !selectedReviewBook || isDeletingReviewPage || isSavingReview) {
      return;
    }

    const confirmed = window.confirm(`Se borrará la página ${reviewPageNumber} de la versión procesada del libro, junto con sus párrafos, anotaciones, capítulos y resúmenes asociados. Las páginas posteriores se renumerarán y el archivo original no cambiará. Esta acción no se puede deshacer. ¿Continuar?`);
    if (!confirmed) {
      return;
    }

    setReviewError(null);
    setReviewMessage(null);
    setIsDeletingReviewPage(true);
    setIsReviewOcrMenuVisible(false);
    setIsReviewIndexVisible(false);
    setIsFloatingReviewHeaderExpanded(false);

    try {
      const response = await deleteBookPage(accessToken, reviewBookId, reviewPageNumber, reviewPageQuery.data.page.pageId);
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
      setReviewPageId("");
      setReviewPageJumpValue(String(response.nextPageNumber));
      setReviewMessage(`La página ${response.deletedPageNumber} se borró correctamente.`);

      if (response.nextPageNumber === reviewPageNumber) {
        reviewDraftVersionRef.current = null;
      }
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(reviewBookId) });
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "No se pudo borrar la página.");
    } finally {
      setIsDeletingReviewPage(false);
    }
  }

  async function changeReviewPage(delta: -1 | 1) {
    await jumpToReviewPage(reviewPageNumber + delta);
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

  async function jumpToReviewPage(pageNumber: number) {
    if (reviewPageNavigationPendingRef.current) return;
    reviewPageNavigationPendingRef.current = true;
    try {
      const totalPages = selectedReviewBook?.totalPages ?? 0;
      const nextPage = Math.min(Math.max(pageNumber, 1), Math.max(totalPages, 1));
      if (nextPage !== reviewPageNumber && !(await confirmDiscardReviewChanges())) {
        setReviewPageJumpValue(String(reviewPageNumber));
        return;
      }
      setReviewPageNumber(nextPage);
      if (nextPage !== reviewPageNumber) setReviewPageId("");
      setReviewMessage(null);
      setReviewError(null);
      setIsReviewIndexVisible(false);
    } finally {
      reviewPageNavigationPendingRef.current = false;
    }
  }

  const changeReviewPageRef = useRef(changeReviewPage);
  changeReviewPageRef.current = changeReviewPage;

  const reviewKeyboardGuardRef = useRef({
    isAppendCameraModalOpen,
    isCreateCameraModalOpen,
    isDeletingReviewPage,
    isRerunningOcr,
    isReviewCropMode,
    isReviewOnlyMode,
    isReviewPageJumpActive,
    isSavingReview,
    isVisualEditorBusy,
    scannerRequest,
    selectedViewerImage
  });
  reviewKeyboardGuardRef.current = {
    isAppendCameraModalOpen,
    isCreateCameraModalOpen,
    isDeletingReviewPage,
    isRerunningOcr,
    isReviewCropMode,
    isReviewOnlyMode,
    isReviewPageJumpActive,
    isSavingReview,
    isVisualEditorBusy,
    scannerRequest,
    selectedViewerImage
  };

  useEffect(() => {
    async function handleReviewKeyboardNavigation(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (event.key !== "PageUp" && event.key !== "PageDown") {
        return;
      }

      if (isReviewKeyboardNavigationEditableTarget(event.target)) {
        return;
      }

      const guards = reviewKeyboardGuardRef.current;
      if (!guards.isReviewOnlyMode
        || guards.isReviewCropMode
        || guards.isVisualEditorBusy
        || guards.isSavingReview
        || guards.isDeletingReviewPage
        || guards.isRerunningOcr
        || guards.isReviewPageJumpActive
        || guards.selectedViewerImage
        || guards.scannerRequest
        || guards.isCreateCameraModalOpen
        || guards.isAppendCameraModalOpen) {
        return;
      }

      event.preventDefault();
      await changeReviewPageRef.current(event.key === "PageUp" ? -1 : 1);
    }

    document.addEventListener("keydown", handleReviewKeyboardNavigation);
    return () => {
      document.removeEventListener("keydown", handleReviewKeyboardNavigation);
    };
  }, []);

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

  async function handleReviewPageJumpSubmit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const nextPageNumber = parseReviewPageJumpValue();
    if (nextPageNumber === null) {
      cancelReviewPageJump();
      return;
    }

    setIsReviewPageJumpActive(false);
    await jumpToReviewPage(nextPageNumber);
  }

  function handleBackFromReview() {
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    if (selectedReviewBook) {
      navigate(`/books/${selectedReviewBook.bookId}?page=${reviewPageNumber}&pageId=${encodeURIComponent(reviewPageQuery.data?.page.pageId ?? reviewPageId)}`);
      return;
    }

    navigate("/");
  }

  function handleBackFromAppend() {
    if (returnTo) {
      navigate(returnTo);
      return;
    }

    const appendBookId = selectedAppendBook?.bookId ?? requestedAppendBookId;
    if (appendBookId) {
      const backReviewPage = Number.isInteger(requestedInsertAfterPage) && requestedInsertAfterPage >= 1
        ? requestedInsertAfterPage
        : (appendAfterPageNumber && appendAfterPageNumber >= 1 ? appendAfterPageNumber : 1);
      navigate({
        hash: "#review-ocr",
        pathname: "/builder",
        search: `?reviewBookId=${encodeURIComponent(appendBookId)}&reviewPage=${encodeURIComponent(String(backReviewPage))}`
      });
      return;
    }

    navigate("/");
  }

  const reviewImageRotationDirty = reviewImageRotation !== originalReviewImageRotation;
  const reviewImageCropDirty = !equalReviewImageCrop(reviewImageCrop, originalReviewImageCrop);
  const hasReviewImage = Boolean(reviewPageQuery.data?.page.hasSourceImage);
  const isReviewImageLoading = Boolean(reviewImageLoadingKey);
  const canDeleteReviewPage = selectedReviewBook?.sourceType === "IMAGES" || selectedReviewBook?.sourceType === "PDF" || selectedReviewBook?.sourceType === "EPUB";
  const canAppendReviewPages = selectedReviewBook?.sourceType === "IMAGES" && Boolean(reviewBookId);
  const reviewAppendPagesLink = canAppendReviewPages
    ? {
      hash: "#append-pages",
      pathname: "/builder",
      search: `?appendBookId=${encodeURIComponent(reviewBookId)}&insertAfterPage=${encodeURIComponent(String(reviewPageNumber))}&insertSide=after`
    }
    : null;
  const shouldShowReviewSourcePanel = hasReviewImage || selectedReviewBook?.sourceType === "IMAGES";
  const canRerunReviewOcr = hasReviewImage && selectedReviewBook?.sourceType === "IMAGES";
  const hasPendingReviewImageEdits = reviewImageRotationDirty || reviewImageCropDirty;
  const isReviewDirty = visualDocumentDirty || hasPendingReviewImageEdits || reviewPartialSave;
  const hasPendingReviewCrop = isReviewCropMode && !equalReviewImageCrop(reviewRectToCrop(reviewCropDraft), reviewImageCrop);
  const reviewSaveUnavailableReason = reviewPartialSave
    ? "El guardado anterior fue parcial. Reconcilia el borrador con la version remota antes de guardar."
    : reviewDraftConflict
      ? "La pagina ha cambiado en el servidor. Resuelve el conflicto antes de guardar."
      : isReviewCropMode || hasPendingReviewCrop
        ? "Aplica o cancela el recorte antes de guardar."
        : isVisualEditorBusy
          ? "Termina la interaccion con el editor antes de guardar."
          : reviewBlockLoadError
            ? "No se puede guardar mientras haya un error al cargar el documento."
            : isSavingReview || isRerunningOcr || isDeletingReviewPage || reviewPageQuery.isFetching
              ? "Espera a que termine la operacion en curso antes de guardar."
              : !accessToken || !reviewBookId || !visualDocument || !reviewPageQuery.data?.page.pageId || reviewDraftVersionRef.current?.identity !== reviewPageIdentity || !reviewDraftVersionRef.current?.updatedAt
                ? "La pagina y su version deben estar disponibles antes de guardar."
                : hasPendingReviewImageEdits && (!reviewImageSourceBlob || reviewImageSourceBlob.key !== reviewSourceImageKey)
                  ? "Espera a que la imagen original este disponible antes de guardar sus ajustes."
                  : visualDocumentSaveError(visualDocument, hasPendingReviewImageEdits)
                    || (!isReviewDirty ? "No hay cambios confirmados para guardar." : undefined);
  const confirmDiscardReviewChanges = useUnsavedChanges(isReviewOnlyMode && (isReviewDirty || hasPendingReviewCrop || isVisualEditorBusy), {
    save: () => handleSaveOcr(),
    canSave: !reviewSaveUnavailableReason,
    unavailableReason: reviewSaveUnavailableReason || "No se pueden guardar los cambios en este momento."
  });
  useEffect(() => {
    const page = reviewPageQuery.data?.page;
    if (!isReviewOnlyMode || !page || reviewPageQuery.isFetching || isReviewDirty || hasPendingReviewCrop || isVisualEditorBusy || location.pathname !== "/builder") return;
    const params = new URLSearchParams(location.search);
    params.set("reviewPage", String(page.pageNumber));
    params.set("reviewPageId", page.pageId);
    const search = `?${params}`;
    if (search !== location.search) navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true, state: location.state });
  }, [isReviewOnlyMode, reviewPageQuery.data?.page, reviewPageQuery.isFetching, isReviewDirty, hasPendingReviewCrop, isVisualEditorBusy, location.pathname, location.search, location.hash, location.state, navigate]);
  const reviewEditorKindLabel = selectedReviewBook?.sourceType === "EPUB" ? "texto" : "OCR";
  const reviewPageBookmarkCount = reviewAnnotationsQuery.data?.bookmarks.length ?? 0;
  const reviewPageHighlightCount = reviewAnnotationsQuery.data?.highlights.length ?? 0;
  const reviewPageNoteCount = reviewAnnotationsQuery.data?.notes.length ?? 0;
  const reviewPageAnnotationCount = reviewPageBookmarkCount + reviewPageHighlightCount + reviewPageNoteCount;
  const reviewActiveTocEntry = useMemo(() => {
    const tocEntries = reviewNavigationQuery.data?.toc ?? [];
    let activeEntry: ReaderTocEntry | null = null;

    for (const entry of tocEntries) {
      if (entry.pageNumber <= reviewPageNumber) {
        activeEntry = entry;
      }
    }

    return activeEntry;
  }, [reviewNavigationQuery.data?.toc, reviewPageNumber]);
  const reviewActiveChapterTitle = useMemo(() => {
    return formatSectionTitleWithAncestors(reviewActiveTocEntry, reviewNavigationQuery.data?.toc);
  }, [reviewActiveTocEntry, reviewNavigationQuery.data?.toc]);
  const activeTocEntryKey = reviewActiveTocEntry ? tocEntryKey(reviewActiveTocEntry) : null;
  const reviewActiveReadingSection = useMemo(() => {
    if (!reviewActiveTocEntry || reviewActiveTocEntry.sequenceNumber === null) {
      return null;
    }

    return reviewNavigationQuery.data?.readingMetrics.sections.find((section) => (
      reviewActiveTocEntry.chapterId
        ? section.chapterId === reviewActiveTocEntry.chapterId
        : section.startSequenceNumber === reviewActiveTocEntry.sequenceNumber
    )) ?? null;
  }, [reviewActiveTocEntry, reviewNavigationQuery.data?.readingMetrics.sections]);
  const reviewNextChapterPageNumber = reviewActiveTocEntry
    ? reviewActiveReadingSection?.nextStartPageNumber ?? null
    : reviewNavigationQuery.data?.toc[0]?.pageNumber ?? null;
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
      createdAt: bookmark.createdAt,
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

    const notedHighlightIds = new Set(
      (reviewNavigationQuery.data?.notes ?? [])
        .map((note) => note.highlightId)
        .filter((highlightId): highlightId is string => Boolean(highlightId))
    );
    const highlightItems: ReviewNavigationItem[] = (reviewNavigationQuery.data?.highlights ?? [])
      .filter((highlight) => !notedHighlightIds.has(highlight.highlightId))
      .map((highlight: ReaderHighlight) => ({
        color: highlight.color,
        excerpt: highlightPreview(highlight),
        highlightId: highlight.highlightId,
        isActive: highlight.pageNumber === reviewPageNumber,
        key: `highlight:${highlight.highlightId}`,
        pageNumber: highlight.pageNumber,
        paragraphNumber: highlight.paragraphNumber,
        type: "highlight"
      }));

    const sortWeight = { bookmark: 1, highlight: 2, note: 3, toc: 0 } as const;

    return [...tocItems, ...bookmarkItems, ...highlightItems, ...noteItems].sort((left, right) => {
      if (left.pageNumber !== right.pageNumber) {
        return left.pageNumber - right.pageNumber;
      }

      if (left.paragraphNumber !== right.paragraphNumber) {
        return left.paragraphNumber - right.paragraphNumber;
      }

      return sortWeight[left.type] - sortWeight[right.type];
    });
  }, [activeTocEntryKey, reviewNavigationQuery.data?.bookmarks, reviewNavigationQuery.data?.highlights, reviewNavigationQuery.data?.notes, reviewNavigationQuery.data?.toc, reviewPageNumber]);
  const reviewIndexItems = orderedNavigationItems.filter(
    (item): item is Extract<ReviewNavigationItem, { type: "bookmark" | "toc" }> => item.type === "toc" || item.type === "bookmark"
  );
  const reviewNoteItems = orderedNavigationItems.filter(
    (item): item is Extract<ReviewNavigationItem, { type: "highlight" | "note" }> => item.type === "note" || item.type === "highlight"
  );


  useEffect(() => {
    if (!isReviewIndexVisible) {
      return;
    }

    activeReviewNavItemRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTocEntryKey, isReviewIndexVisible, reviewNavigationTab, reviewPageNumber]);

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
                aria-label="Volver a la edición"
                className="secondary-button reader-header-icon-button"
                onClick={handleBackFromAppend}
                title="Volver a la edición"
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
              <article
                className={isCreateDragging ? "builder-form-card builder-form-card-dragging" : "builder-form-card"}
                onDragEnter={handleCreateDragEnter}
                onDragLeave={handleCreateDragLeave}
                onDragOver={handleCreateDragOver}
                onDrop={handleCreateDrop}
              >
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

                  <label>
                    Idioma
                    <select
                      onChange={(event) => setCreateForm((current) => ({ ...current, languageCode: event.target.value as BookLanguageCode }))}
                      value={createForm.languageCode}
                    >
                      {BOOK_LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
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
                  <p className="helper-text">También puedes arrastrar imágenes hasta aquí o pegarlas con Ctrl + V.</p>
                  {isCreateDragging ? <p className="helper-text builder-drop-hint" role="status">Suelta las imágenes para añadirlas.</p> : null}

                  <input
                    accept="image/*"
                    capture="environment"
                    className="capture-action-input-hidden"
                    onChange={handleCreateFileSelection}
                    ref={createCameraInputRef}
                    type="file"
                  />

                  <label style={{ alignItems: "center", display: "flex", flexDirection: "row", gap: "0.5rem" }}>
                    <input
                      checked={shouldAdjustCreateBorders}
                      disabled={isCreating}
                      onChange={(event) => setShouldAdjustCreateBorders(event.target.checked)}
                      style={{ height: "1.1rem", width: "1.1rem" }}
                      type="checkbox"
                    />
                    Ajustar bordes de la página
                  </label>

                  <div className="selected-book-banner append-ocr-banner">
                    <span>Modo OCR</span>
                    <div className="ocr-prompt-trigger-anchor">
                      <div className="ocr-prompt-trigger-group">
                        <div className="append-placement-picker" role="radiogroup" aria-label="Modo OCR para crear el libro">
                          <button
                            aria-checked={createOcrMode === "TEXTRACT"}
                            className={createOcrMode === "TEXTRACT" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isCreating}
                            onClick={() => setCreateOcrMode("TEXTRACT")}
                            role="radio"
                            type="button"
                          >
                            IA: AWS Textract
                          </button>
                          <button
                            aria-checked={createOcrMode === "VISION"}
                            className={createOcrMode === "VISION" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isCreating}
                            onClick={() => setCreateOcrMode("VISION")}
                            role="radio"
                            type="button"
                          >
                            IA: {createSelection.selectedModel.name}
                          </button>
                          <button
                            aria-checked={createOcrMode === "LOCAL"}
                            className={createOcrMode === "LOCAL" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isCreating}
                            onClick={() => { setCreateOcrMode("LOCAL"); setCreateAdvancedLayout(false); }}
                            role="radio"
                            type="button"
                          >
                            Sin IA: tesseract.js
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
                      <AdvancedLayoutCheckbox value={createAdvancedLayout} onChange={setCreateAdvancedLayout} mode={createOcrMode} disabled={isCreating} modelLabel={createSelection.selectedModel.name} />
                      <OcrModelSelect
                        disabled={isCreating}
                        models={createSelection.models}
                        compatibilityMessage={createSelection.compatibilityMessage}
                        onChange={createSelection.setSelectedModelId}
                        value={createSelection.selectedModelId}
                      />
                      {createOcrMode === "TEXTRACT" ? (
                        <div className="append-placement-cost-row">
                          <AwsCostBadge accessToken={accessToken} hasAwsCredentials={hasAwsCredentials} />
                        </div>
                      ) : null}
                      {(createOcrMode === "VISION" && isCreatePromptEditorOpen || createOcrMode === "TEXTRACT" && createAdvancedLayout) ? (
                        <OcrPromptEditor
                          disabled={isCreating}
                          helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para crear este libro. Si lo restableces, vuelve al mensaje user por defecto."
                          onChange={setCreatePromptOverride}
                          onReset={() => setCreatePromptOverride(defaultVisionOcrEditablePrompt)}
                          value={createPromptOverride}
                        />
                      ) : null}
                    </div>
                    {createOcrMode === "VISION" ? (
                      <span className="ai-model-badge ai-model-badge-compact">IA: modelo: {createSelection.selectedModel.name}. De pago.</span>
                    ) : createOcrMode === "TEXTRACT" ? (
                      <span className="ai-model-badge ai-model-badge-compact">IA: modelo: AWS Textract. De pago.</span>
                    ) : (
                      <span className="ai-model-badge ai-model-badge-compact">Sin IA: tesseract.js. Gratuito.</span>
                    )}
                  </div>

                  {selectedCreateFiles.length > 0 ? (
                    <div className="file-pill-list file-pill-list-append">
                      {selectedCreateFiles.map((file, index) => (
                        <span className="file-pill file-pill-removable" key={`${file.name}-${index}`}>
                          <span>{`${index + 1}. ${file.name}`}</span>
                          <button
                            aria-label={`Subir ${file.name}`}
                            className="file-pill-remove"
                            disabled={isCreating || index === 0}
                            onClick={() => moveCreateFile(index, -1)}
                            title="Subir en el orden"
                            type="button"
                          >
                            ↑
                          </button>
                          <button
                            aria-label={`Bajar ${file.name}`}
                            className="file-pill-remove"
                            disabled={isCreating || index === selectedCreateFiles.length - 1}
                            onClick={() => moveCreateFile(index, 1)}
                            title="Bajar en el orden"
                            type="button"
                          >
                            ↓
                          </button>
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
                  {selectedCreateFiles.length > 1 ? (
                    <p className="helper-text">Se ordenan por nombre al seleccionarlas. Usa ↑ ↓ para cambiar el orden de las páginas.</p>
                  ) : null}

                  {selectedCreateFiles.length > 0 ? (
                    <button className="secondary-button" disabled={isCreating} onClick={clearCreateSelection} type="button">
                      Limpiar selección
                    </button>
                  ) : null}

                  {createError ? <p className="error-text">{createError}</p> : null}
                  {createError ? <AiMissingBanner error={new Error(createError)} /> : null}
                  {isCreating && ocrRetryState?.context === "create" ? (
                    <p aria-live="polite" className="helper-text ocr-waiting-text">{buildOcrRetryCountdownLabel(ocrRetryState.secondsRemaining, ocrRetryState.reason)}</p>
                  ) : null}

                  <button className="primary-button" disabled={isCreating || !createSelection.canRunOcr(createOcrMode, createAdvancedLayout)} type="submit">
                    {isCreating ? "Procesando OCR..." : "Crear libro desde imágenes"}
                  </button>
                </form>
              </article>
            ) : null}

            {isAppendOnlyMode ? (
              <article
                className={isAppendDragging ? "builder-form-card builder-form-card-append builder-form-card-dragging" : "builder-form-card builder-form-card-append"}
                onDragEnter={handleAppendDragEnter}
                onDragLeave={handleAppendDragLeave}
                onDragOver={handleAppendDragOver}
                onDrop={handleAppendDrop}
              >
                <form className="stack-form" id="append-pages" onSubmit={handleAppendImages}>
                  {selectedAppendBook && appendReferencePageNumber !== undefined ? (
                    <div className="selected-book-banner append-position-banner">
                      <span>Las páginas añadidas se procesarán en {getBookLanguageLabel(selectedAppendBook.languageCode)} y se insertarán</span>
                      <div className="append-placement-picker" role="radiogroup" aria-label="Posición respecto a la página actual">
                        <button
                          aria-checked={appendInsertionSide === "before"}
                          className={appendInsertionSide === "before" ? "append-placement-option active" : "append-placement-option"}
                          disabled={isAppending}
                          onClick={() => setAppendInsertionSide("before")}
                          role="radio"
                          type="button"
                        >
                          Antes
                        </button>
                        <button
                          aria-checked={appendInsertionSide === "after"}
                          className={appendInsertionSide === "after" ? "append-placement-option active" : "append-placement-option"}
                          disabled={isAppending}
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
                          disabled={isAppending}
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
                  <p className="helper-text">También puedes arrastrar imágenes hasta aquí o pegarlas con Ctrl + V.</p>
                  {isAppendDragging ? <p className="helper-text builder-drop-hint" role="status">Suelta las imágenes para añadirlas.</p> : null}

                  <input
                    accept="image/*"
                    capture="environment"
                    className="capture-action-input-hidden"
                    disabled={isAppending}
                    onChange={handleAppendFileSelection}
                    ref={appendCameraInputRef}
                    type="file"
                  />

                  <label style={{ alignItems: "center", display: "flex", flexDirection: "row", gap: "0.5rem" }}>
                    <input
                      checked={shouldAdjustAppendBorders}
                      disabled={isAppending}
                      onChange={(event) => setShouldAdjustAppendBorders(event.target.checked)}
                      style={{ height: "1.1rem", width: "1.1rem" }}
                      type="checkbox"
                    />
                    Ajustar bordes de la página
                  </label>

                  {selectedAppendFiles.length > 0 ? (
                    <div className="file-pill-list file-pill-list-append">
                      {selectedAppendFiles.map((file, index) => (
                        <span
                          className={[
                            "file-pill",
                            "file-pill-removable",
                            appendCompletedFileCount > index ? "file-pill-completed" : "",
                            isAppending && appendProgressStage === "ocr" && appendCurrentFileIndex === index ? "file-pill-processing" : "",
                            isAppending && appendProgressStage === "waiting" && appendCurrentFileIndex === index ? "file-pill-waiting" : "",
                            isAppending && appendCompletedFileCount <= index && appendCurrentFileIndex !== index ? "file-pill-pending" : ""
                          ].filter(Boolean).join(" ")}
                          key={`${file.name}-${index}`}
                        >
                          <span>{`${index + 1}. ${file.name}`}</span>
                          {appendCompletedFileCount > index ? (
                            <span className="file-pill-status file-pill-status-completed">Hecho</span>
                          ) : null}
                          {isAppending && appendProgressStage === "ocr" && appendCurrentFileIndex === index ? (
                            <span className="file-pill-status">OCR...</span>
                          ) : null}
                          {isAppending && appendProgressStage === "waiting" && appendCurrentFileIndex === index ? (
                            <span className="file-pill-status">Espera {appendImportProgress?.waitSecondsRemaining ?? 0} s</span>
                          ) : null}
                          <button
                            aria-label={`Subir ${file.name}`}
                            className="file-pill-remove"
                            disabled={isAppending || index <= appendCompletedFileCount}
                            onClick={() => moveAppendFile(index, -1)}
                            title="Subir en el orden"
                            type="button"
                          >
                            ↑
                          </button>
                          <button
                            aria-label={`Bajar ${file.name}`}
                            className="file-pill-remove"
                            disabled={isAppending || index < appendCompletedFileCount || index === selectedAppendFiles.length - 1}
                            onClick={() => moveAppendFile(index, 1)}
                            title="Bajar en el orden"
                            type="button"
                          >
                            ↓
                          </button>
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
                  {selectedAppendFiles.length > 1 ? (
                    <p className="helper-text">Se ordenan por nombre al seleccionarlas. Usa ↑ ↓ para cambiar el orden de las páginas.</p>
                  ) : null}

                  {appendResumeState && appendResumeState.completedFiles > 0 && !isAppending ? (
                    <p className="helper-text">
                      {`Ya están añadidas ${appendResumeState.completedFiles} de ${selectedAppendFiles.length} páginas. Al reintentar se continuará con las pendientes.`}
                    </p>
                  ) : null}

                  {isAppending && appendImportProgress?.stage === "saving" ? (
                    <p className="helper-text">OCR completado. Guardando páginas en el libro...</p>
                  ) : null}
                  {isAppending && appendImportProgress?.stage === "waiting" ? (
                    <p aria-live="polite" className="helper-text ocr-waiting-text">
                      {buildOcrRetryCountdownLabel(appendImportProgress.waitSecondsRemaining ?? 1, appendImportProgress.waitReason ?? "rate-limit")}
                    </p>
                  ) : null}
                  {isAppending && appendImportProgress?.stage === "cancelling" ? (
                    <p className="helper-text">Cancelación solicitada. Se detendrá al terminar la página actual.</p>
                  ) : null}

                  <div className="selected-book-banner append-ocr-banner">
                    <span>Modo OCR</span>
                    <div className="ocr-prompt-trigger-anchor">
                      <div className="ocr-prompt-trigger-group">
                        <div className="append-placement-picker" role="radiogroup" aria-label="Modo OCR">
                          <button
                            aria-checked={appendOcrMode === "TEXTRACT"}
                            className={appendOcrMode === "TEXTRACT" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isAppending}
                            onClick={() => setAppendOcrMode("TEXTRACT")}
                            role="radio"
                            type="button"
                          >
                            IA: AWS Textract
                          </button>
                          <button
                            aria-checked={appendOcrMode === "VISION"}
                            className={appendOcrMode === "VISION" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isAppending}
                            onClick={() => setAppendOcrMode("VISION")}
                            role="radio"
                            type="button"
                          >
                            IA: {appendSelection.selectedModel.name}
                          </button>
                          <button
                            aria-checked={appendOcrMode === "LOCAL"}
                            className={appendOcrMode === "LOCAL" ? "append-placement-option active" : "append-placement-option"}
                            disabled={isAppending}
                            onClick={() => { setAppendOcrMode("LOCAL"); setAppendAdvancedLayout(false); }}
                            role="radio"
                            type="button"
                          >
                            Sin IA: tesseract.js
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
                      <AdvancedLayoutCheckbox value={appendAdvancedLayout} onChange={setAppendAdvancedLayout} mode={appendOcrMode} disabled={isAppending} modelLabel={appendSelection.selectedModel.name} />
                      <OcrModelSelect
                        disabled={isAppending}
                        models={appendSelection.models}
                        compatibilityMessage={appendSelection.compatibilityMessage}
                        onChange={appendSelection.setSelectedModelId}
                        value={appendSelection.selectedModelId}
                      />
                      {appendOcrMode === "TEXTRACT" ? (
                        <div className="append-placement-cost-row">
                          <AwsCostBadge accessToken={accessToken} hasAwsCredentials={hasAwsCredentials} />
                        </div>
                      ) : null}
                      {(appendOcrMode === "VISION" && isAppendPromptEditorOpen || appendOcrMode === "TEXTRACT" && appendAdvancedLayout) ? (
                        <OcrPromptEditor
                          disabled={isAppending}
                          helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para añadir estas páginas. Si lo restableces, vuelve al mensaje user por defecto."
                          onChange={setAppendPromptOverride}
                          onReset={() => setAppendPromptOverride(defaultVisionOcrEditablePrompt)}
                          value={appendPromptOverride}
                        />
                      ) : null}
                    </div>
                    {appendOcrMode === "VISION" ? (
                      <span className="ai-model-badge ai-model-badge-compact">IA: modelo: {appendSelection.selectedModel.name}. De pago.</span>
                    ) : appendOcrMode === "TEXTRACT" ? (
                      <span className="ai-model-badge ai-model-badge-compact">IA: modelo: AWS Textract. De pago.</span>
                    ) : (
                      <span className="ai-model-badge ai-model-badge-compact">Sin IA: tesseract.js. Gratuito.</span>
                    )}
                  </div>

                  {appendError ? <p className="error-text">{appendError}</p> : null}
                  {appendError ? <AiMissingBanner error={new Error(appendError)} /> : null}
                  {!appendError && appendImportProgress?.stage === "failed" && appendImportProgress.errorMessage ? (
                    <p className="error-text">{appendImportProgress.errorMessage}</p>
                  ) : null}
                  {!appendError && appendImportProgress?.stage === "failed" && appendImportProgress.errorMessage ? (
                    <AiMissingBanner error={new Error(appendImportProgress.errorMessage)} />
                  ) : null}

                  <button className="secondary-button" disabled={isAppending || !appendSelection.canRunOcr(appendOcrMode, appendAdvancedLayout)} type="submit">
                    {isAppending ? "Procesando OCR..." : appendResumeState?.completedFiles ? "Continuar páginas pendientes" : "Añadir páginas"}
                  </button>
                </form>
              </article>
            ) : null}
          </div>

          {isAppending ? createPortal(
            <div className="append-ocr-lock-backdrop" role="presentation">
              <div aria-label="Añadiendo páginas" aria-modal="true" className="append-ocr-lock-dialog" role="dialog">
                <div className="append-ocr-lock-header">
                  <p className="eyebrow">OCR en curso</p>
                  <h3>Añadiendo páginas</h3>
                </div>
                <div className="append-ocr-lock-progress" aria-hidden="true">
                  <span style={{ width: `${appendProgressCompletedPercent}%` }} />
                </div>
                <p aria-live="polite" className="append-ocr-lock-status">
                  {appendImportProgress?.stage === "waiting"
                    ? buildOcrRetryCountdownLabel(appendImportProgress.waitSecondsRemaining ?? 1, appendImportProgress.waitReason ?? "rate-limit")
                    : appendImportProgress?.stage === "saving"
                      ? "Guardando la página reconocida..."
                      : appendImportProgress?.stage === "cancelling"
                        ? "Cancelación solicitada. Se detendrá al terminar la página actual."
                        : `Página ${Math.min(appendCompletedFileCount + 1, appendProgressTotalFiles)} de ${appendProgressTotalFiles}`}
                </p>
                <p className="append-ocr-lock-detail">
                  {appendCurrentFileIndex !== null ? selectedAppendFiles[appendCurrentFileIndex]?.name ?? "Procesando imagen" : "Terminando proceso"}
                </p>
                {appendOcrFailure ? (
                  <div className="append-ocr-failure-panel">
                    <p className="append-ocr-failure-title">
                      {`Error en página ${appendOcrFailure.pageIndex} de ${appendOcrFailure.totalPages}`}
                    </p>
                    <p className="append-ocr-failure-file">{appendOcrFailure.fileName}</p>
                    <p className="append-ocr-failure-message">{appendOcrFailure.message}</p>
                    <div className="append-ocr-failure-actions">
                      <button className="secondary-button" onClick={() => resolveAppendOcrFailure("retry")} type="button">
                        Reintentar OCR
                      </button>
                      <button className="primary-button" onClick={() => resolveAppendOcrFailure("skip")} type="button">
                        Añadir sin OCR
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="append-ocr-cancel-hold"
                    disabled={isAppendCancelRequested}
                    onPointerCancel={clearAppendCancelHold}
                    onPointerDown={beginAppendCancelHold}
                    onPointerLeave={clearAppendCancelHold}
                    onPointerUp={clearAppendCancelHold}
                    style={{ "--cancel-progress": appendCancelHoldProgress } as CSSProperties & Record<"--cancel-progress", number>}
                    type="button"
                  >
                    {isAppendCancelRequested ? "Cancelando..." : "Mantener 5 s para cancelar"}
                  </button>
                )}
              </div>
            </div>,
            document.body
          ) : null}

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

          {scannerRequest ? (
            <DocumentScannerModal
              files={scannerRequest.files}
              onCancel={() => setScannerRequest(null)}
              onComplete={handleScannerComplete}
            />
          ) : null}
        </section>
      ) : null}

      {isReviewOnlyMode ? (
      <>
      <section className="panel wide-panel review-ocr-panel" id="review-ocr" ref={reviewPanelRef}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">Edición</p>
            <h2>{selectedReviewBook?.title ?? "Cargando libro..."}</h2>
            {reviewActiveChapterTitle ? <p className="reader-chapter-title">{reviewActiveChapterTitle}</p> : null}
          </div>
        </div>

        {reviewableBooks.length === 0 ? (
          <div className="empty-state">
            <p>Todavía no hay libros PDF, EPUB o creados desde imágenes para revisar.</p>
          </div>
        ) : (
          <>
            {reviewPageQuery.isLoading ? <p className="subdued">Cargando página para revisión...</p> : null}
            {reviewPageQuery.isError ? <p className="error-text">No se pudo cargar la página seleccionada.</p> : null}

            <form id="ocr-review-form" onSubmit={handleSaveOcr} ref={reviewSwipeSurfaceRef}>
              {visualDocument && visualHistory && savedVisualDocument && reviewPageQuery.data?.page && reviewDraftVersionRef.current?.identity === reviewPageIdentity ? <VisualPageEditor
                key={reviewPageIdentity}
                doc={visualDocument} page={reviewPageQuery.data.page}
                savedDocument={savedVisualDocument}
                selectedId={selectedElementKey} onSelect={setSelectedElementKey}
                onChange={(document) => setVisualHistory((history) => history ? pushVisualHistory(history, document) : history)}
                sourceImage={reviewImageUrl} accessToken={accessToken} bookId={reviewBookId}
                disabled={Boolean(reviewBlockLoadError) || reviewPartialSave || isSavingReview || isRerunningOcr || isDeletingReviewPage || reviewPageQuery.isFetching}
                geometryDisabled={!reviewImageUrl || hasPendingReviewImageEdits || isReviewCropMode || isReviewImageLoading}
                canUndo={visualHistory.past.length > 0} canRedo={visualHistory.future.length > 0}
                onUndo={() => setVisualHistory((history) => history ? undoVisualHistory(history) : history)}
                onRedo={() => setVisualHistory((history) => history ? redoVisualHistory(history) : history)}
                onInteractionChange={setIsVisualEditorBusy}
                onAmplify={(image) => setSelectedViewerImage(image)}
                source={(visualSourceOverlay) => shouldShowReviewSourcePanel ? (
              <article className={isRerunningOcr ? "review-panel review-panel-processing" : "review-panel"}>
                <div className="source-panel-header">
                  <div>
                    <p className="page-label">{hasReviewImage ? "Imagen de trabajo" : "Contenido fuente"}</p>
                    {hasReviewImage ? (
                      <p className={hasPendingReviewImageEdits ? "helper-text review-image-rotation-status is-pending" : "helper-text review-image-rotation-status"}>
                        {isReviewCropMode
                          ? "Ajusta el marco con el ratón o con el dedo y aplica el recorte."
                          : isReviewImageLoading
                            ? "Cargando imagen de la página..."
                          : hasPendingReviewImageEdits
                            ? "Ajustes pendientes por guardar."
                            : "Imagen guardada."}
                      </p>
                    ) : null}
                  </div>

                  {hasReviewImage ? (
                    <div aria-label="Controles de imagen" className="review-image-rotation-controls" role="toolbar">
                      <button
                        aria-label="Girar 90° a la izquierda"
                        className="review-image-rotation-button"
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => rotateReviewImage(-1)}
                        title="Girar 90° a la izquierda"
                        type="button"
                      >
                        <RotateLeftIcon />
                      </button>
                      <button
                        aria-label="Girar 90° a la derecha"
                        className="review-image-rotation-button"
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => rotateReviewImage(1)}
                        title="Girar 90° a la derecha"
                        type="button"
                      >
                        <RotateRightIcon />
                      </button>
                      <button
                        aria-label={isReviewCropMode ? "Cancelar recorte" : "Recortar"}
                        className={isReviewCropMode ? "review-image-rotation-button active" : "review-image-rotation-button"}
                        disabled={isSavingReview || !reviewBookId}
                        onClick={() => {
                          if (isReviewCropMode) {
                            cancelReviewCropMode();
                            return;
                          }

                          beginReviewCropMode();
                        }}
                        title={isReviewCropMode ? "Cancelar recorte" : "Recortar"}
                        type="button"
                      >
                        <CropIcon />
                      </button>
                      <button
                        aria-label="Restablecer ajustes de la imagen"
                        className="review-image-rotation-button"
                        disabled={isSavingReview || (!hasPendingReviewImageEdits && !isReviewCropMode)}
                        onClick={resetReviewImageAdjustments}
                        title="Restablecer"
                        type="button"
                      >
                        <ResetIcon />
                      </button>
                      {isReviewCropMode ? (
                        <>
                          <button
                            aria-label="Cancelar recorte"
                            className="review-crop-action-button"
                            disabled={isSavingReview}
                            onClick={cancelReviewCropMode}
                            title="Cancelar recorte"
                            type="button"
                          >
                            <CloseIcon />
                          </button>
                          <button
                            aria-label="Aplicar recorte"
                            className="review-crop-action-button review-crop-action-button-primary"
                            disabled={isSavingReview}
                            onClick={applyReviewCropDraft}
                            title="Aplicar recorte"
                            type="button"
                          >
                            <CheckIcon />
                          </button>
                        </>
                      ) : null}
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
                            <div aria-hidden="true" className="review-crop-edge-bar review-crop-edge-bar-n" onPointerDown={(event) => startReviewCropDrag("n", event)} />
                            <div aria-hidden="true" className="review-crop-edge-bar review-crop-edge-bar-s" onPointerDown={(event) => startReviewCropDrag("s", event)} />
                            <div aria-hidden="true" className="review-crop-edge-bar review-crop-edge-bar-e" onPointerDown={(event) => startReviewCropDrag("e", event)} />
                            <div aria-hidden="true" className="review-crop-edge-bar review-crop-edge-bar-w" onPointerDown={(event) => startReviewCropDrag("w", event)} />
                            <button aria-label="Ajustar esquina superior izquierda" className="review-crop-handle review-crop-handle-nw" onPointerDown={(event) => startReviewCropDrag("nw", event)} type="button" />
                            <button aria-label="Ajustar esquina superior derecha" className="review-crop-handle review-crop-handle-ne" onPointerDown={(event) => startReviewCropDrag("ne", event)} type="button" />
                            <button aria-label="Ajustar esquina inferior derecha" className="review-crop-handle review-crop-handle-se" onPointerDown={(event) => startReviewCropDrag("se", event)} type="button" />
                            <button aria-label="Ajustar esquina inferior izquierda" className="review-crop-handle review-crop-handle-sw" onPointerDown={(event) => startReviewCropDrag("sw", event)} type="button" />
                            <button aria-label="Ajustar borde superior" className="review-crop-edge-handle review-crop-edge-handle-n" onPointerDown={(event) => startReviewCropDrag("n", event)} type="button" />
                            <button aria-label="Ajustar borde derecho" className="review-crop-edge-handle review-crop-edge-handle-e" onPointerDown={(event) => startReviewCropDrag("e", event)} type="button" />
                            <button aria-label="Ajustar borde inferior" className="review-crop-edge-handle review-crop-edge-handle-s" onPointerDown={(event) => startReviewCropDrag("s", event)} type="button" />
                            <button aria-label="Ajustar borde izquierdo" className="review-crop-edge-handle review-crop-edge-handle-w" onPointerDown={(event) => startReviewCropDrag("w", event)} type="button" />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="review-image-frame is-processing review-image-loading-frame" aria-live="polite">
                      <div className="review-image-loading-placeholder" />
                      <div className="review-image-processing-overlay">
                        <span className="review-processing-spinner" />
                        <div className="review-processing-copy">
                          <strong>Preparando imagen...</strong>
                          <span>Generando vista para recorte.</span>
                        </div>
                      </div>
                    </div>
                  )
                ) : (
                  reviewImageUrl ? (
                    <>
                      <div className={isRerunningOcr || isReviewImageLoading ? "review-image-frame is-processing" : "review-image-frame"}>
                        {visualSourceOverlay}
                      </div>
                      <button type="button" disabled={isRerunningOcr || isReviewImageLoading} onClick={() => setSelectedViewerImage({ src: reviewImageUrl, title: `Pagina ${reviewPageNumber}` })}>Ampliar original</button>
                      {hasPendingReviewImageEdits ? <p className="helper-text">Las zonas estan deshabilitadas y se borraran al guardar los ajustes de imagen.</p> : null}
                      {isRerunningOcr || isReviewImageLoading ? (
                        <div aria-live="polite" className="review-image-processing-banner">
                          <span className="review-processing-spinner" />
                          <div className="review-processing-copy">
                            <strong>{isReviewImageLoading ? "Cargando imagen..." : (ocrRetryState?.context === "review" ? (ocrRetryState.reason === "rate-limit" ? "Esperando cupo de OpenCode..." : "Esperando a OpenCode...") : "Reconociendo OCR...")}</strong>
                            {isReviewImageLoading ? <span>Actualizando vista de la página.</span> : null}
                            {!isReviewImageLoading && ocrRetryState?.context === "review" ? <span>{buildOcrRetryCountdownLabel(ocrRetryState.secondsRemaining, ocrRetryState.reason)}</span> : null}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : isReviewImageLoading ? (
                    <div className="review-image-frame is-processing review-image-loading-frame" aria-live="polite">
                      <div className="review-image-loading-placeholder" />
                      <div className="review-image-processing-overlay">
                        <span className="review-processing-spinner" />
                        <div className="review-processing-copy">
                          <strong>Cargando imagen...</strong>
                          <span>Actualizando vista de la página.</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-state compact-state">
                      <p>No hay imagen asociada a esta página.</p>
                    </div>
                  )
                )}
                {reviewError ? <p aria-live="assertive" className="error-text review-image-error">{reviewError}</p> : null}
                {reviewError ? <AiMissingBanner error={new Error(reviewError)} /> : null}
              </article>
              ) : null} /> : null}
              {reviewBlockLoadError ? <p role="alert" className="error-text">{reviewBlockLoadError} La edicion y el guardado estan bloqueados para conservar el contenido.{canRerunReviewOcr && !reviewPartialSave && !reviewDraftConflict ? " Puedes volver a ejecutar el OCR desde su menu." : ""}</p> : null}
              {reviewDraftConflict ? <p aria-live="assertive" className="error-text">La pagina ha cambiado en el servidor. Se conserva tu borrador sin sobrescribirlo.</p> : null}
              {reviewDraftConflict || reviewPartialSave ? <button type="button" disabled={isSavingReview || isRerunningOcr} onClick={async () => { if (!(await confirmDiscardReviewChanges())) return; reviewDraftVersionRef.current = null; reviewDraftDirtyRef.current = false; await reviewPageQuery.refetch(); }}>Descartar borrador y cargar version remota</button> : null}
              {reviewError && !shouldShowReviewSourcePanel ? <p role="alert" className="error-text">{reviewError}</p> : null}
              {reviewMessage ? <p className="success-text">{reviewMessage}</p> : null}
            </form>
          </>
        )}
      </section>
      {reviewableBooks.length > 0 ? (
        <>
          {isReviewIndexVisible ? (
            <aside aria-label={`Índice de páginas para ${reviewEditorKindLabel}`} className="reader-navigation-panel" ref={reviewIndexPanelRef} role="dialog">
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
                <div aria-label="Contenido de navegación" className="reader-navigation-tabs" role="tablist">
                  <button
                    aria-controls="review-navigation-index-panel"
                    aria-selected={reviewNavigationTab === "index"}
                    className={reviewNavigationTab === "index" ? "reader-navigation-tab active" : "reader-navigation-tab"}
                    id="review-navigation-index-tab"
                    onClick={() => setReviewNavigationTab("index")}
                    role="tab"
                    type="button"
                  >
                    <span>Índice</span>
                    <span className="reader-navigation-tab-count">{reviewIndexItems.length}</span>
                  </button>
                  <button
                    aria-controls="review-navigation-notes-panel"
                    aria-selected={reviewNavigationTab === "notes"}
                    className={reviewNavigationTab === "notes" ? "reader-navigation-tab active" : "reader-navigation-tab"}
                    id="review-navigation-notes-tab"
                    onClick={() => setReviewNavigationTab("notes")}
                    role="tab"
                    type="button"
                  >
                    <span>Notas</span>
                    <span className="reader-navigation-tab-count">{reviewNoteItems.length}</span>
                  </button>
                </div>

                {reviewNavigationTab === "index" ? (
                  <div aria-labelledby="review-navigation-index-tab" className="reader-navigation-tab-panel" id="review-navigation-index-panel" role="tabpanel">
                    <div className="reader-navigation-section-heading">
                      <div className="reader-navigation-section-heading-copy">
                        <strong>Índice del libro</strong>
                      </div>
                      <span>{orderedNavigationItems.filter((item) => item.type === "toc").length}</span>
                    </div>
                    {reviewIndexItems.length ? (
                      <div className="reader-navigation-list">
                        {reviewIndexItems.map((item) => item.type === "bookmark" ? (
                          <article className={item.isActive ? "reader-note-card reader-navigation-item-bookmark-card active" : "reader-note-card reader-navigation-item-bookmark-card"} key={item.key}>
                            <button
                              className="reader-navigation-item reader-navigation-item-bookmark"
                              onClick={() => jumpToReviewPage(item.pageNumber)}
                              ref={item.isActive ? (element) => { activeReviewNavItemRef.current = element; } : undefined}
                              type="button"
                            >
                              <div className="reader-navigation-item-topline">
                                <span className={`reader-navigation-chip reader-navigation-chip-bookmark ${bookmarkToneClassName(item.bookmarkId)}`}>■</span>
                                <strong className="reader-navigation-title">
                                  {item.title}
                                  <span className="reader-navigation-page-badge">{formatPageAnchor(item.pageNumber)}</span>
                                </strong>
                              </div>
                              {item.createdAt ? (
                                <div className="reader-navigation-item-subline">
                                  <span
                                    className="reader-navigation-inline-meta"
                                    title={formatExactDate(item.createdAt) ? `Guardado el ${formatExactDate(item.createdAt)}` : undefined}
                                  >
                                    {formatRelativeDate(item.createdAt)}
                                  </span>
                                </div>
                              ) : null}
                            </button>
                          </article>
                        ) : (
                          <article className={item.isActive ? "reader-navigation-item-toc-card active" : "reader-navigation-item-toc-card"} key={item.key}>
                            <button
                              className={item.isActive ? "reader-navigation-item active" : "reader-navigation-item"}
                              data-level={item.level}
                              onClick={() => jumpToReviewPage(item.pageNumber)}
                              ref={item.isActive ? (element) => { activeReviewNavItemRef.current = element; } : undefined}
                              style={{ "--toc-level": String(Math.max(0, item.level - 1)) } as React.CSSProperties}
                              type="button"
                            >
                              <div className="reader-navigation-item-topline">
                                <strong className="reader-navigation-title">
                                  {item.title}
                                  <span className="reader-navigation-page-badge">{formatPageAnchor(item.pageNumber)}</span>
                                </strong>
                              </div>
                            </button>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="reader-navigation-empty">Este libro no tiene capítulos ni marcadores.</p>
                    )}
                  </div>
                ) : (
                  <div aria-labelledby="review-navigation-notes-tab" className="reader-navigation-tab-panel" id="review-navigation-notes-panel" role="tabpanel">
                    <div className="reader-navigation-section-heading">
                      <strong>Notas y resaltados</strong>
                      <span>{reviewNoteItems.length}</span>
                    </div>
                    {reviewNoteItems.length ? (
                      <div className="reader-navigation-list reader-navigation-notes-list">
                        {reviewNoteItems.map((item) => {
                          const colorClass = getPostItColorClass(item.color);
                          return (
                            <article
                              className={`reader-note-card reader-postit-card reader-navigation-item-note reader-navigation-note-entry ${colorClass} ${item.isActive ? "active" : ""}`}
                              key={item.key}
                            >
                              <div className="reader-postit-tape" />

                              {/* 1. TEXTO ARRIBA */}
                              <div className="reader-postit-note-text">
                                {item.type === "note" && item.noteText ? (
                                  <p>{item.noteText}</p>
                                ) : (
                                  <span className="reader-postit-highlight-title">
                                    {item.type === "highlight" ? "Resaltado" : "(Sin nota escrita)"}
                                  </span>
                                )}
                              </div>

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
                                  <span>{formatAnnotationAnchor(item.pageNumber, item.paragraphNumber, reviewNavigationQuery.data?.toc ?? [])}</span>
                                </div>
                              </div>

                              {/* 3. LOS BOTONES ABAJO */}
                              <div className="reader-postit-footer">
                                <button
                                  className="reader-postit-jump-btn"
                                  onClick={() => jumpToReviewPage(item.pageNumber)}
                                  ref={item.isActive ? (element) => { activeReviewNavItemRef.current = element; } : undefined}
                                  type="button"
                                  title="Ir a esta página"
                                >
                                  <span>Ir al texto</span>
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="reader-navigation-empty">Todavía no hay notas ni resaltados en este libro.</p>
                    )}
                  </div>
                )}
              </section>
            </aside>
          ) : null}

          <div aria-label={`Controles de edición ${reviewEditorKindLabel}`} className="review-floating-controls" role="toolbar">
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
                  {reviewNextChapterPageNumber !== null ? (
                    <span
                      aria-label={`Siguiente capítulo en la página ${reviewNextChapterPageNumber}`}
                      className="reader-next-chapter-page"
                      role="img"
                      title={`Siguiente capítulo · página ${reviewNextChapterPageNumber}`}
                    >
                      <span aria-hidden="true">→</span>
                      <strong aria-hidden="true">{reviewNextChapterPageNumber}</strong>
                    </span>
                  ) : null}
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

            {canRerunReviewOcr ? (
            <div className="review-floating-ocr-menu">
              {isReviewOcrMenuVisible ? (
                <div aria-label="Opciones de OCR" className="review-floating-ocr-panel" ref={reviewOcrPanelRef} role="dialog">
                  <p className="review-floating-ocr-title">Volver a reconocer con</p>
                  <label>
                    <span>Modo OCR</span>
                    <select value={reviewOcrMode} disabled={isSavingReview || !reviewBookId || isReviewCropMode} onChange={(event) => {
                      const mode = event.target.value as ImageOcrMode;
                      setReviewOcrMode(mode);
                      if (mode === "LOCAL") setReviewAdvancedLayout(false);
                    }}>
                      <option value="TEXTRACT">AWS Textract</option>
                      <option value="VISION">Vision</option>
                      <option value="LOCAL">LOCAL: tesseract.js</option>
                    </select>
                  </label>
                  <AdvancedLayoutCheckbox value={reviewAdvancedLayout} onChange={setReviewAdvancedLayout} mode={reviewOcrMode} disabled={isSavingReview || !reviewBookId || isReviewCropMode} modelLabel={reviewOcrModelLabel} />
                  <OcrModelSelect
                    disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                    models={ocrModelOptions}
                    compatibilityMessage={compatibilityMessage}
                    onChange={setOcrModelOverride}
                    value={selectedOcrModel}
                  />
                  <div className="review-ocr-option-stack">
                    {reviewOcrMode === "TEXTRACT" ? (
                      <div className="review-ocr-option-row">
                        <button
                          className="review-ocr-option active"
                          disabled={isSavingReview || !reviewBookId || isReviewCropMode || !canRunOcr("TEXTRACT", reviewAdvancedLayout)}
                          onClick={() => void handleRerunOcr("TEXTRACT")}
                          type="button"
                        >
                          <strong>IA: AWS Textract</strong>
                          <ul className="review-ocr-option-list">
                            <li>De pago.</li>
                            <li>Gasto de este mes: {awsTextractCostLabel}</li>
                          </ul>
                        </button>
                      </div>
                    ) : null}
                    {reviewOcrMode === "VISION" ? (
                      <div className="review-ocr-option-row">
                        <button
                          className="review-ocr-option active"
                          disabled={isSavingReview || !reviewBookId || isReviewCropMode || !canRunOcr("VISION", reviewAdvancedLayout)}
                          onClick={() => void handleRerunOcr("VISION", reviewPromptOverride)}
                          type="button"
                        >
                          <strong>IA: {reviewOcrModelLabel}</strong>
                          <ul className="review-ocr-option-list">
                            <li>{selectedOcrModelOption?.pricing ?? "De pago."}</li>
                          </ul>
                        </button>
                        <button
                          aria-expanded={isReviewPromptEditorOpen}
                          aria-label={`Editar prompt de ${reviewOcrModelLabel}`}
                          className={isReviewPromptEditorOpen ? "ocr-prompt-toggle active" : "ocr-prompt-toggle"}
                          disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                          onClick={() => setIsReviewPromptEditorOpen((current) => !current)}
                          title={`Editar prompt de ${reviewOcrModelLabel}`}
                          type="button"
                        >
                          <PromptIcon />
                        </button>
                      </div>
                    ) : null}
                    {(reviewOcrMode === "VISION" && isReviewPromptEditorOpen || reviewOcrMode === "TEXTRACT" && reviewAdvancedLayout) ? (
                      <OcrPromptEditor
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        helperText="El mensaje system del OCR con IA es fijo. Este campo solo modifica el mensaje user para volver a reconocer esta página. Si lo restableces, vuelve al mensaje user por defecto."
                        onChange={setReviewPromptOverride}
                        onReset={() => setReviewPromptOverride(defaultVisionOcrEditablePrompt)}
                        value={reviewPromptOverride}
                      />
                    ) : null}
                    {reviewOcrMode === "LOCAL" ? (
                      <button
                        className="review-ocr-option active"
                        disabled={isSavingReview || !reviewBookId || isReviewCropMode}
                        onClick={() => void handleRerunOcr("LOCAL")}
                        type="button"
                      >
                        <strong>Sin IA: tesseract.js</strong>
                        <ul className="review-ocr-option-list">
                          <li>Gratuito.</li>
                        </ul>
                      </button>
                    ) : null}
                  </div>
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
                ref={reviewOcrToggleRef}
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
               disabled={isSavingReview || isDeletingReviewPage || !reviewBookId || !visualDocument || !isReviewDirty || isReviewCropMode || isVisualEditorBusy || reviewDraftConflict || reviewPartialSave || Boolean(reviewBlockLoadError)}
              form="ocr-review-form"
              title={isSavingReview ? "Guardando cambios..." : (!isReviewDirty ? "Sin cambios para guardar" : "Guardar cambios")}
              type="submit"
            >
              <SaveOcrIcon />
            </button>
          </div>
          {reviewOcrToast ? (
            <div className="reader-toast review-ocr-toast" role="status">
              {reviewOcrToast}
            </div>
          ) : null}
          <div
            className={isFloatingReviewHeaderExpanded ? "reader-header-floating-dock open" : "reader-header-floating-dock"}
            ref={floatingReviewHeaderRef}
            style={floatingReviewHeaderDockStyle ?? undefined}
          >
            <div className="reader-header-floating-primary-actions">
              <button
                aria-label="Volver al lector"
                className="secondary-button link-button reader-header-icon-button reader-header-floating-action-button"
                onClick={handleBackFromReview}
                title="Volver al lector"
                type="button"
              >
                <BackIcon />
              </button>
            </div>
            {(reviewAppendPagesLink || canDeleteReviewPage) ? (
              <div className="reader-header-floating-menu">
                <button
                  aria-expanded={isFloatingReviewHeaderExpanded}
                  aria-label={isFloatingReviewHeaderExpanded ? "Cerrar acciones de edición" : "Abrir acciones de edición"}
                  className="reader-header-floating-toggle"
                  onClick={() => setIsFloatingReviewHeaderExpanded((current) => !current)}
                  title={isFloatingReviewHeaderExpanded ? "Cerrar acciones" : "Abrir acciones"}
                  type="button"
                >
                  {isFloatingReviewHeaderExpanded ? <CloseIcon /> : <ActionsMenuIcon />}
                </button>
                <div className={isFloatingReviewHeaderExpanded ? "reader-header-floating-dock-panel open" : "reader-header-floating-dock-panel"}>
                  {reviewAppendPagesLink ? (
                    <Link
                      aria-label="Añadir páginas"
                      className="secondary-button link-button reader-header-icon-button reader-header-floating-action-button"
                      onClick={() => setIsFloatingReviewHeaderExpanded(false)}
                      title="Añadir páginas"
                      to={reviewAppendPagesLink}
                    >
                      <AddPagesIcon />
                    </Link>
                  ) : null}
                  {canDeleteReviewPage ? (
                    <button
                      aria-label={isDeletingReviewPage ? "Borrando página" : "Borrar página"}
                      className="danger-button reader-header-icon-button reader-header-floating-action-button"
                      disabled={isDeletingReviewPage || isSavingReview || !reviewBookId || isReviewCropMode}
                      onClick={() => {
                        setIsFloatingReviewHeaderExpanded(false);
                        void handleDeleteReviewPage();
                      }}
                      title={isDeletingReviewPage ? "Borrando página..." : "Borrar página"}
                      type="button"
                    >
                      <DeletePageIcon />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      </>
      ) : null}

      <ImageViewerModal
        alt={selectedViewerImage?.alt}
        isOpen={Boolean(selectedViewerImage)}
        onClose={() => setSelectedViewerImage(null)}
        src={selectedViewerImage?.src ?? ""}
        title={selectedViewerImage?.title}
      />
    </div>
  );
}
