import { useEffect, useRef, useState } from "react";

import type { ReaderTocEntry } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { nextChapterBoundaryPage, readChapterBoundaryLevel, saveChapterBoundaryLevel } from "./chapter-boundary";

export function ReaderChapterBoundary({ bookId, toc, pageNumber, paragraphNumber, totalPages }: {
  bookId: string;
  toc: ReaderTocEntry[];
  pageNumber: number;
  paragraphNumber: number;
  totalPages: number;
}) {
  const userId = useAuthStore((state) => state.user?.userId) ?? "";
  const [level, setLevel] = useState(() => readChapterBoundaryLevel(bookId, userId));
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLevel(readChapterBoundaryLevel(bookId, userId));
    setIsOpen(false);
  }, [bookId, userId]);

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof window.Node && !containerRef.current?.contains(event.target)) setIsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  if (!toc.length || !totalPages) return null;
  const boundaryPage = nextChapterBoundaryPage(toc, pageNumber, paragraphNumber, level, totalPages);

  return <div
    className="reader-chapter-boundary"
    onKeyDown={(event) => {
      if (isOpen && ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)) event.stopPropagation();
    }}
    ref={containerRef}
  >
    <button
      aria-expanded={isOpen}
      aria-label={`Límite T${level} en la página ${boundaryPage}. Elegir nivel de capítulo`}
      className="reader-next-chapter-page"
      onClick={() => setIsOpen((current) => !current)}
      ref={buttonRef}
      title={`Límite T${level} · página ${boundaryPage}. Pulsar para elegir T1, T2 o T3`}
      type="button"
    >
      <span aria-hidden="true">→</span>
      <strong aria-hidden="true">{boundaryPage}</strong>
    </button>
    {isOpen ? <div aria-label="Nivel del límite de capítulo" className="reader-chapter-boundary-options" role="group">
      <span>Fin de capítulo</span>
      <div>
        {([1, 2, 3] as const).map((option) => <button
          aria-pressed={level === option}
          autoFocus={level === option}
          key={option}
          onClick={() => {
            setLevel(option);
            saveChapterBoundaryLevel(bookId, userId, option);
            setIsOpen(false);
            buttonRef.current?.focus();
          }}
          type="button"
        >T{option}</button>)}
      </div>
    </div> : null}
  </div>;
}
