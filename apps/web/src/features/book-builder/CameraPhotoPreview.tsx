import { useEffect, useState } from "react";

export function CameraPhotoPreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <div className="camera-photo-review">
      {url ? <img src={url} alt="Previsualización de la foto recién capturada" /> : null}
      <div className="camera-capture-flash" aria-hidden="true" />
    </div>
  );
}
