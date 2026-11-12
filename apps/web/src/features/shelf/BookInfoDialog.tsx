import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type BookInfoDialogProps = {
  title: string;
  origin: HTMLElement;
  cover: ReactNode;
  children: ReactNode;
  onClose: () => void;
};

export function BookInfoDialog({ title, origin, cover, children, onClose }: BookInfoDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef(document.activeElement);
  const closeRef = useRef(onClose);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const book = bookRef.current!;
    const previousFocus = previousFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    const source = origin.getBoundingClientRect();
    const target = book.getBoundingClientRect();
    book.style.setProperty("--book-offset-x", `${source.left + source.width / 2 - (target.left + target.width / 2)}px`);
    book.style.setProperty("--book-offset-y", `${source.top + source.height / 2 - (target.top + target.height / 2)}px`);
    book.style.setProperty("--book-scale-x", String(source.width / target.width));
    book.style.setProperty("--book-scale-y", String(source.height / target.height));
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [origin]);

  useLayoutEffect(() => {
    if (!closing) return;
    const timeout = window.setTimeout(() => closeRef.current(), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 560);
    return () => window.clearTimeout(timeout);
  }, [closing]);

  return createPortal(
    <dialog
      aria-label={`Información de ${title}`}
      className="shelf-book-info-dialog"
      data-closing={closing ? "true" : undefined}
      onCancel={(event) => { event.preventDefault(); setClosing(true); }}
      onClick={(event) => { if (event.target === event.currentTarget) setClosing(true); }}
      ref={dialogRef}
    >
      <div className="shelf-book-info-flight" ref={bookRef}>
        <div className="shelf-book-info-flipper">
          <div aria-hidden="true" className="shelf-book-info-front">{cover}</div>
          <div className="shelf-book-info-back">
            <header className="shelf-book-info-header">
              <span>Información del libro</span>
              <button aria-label="Cerrar información del libro" autoFocus className="shelf-book-info-close" onClick={() => setClosing(true)} type="button">✕</button>
            </header>
            <div className="shelf-book-info-content">{children}</div>
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  );
}
