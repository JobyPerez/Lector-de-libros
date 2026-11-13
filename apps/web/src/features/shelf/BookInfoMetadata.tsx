import { Link } from "react-router-dom";

import type { BookSummary } from "../../app/api";
import { getBookLanguageLabel } from "../../app/book-language";

const numberFormatter = new Intl.NumberFormat("es-ES");
const dateFormatter = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" });

function formatDate(value: string | null | undefined) {
  if (!value) return "Sin registrar";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Sin registrar" : dateFormatter.format(date);
}

export function formatBookReadingTime(wordCount: number) {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return "No disponible";
  // Misma estimación que el lector a velocidad normal: 155 palabras/minuto.
  const totalMinutes = Math.max(1, Math.round(wordCount / 155));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} h${minutes ? ` ${minutes} min` : ""}` : `${minutes} min`;
}

type BookInfoMetadataProps = {
  book: BookSummary;
  ratingLabel?: string | undefined;
  shelfReturnTo: string;
  onOpenNavigation: () => void;
};

export function BookInfoMetadata({ book, ratingLabel, shelfReturnTo, onOpenNavigation }: BookInfoMetadataProps) {
  return (
    <>
      <dl className="shelf-book-info-metadata">
        <div><dt>Formato:</dt><dd>{book.sourceType === "IMAGES" ? "Imágenes (OCR)" : book.sourceType}</dd></div>
        <div className="shelf-book-info-field-stacked">
          <dt>Título:</dt>
          <dd><h3 className="shelf-book-info-title">{book.title}</h3></dd>
        </div>
        <div className="shelf-book-info-field-stacked">
          <dt>Autor:</dt>
          <dd>
            <p className="shelf-book-info-author">{book.authorName?.trim() || "Autor pendiente"}</p>
            {book.currentUserRole && book.currentUserRole !== "OWNER" && book.ownerUsername ? (
              <p className="shelf-book-shared-by">Compartido por <strong>@{book.ownerUsername}</strong></p>
            ) : null}
          </dd>
        </div>
        <div><dt>Idioma:</dt><dd>{getBookLanguageLabel(book.languageCode)}</dd></div>
        <div><dt>Año de publicación:</dt><dd>{book.publicationYear ?? "Sin especificar"}</dd></div>
        <div>
          <dt>Calificación:</dt>
          <dd>
            {book.rating ? (
              <span aria-label={ratingLabel ?? `${book.rating} de 5`} className="shelf-book-rating-badge">
                <span aria-hidden="true" className="shelf-book-rating-stars">
                  {[1, 2, 3, 4, 5].map((star) => <span className={star <= (book.rating ?? 0) ? "star-active" : "star-inactive"} key={star}>★</span>)}
                </span>
                <span className="shelf-book-rating-text">{ratingLabel ?? `${book.rating}/5`}</span>
              </span>
            ) : "Sin calificar"}
          </dd>
        </div>
        <div><dt>Páginas:</dt><dd>{numberFormatter.format(book.totalPages)}</dd></div>
        <div><dt>Palabras:</dt><dd>{numberFormatter.format(book.totalWords)}</dd></div>
        <div><dt>Tiempo estimado de lectura:</dt><dd title="Estimación a 155 palabras por minuto">{formatBookReadingTime(book.totalWords)}</dd></div>
        <div><dt>Última lectura:</dt><dd>{formatDate(book.lastOpenedAt)}</dd></div>
        <div><dt>Fecha de lectura:</dt><dd>{formatDate(book.readingDate)}</dd></div>
      </dl>
      <Link
        className="shelf-book-info-navigation"
        onClick={onOpenNavigation}
        state={{ shelfAnchorBookId: book.bookId, shelfReturnTo }}
        to={`/books/${book.bookId}?panel=index-notes`}
      >
        Índice, notas y comentarios <span aria-hidden="true">→</span>
      </Link>
    </>
  );
}
