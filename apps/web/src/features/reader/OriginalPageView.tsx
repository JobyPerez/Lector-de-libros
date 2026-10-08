import { useEffect, useState } from "react";
import { fetchBookPageImage } from "../../app/api";

export function OriginalPageView({ accessToken, bookId, pageNumber, pageId, updatedAt, onEnlarge }: {
  accessToken: string | null;
  bookId: string;
  pageNumber: number;
  pageId: string;
  updatedAt: string | null;
  onEnlarge: (image: { src: string; alt: string; title: string }) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    setSource(null);
    setError(null);
    if (accessToken && pageId) {
      void fetchBookPageImage(accessToken, bookId, pageNumber, updatedAt, true, pageId).then((blob) => {
        if (disposed) return;
        url = URL.createObjectURL(blob);
        setSource(url);
      }).catch(() => {
        if (!disposed) setError("No se pudo cargar la imagen original. Puedes continuar en la vista adaptable.");
      });
    }
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [accessToken, bookId, pageNumber, pageId, updatedAt]);

  const title = `Original de la pagina ${pageNumber}`;
  return <div className="reader-original-view">
    <p className="helper-text">Pulsa la imagen para ampliarla. La lectura en voz alta sigue el texto de la vista adaptable.</p>
    {error ? <p role="alert" className="error-text">{error}</p> : !source ? <p role="status">Cargando original...</p> : (
      <button type="button" className="reader-original-image" aria-label={`Ampliar original de la pagina ${pageNumber}`} onClick={() => onEnlarge({ src: source, alt: title, title })}>
        <img src={source} alt={title} />
      </button>
    )}
  </div>;
}
