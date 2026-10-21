import { useEffect, useRef } from "react";

export function CameraCaptureModeDialog({ onChoose, onCancel }: {
  onChoose: (multiple: boolean) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog className="panel pdf-download-dialog camera-mode-dialog" ref={dialogRef} aria-labelledby="camera-mode-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id="camera-mode-title">¿Una foto o varias?</h2>
      <p>Con varias fotos, la cámara seguirá lista para la siguiente página. Pulsa Terminar cuando hayas acabado.</p>
      <div className="import-panel-actions">
        <button className="primary-button" onClick={() => onChoose(false)} type="button">Una foto</button>
        <button className="primary-button" onClick={() => onChoose(true)} type="button">Varias fotos</button>
        <button className="secondary-button" onClick={onCancel} type="button">Cancelar</button>
      </div>
    </dialog>
  );
}
