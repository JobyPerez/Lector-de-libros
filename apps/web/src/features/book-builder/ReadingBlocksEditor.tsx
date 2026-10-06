import { type MutableRefObject, useRef, useState } from "react";
import { useBookContentImageHtml } from "../../hooks/useBookContentImageHtml";
import { buildOcrPreviewHtml } from "./ocr-preview";
import type { PageElementRole, ParagraphElementMetadata } from "../../app/api";
import { editReadingBlock, explicitReadingBlocks, joinReadingBlocks, normalizeReadingRows, paragraphLines, readingElements, readingMetadata, splitReadingBlock, type ReadingBlock } from "./reading-blocks";
import { ReadAloudSwitch } from "./ReadAloudSwitch";
import "./reading-blocks.css";

function BlockPreview({ block, accessToken, bookId }: { block: ReadingBlock; accessToken: string | null; bookId: string }) {
  const html = useBookContentImageHtml(buildOcrPreviewHtml(block.text), accessToken, bookId);
  return html ? <div className="reader-prose reader-rich-content reading-block-preview" dangerouslySetInnerHTML={{ __html: html }} /> : null;
}

export function ReadingBlocksEditor({ blocks, onChange, editorRef, onSelection, disabled, accessToken, bookId, selectedElementKey, onElementSelect, onMarkGeometry, geometryDisabled }: {
  blocks: ReadingBlock[];
  onChange: (blocks: ReadingBlock[]) => void;
  editorRef: MutableRefObject<HTMLTextAreaElement | null>;
  onSelection: (start: number, end: number, text: string) => void;
  disabled: boolean;
  accessToken: string | null;
  bookId: string;
  selectedElementKey?: string | null;
  onElementSelect?: (key: string) => void;
  onMarkGeometry?: ((key: string) => void) | undefined;
  geometryDisabled?: boolean;
}) {
  const editors = useRef(new Map<number, HTMLTextAreaElement>());
  const [announcement, setAnnouncement] = useState("");
  const elements = readingElements(blocks);
  function updateMetadata(blockIndex: number, lineIndex: number, patch: Partial<ParagraphElementMetadata>) {
    onChange(blocks.map((block, index) => index === blockIndex ? { ...block, paragraphMetadata: readingMetadata([block]).map((metadata, position) => position === lineIndex ? { ...metadata, ...patch } : metadata) } : block));
  }
  function commit(next: ReadingBlock[], message: string, focusIndex: number) {
    onChange(normalizeReadingRows(explicitReadingBlocks(next)));
    setAnnouncement(message);
    requestAnimationFrame(() => editors.current.get(focusIndex)?.focus());
  }
  return <div className="reading-blocks-editor">
    <p className="page-label">Bloques de lectura</p>
    <p className="helper-text">{elements.length} elementos</p>
    <p className="helper-text">Cada linea no vacia es un parrafo. Para dividir, coloca el cursor al inicio del parrafo que abrira el siguiente bloque. La barra de formato actua sobre el bloque activo. Marca Junto al anterior para compartir fila; desmarca para separar en vertical.</p>
    <p aria-live="polite" className="reading-block-announcement">{announcement}</p>
    {blocks.map((block, index) => <section className="reading-block-card" key={block.id ?? "legacy"} aria-label={`Bloque ${index + 1}`}>
      <header><strong>Bloque {index + 1}</strong><div className="reading-block-actions">
        {([-1, 1] as const).map((direction) => <button type="button" key={direction} disabled={disabled || !blocks[index + direction]} aria-label={`${direction < 0 ? "Subir" : "Bajar"} bloque ${index + 1}`} onClick={() => {
          const next = [...blocks];
          [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
          commit(next, `Bloque movido a la posicion ${index + direction + 1}.`, index + direction);
        }}>{direction < 0 ? "Subir" : "Bajar"}</button>)}
        <button type="button" disabled={disabled} onClick={() => {
          const split = splitReadingBlock(block, editors.current.get(index)?.selectionStart ?? 0);
          if (!split) { setAnnouncement("Selecciona un parrafo posterior al primero para dividir."); return; }
          commit([...blocks.slice(0, index), ...split, ...blocks.slice(index + 1)], "Bloque dividido.", index + 1);
        }}>Dividir desde cursor</button>
        <button type="button" disabled={disabled || index === blocks.length - 1} onClick={() => {
          const following = blocks[index + 1]!;
           const merged = joinReadingBlocks(block, following);
          commit([...blocks.slice(0, index), merged, ...blocks.slice(index + 2)], "Bloques unidos.", index);
        }}>Unir siguiente</button>
        <button type="button" disabled={disabled || blocks.length === 1} onClick={() => {
          if (block.text.trim() && !window.confirm(`Eliminar el bloque ${index + 1} y todo su contenido? Esta accion se aplicara al guardar.`)) return;
          commit(blocks.filter((_, position) => position !== index), "Bloque eliminado.", Math.max(0, index - 1));
        }}>Eliminar</button>
      </div></header>
      <label className="reading-block-row-control"><input type="checkbox" disabled={disabled || index === 0}
        checked={index > 0 && Boolean(block.rowId) && block.rowId === blocks[index - 1]?.rowId}
        onChange={(event) => {
          const next = [...blocks];
          if (event.target.checked) {
            const previous = blocks[index - 1]!;
            const rowId = previous.rowId ?? crypto.randomUUID();
            next[index - 1] = { ...previous, rowId };
            next[index] = { ...block, rowId };
          } else {
            next[index] = { ...block };
            delete next[index]!.rowId;
          }
          commit(next, event.target.checked ? "Bloque junto al anterior." : "Bloque separado en vertical.", index);
        }} />Junto al anterior</label>
      <label><span className="page-label">Texto del bloque {index + 1}</span><textarea
        className="ocr-editor" rows={Math.max(4, Math.min(14, block.text.split("\n").length + 1))} disabled={disabled}
        data-reading-block-index={index}
        ref={(element) => { if (element) editors.current.set(index, element); else editors.current.delete(index); }}
        value={block.text}
        onFocus={(event) => { editorRef.current = event.currentTarget; onSelection(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, block.text); }}
        onSelect={(event) => {
          const start = event.currentTarget.selectionStart;
          onSelection(start, event.currentTarget.selectionEnd, block.text);
          const lineStart = block.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
          const lineIndex = paragraphLines(block.text.slice(0, lineStart)).length;
          const element = elements.find((item) => item.blockIndex === index && item.lineIndex === lineIndex);
          if (element) onElementSelect?.(element.key);
        }}
        onChange={(event) => onChange(blocks.map((item, position) => position === index ? editReadingBlock(item, event.target.value) : item))}
      /></label>
      <div onClick={(event) => {
        const target = event.target as HTMLElement;
        const number = Number(target.closest("[data-paragraph-number]")?.getAttribute("data-paragraph-number"));
        const element = elements.filter((item) => item.blockIndex === index)[number - 1];
        if (element) onElementSelect?.(element.key);
      }}><BlockPreview block={block} accessToken={accessToken} bookId={bookId} /></div>
      {elements.filter((element) => element.blockIndex === index).map((element) => <details key={element.key}
        className={`reading-element${selectedElementKey === element.key ? " is-selected" : ""}`}
        open={selectedElementKey === element.key}>
        <summary onClick={(event) => {
          if (onElementSelect) {
            event.preventDefault();
            onElementSelect(element.key);
          }
        }}>Elemento {elements.indexOf(element) + 1}: {element.text.slice(0, 100)}
          {!element.readAloud ? <span className="reading-element-status">No se lee</span> : null}</summary>
        <div className="reading-element-controls">
          <label>Tipo <select value={element.role} disabled={disabled} onChange={(event) => updateMetadata(index, element.lineIndex, { role: event.target.value as PageElementRole })}>
            {([["header", "Cabecera"], ["body", "Cuerpo"], ["heading", "Titulo"], ["image", "Imagen"], ["imageCaption", "Pie de imagen"], ["footer", "Pie de pagina"], ["pageNumber", "Numero de pagina"]] as const).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
          </select></label>
          <ReadAloudSwitch checked={element.readAloud} disabled={disabled} onChange={(readAloud) => updateMetadata(index, element.lineIndex, { readAloud })} />
          {onMarkGeometry && selectedElementKey === element.key ? <button type="button" disabled={disabled || geometryDisabled} onClick={() => onMarkGeometry(element.key)}>Marcar zona en original</button> : null}
        </div>
      </details>)}
    </section>)}
    <button type="button" disabled={disabled} className="secondary-button" onClick={() => commit([...blocks, { id: crypto.randomUUID(), text: "", paragraphIds: [] }], "Bloque anadido.", blocks.length)}>Anadir bloque</button>
  </div>;
}
