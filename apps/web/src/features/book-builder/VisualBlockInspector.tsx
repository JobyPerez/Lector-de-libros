import { useEffect, useRef, useState } from "react";
import type { PageElementRole, PageStyle, VisualBlock, VisualLayoutNode, VisualPageDocument } from "../../app/api";
import { flattenVisualLayout, moveVisualNode, reorderVisualBlock, safeVisualImageSource, ungroupVisualNode, updateVisualBlock, updateVisualNode, visualUnits, type VisualContainer } from "./visual-page";
import { ReadAloudSwitch } from "./ReadAloudSwitch";
import { AlignmentControl } from "./AlignmentControl";
import { FontScaleControl } from "./FontScaleControl";

export function VisualImageSourceFields({ block, images, onChange }: { block: VisualBlock; images: VisualBlock[]; onChange: (patch: Partial<VisualBlock>) => void }) {
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => readerRef.current?.abort(), []);
  const reusable = images.filter((image) => image.id !== block.id && image.kind === "image" && safeVisualImageSource(image.source));
  return <div className="visual-image-fields">
    <label>Fuente de imagen (HTTPS o referencia interna)
      <input aria-label="Fuente de imagen" value={block.source ?? ""} onChange={(event) => onChange({ source: event.target.value })} />
    </label>
    {block.source === "page-crop" ? <p>Recorte de la zona seleccionada. Se resolvera al guardar; la preview local no se persiste.</p> : null}
    {block.source && block.source !== "page-crop" && !safeVisualImageSource(block.source) ? <p role="alert">Usa HTTPS, una referencia interna o una imagen subida.</p> : null}
    {reusable.length ? <label>Reutilizar imagen existente
      <select value="" onChange={(event) => { const image = reusable[Number(event.target.value)]; if (image) onChange({ source: image.source! }); }}>
        <option value="" disabled>Elegir imagen...</option>
        {reusable.map((image, index) => <option key={image.id} value={index}>{image.text.slice(0, 60) || `Imagen ${index + 1}`}</option>)}
      </select>
    </label> : null}
    <button type="button" onClick={() => uploadRef.current?.click()}>Subir imagen pequena</button>
    <input ref={uploadRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setError(null);
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1024 * 1024) { setError("Usa PNG, JPG o WEBP de hasta 1 MB incluyendo la codificacion."); return; }
      readerRef.current?.abort();
      const reader = new FileReader();
      readerRef.current = reader;
      reader.onload = () => {
        const source = String(reader.result);
        if (source.length > 1024 * 1024) { setError("La imagen codificada supera 1 MB. Reduce su tamano antes de subirla."); return; }
        onChangeRef.current({ source });
      };
      reader.onerror = () => setError("No se pudo leer la imagen.");
      reader.readAsDataURL(file);
    }} />
    <p className="helper-text">Limite: 1 MB por imagen incluyendo data URL. No se sube hasta Guardar cambios.</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
  </div>;
}

const roles: { value: PageElementRole; label: string }[] = [
  { value: "body", label: "Cuerpo" }, { value: "heading", label: "Titulo" }, { value: "image", label: "Imagen" },
  { value: "imageCaption", label: "Pie de imagen" }, { value: "header", label: "Cabecera" }, { value: "footer", label: "Pie de pagina" }, { value: "pageNumber", label: "Numero de pagina" }
];

export function VisualBlockInspector({ doc, selectedId, onChange, onMarkGeometry, disabled, geometryDisabled }: {
  doc: VisualPageDocument;
  selectedId: string | null;
  onChange: (doc: VisualPageDocument) => void;
  onMarkGeometry: (id: string) => void;
  disabled: boolean;
  geometryDisabled: boolean;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const nodes = flattenVisualLayout(doc.layout);
  const block = doc.blocks.find((atom) => atom.id === selectedId);
  const node = block ? nodes.find((item) => item.type === "block" && item.blockId === block.id) : nodes.find((item) => item.id === selectedId);
  const [destination, setDestination] = useState("");
  const [position, setPosition] = useState(1);
  const units = visualUnits(doc);
  const number = block ? units.findIndex((unit) => unit.type === "block" && unit.blockId === block.id) + 1 : 0;
  function patch(patch: Partial<VisualBlock>) { if (block) onChange(updateVisualBlock(doc, block.id, patch)); }
  function patchStyle(key: keyof PageStyle, value: string | number) {
    if (!block) return;
    const style = { ...block.style };
    if (value === "") delete style[key];
    else Object.assign(style, { [key]: value });
    patch({ style });
  }
  function format(marker: "**" | "*" | "list" | "ordered-list") {
    if (!block || !textRef.current) return;
    const editor = textRef.current;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    let text: string;
    let nextStart = start;
    let nextEnd = end;
    if (marker === "list" || marker === "ordered-list") {
      const from = block.text.lastIndexOf("\n", start - 1) + 1;
      const endLine = block.text.indexOf("\n", end);
      const to = endLine < 0 ? block.text.length : endLine;
      const formatted = block.text.slice(from, to).split("\n").map((line, index) => `${marker === "list" ? "-" : `${index + 1}.`} ${line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")}`).join("\n");
      text = `${block.text.slice(0, from)}${formatted}${block.text.slice(to)}`;
      nextStart = from;
      nextEnd = from + formatted.length;
    } else {
      const content = block.text.slice(start, end) || "texto";
      const wrapped = start >= marker.length && block.text.slice(start - marker.length, start) === marker && block.text.slice(end, end + marker.length) === marker;
      text = wrapped ? `${block.text.slice(0, start - marker.length)}${content}${block.text.slice(end + marker.length)}` : `${block.text.slice(0, start)}${marker}${content}${marker}${block.text.slice(end)}`;
      nextStart = start + (wrapped ? -marker.length : marker.length);
      nextEnd = nextStart + content.length;
    }
    patch({ text });
    requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(nextStart, nextEnd); });
  }
  const containers = nodes.filter((item): item is VisualContainer => item.type !== "block" && !item.content && (!node || !flattenVisualLayout(node).some((descendant) => descendant.id === item.id)));
  const target = containers.find((item) => item.id === destination);
  return <section className="visual-inspector" aria-label="Inspector del elemento seleccionado">
    <header><h3>{block ? `Bloque ${number}` : node ? node.type === "row" ? "Fila" : "Columna" : "Inspector"}</h3></header>
    {!node ? <p>Selecciona una zona del original o un bloque de la preview.</p> : <fieldset disabled={disabled}>
      {block ? <>
        <label>Tipo<select value={block.kind} onChange={(event) => {
          const kind = event.target.value as VisualBlock["kind"];
          if (kind === "image" && block.kind !== "image" && !block.source) return;
          patch({ kind, role: kind === "text" ? "body" : kind, includeInToc: kind === "heading", ...(kind === "heading" ? { headingLevel: block.headingLevel ?? 1 } : {}) });
        }}><option value="text">Texto</option><option value="heading">Titulo</option><option value="image" disabled={block.kind !== "image" && !block.source}>Imagen</option></select></label>
        <label>Numero / orden<input key={`${block.id}:${number}`} type="number" min={1} max={units.length} defaultValue={number} onBlur={(event) => onChange(reorderVisualBlock(doc, block.id, Number(event.target.value)))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
        <label className="visual-check"><input type="checkbox" checked={!block.active} onChange={(event) => patch({ active: !event.target.checked })} />Anular bloque (se puede restaurar)</label>
        <ReadAloudSwitch checked={block.readAloud} onChange={(readAloud) => patch({ readAloud })} />
        <label>Funcion<select value={block.role} onChange={(event) => patch({ role: event.target.value as PageElementRole })}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
        {block.kind === "heading" ? <>
          <label>Nivel del titulo<select value={block.headingLevel ?? 1} onChange={(event) => patch({ headingLevel: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>T{level}</option>)}</select></label>
          <label className="visual-check"><input type="checkbox" checked={block.includeInToc} onChange={(event) => patch({ includeInToc: event.target.checked })} />Incluir en el indice</label>
        </> : null}
        <label>{block.kind === "image" ? block.altText !== undefined ? "Pie visible de la imagen" : "Descripcion de la imagen" : "Texto Markdown del bloque"}<textarea ref={textRef} rows={6} value={block.text} onChange={(event) => patch({ text: event.target.value })} /></label>
        {block.kind === "image" && block.altText !== undefined ? <label>Descripcion alternativa (lectura)<textarea rows={3} value={block.altText} onChange={(event) => patch({ altText: event.target.value })} /></label> : null}
        {block.kind !== "image" ? <div className="visual-format" role="toolbar" aria-label="Formato del bloque seleccionado">
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("**")} aria-label="Negrita"><strong>B</strong></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("*")} aria-label="Cursiva"><em>I</em></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("list")}>Lista</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("ordered-list")}>Lista numerada</button>
        </div> : <>
          <label>Ancho de imagen: {block.imageWidth ?? 100}%<input type="range" min={1} max={100} value={block.imageWidth ?? 100} onChange={(event) => patch({ imageWidth: Number(event.target.value) })} /></label>
          <VisualImageSourceFields key={block.id} block={block} images={doc.blocks} onChange={patch} />
        </>}
        <AlignmentControl value={block.alignment ?? block.style?.alignment ?? "left"} onChange={(alignment) => patch({ alignment })} />
        {block.kind !== "image" ? <FontScaleControl value={block.fontScale ?? block.style?.fontScale ?? 1} onChange={(fontScale) => patch({ fontScale })} /> : null}
        <details className="visual-style-fields"><summary>Estilo editorial</summary>
          {([["color", "Color del texto"], ["backgroundColor", "Color del fondo"], ["borderColor", "Color del borde"]] as const).map(([key, label]) => <label key={key}>{label} (#RRGGBB)
            <input key={`${block.id}:${block.style?.[key] ?? ""}`} defaultValue={block.style?.[key] ?? ""} placeholder="Heredado" maxLength={7} pattern="#[0-9a-fA-F]{6}" onBlur={(event) => { const value = event.target.value.trim(); if (!value || /^#[0-9a-f]{6}$/i.test(value)) patchStyle(key, value.toLowerCase()); else event.target.reportValidity(); }} />
          </label>)}
          {([["borderWidth", "Grosor del borde", 8], ["padding", "Relleno", 48]] as const).map(([key, label, max]) => <label key={key}>{label} (px)<input type="number" min={0} max={max} step={1} value={block.style?.[key] ?? ""} placeholder="Heredado" onChange={(event) => { const value = event.target.value; const number = Number(value); if (!value || Number.isFinite(number) && number >= 0 && number <= max) patchStyle(key, value ? number : ""); }} /></label>)}
          <label>Familia tipografica<select value={block.style?.fontFamily ?? ""} onChange={(event) => patchStyle("fontFamily", event.target.value)}><option value="">Heredada</option><option value="serif">Serif</option><option value="sans-serif">Sans serif</option></select></label>
        </details>
        <button type="button" disabled={geometryDisabled} onClick={() => onMarkGeometry(block.id)}>Marcar zona en el original</button>
        <p className="helper-text">Mover o cambiar el ancho no altera la caja del original. Anular no modifica sus pixeles.</p>
      </> : node.type !== "block" ? <>
        <label>Distribucion<select value={node.type} onChange={(event) => onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => ({ ...item, type: event.target.value as "row" | "column" } as VisualContainer)) })}><option value="row">Fila (horizontal)</option><option value="column">Columna (vertical)</option></select></label>
        <label>Separacion: {node.gap ?? 12} px<input type="range" min={0} max={48} value={node.gap ?? 12} onChange={(event) => onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => ({ ...item, gap: Number(event.target.value) } as VisualContainer)) })} /></label>
        {node.children.map((child, index) => <label key={child.id}>Peso {index + 1} ({node.type === "row" ? "ancho" : "proporcion"})<input type="number" min={0.1} max={100} step={0.1} value={node.weights?.[index] ?? 1} onChange={(event) => {
          const weight = Number(event.target.value);
          if (!Number.isFinite(weight) || weight <= 0) return;
          const weights = node.children.map((_, i) => i === index ? weight : node.weights?.[i] ?? 1);
          onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => ({ ...item, weights } as VisualContainer)) });
        }} /></label>)}
         <div className="visual-actions">{(["row", "column"] as const).map((type) => <button type="button" key={type} onClick={() => onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => { const parent = item as VisualContainer; return { ...parent, children: [...parent.children, { id: crypto.randomUUID(), type, children: [], gap: 12 }], ...(parent.weights ? { weights: [...parent.weights, 1] } : {}) }; }) })}>Anadir {type === "row" ? "fila" : "columna"}</button>)}</div>
          {node.id !== doc.layout.id ? <button type="button" onClick={() => onChange(ungroupVisualNode(doc, node.id))}>{node.children.length ? "Desagrupar" : "Quitar contenedor vacio"}</button> : null}
      </> : null}
      <div className="visual-actions">{(["row", "column"] as const).map((type) => <button key={type} type="button" onClick={() => onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => ({ id: crypto.randomUUID(), type, children: [item], gap: 12 })) })}>Agrupar en {type === "row" ? "fila" : "columna"}</button>)}</div>
      {node.id !== doc.layout.id ? <div className="visual-move-controls">
        <label>Mover a...<select aria-label="Mover a..." value={target?.id ?? ""} onChange={(event) => { setDestination(event.target.value); setPosition(1); }}><option value="">Elegir destino</option>{containers.map((item, index) => <option key={item.id} value={item.id}>{item.id === doc.layout.id ? "Raiz" : `${item.type === "row" ? "Fila" : "Columna"} ${index + 1}`}</option>)}</select></label>
        <label>Posicion en el destino<input type="number" min={1} max={(target?.children.length ?? 0) + 1} value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
        <button type="button" disabled={!target || !Number.isFinite(position)} onClick={() => { if (target) onChange(moveVisualNode(doc, node.id, target.id, position - 1)); }}>Mover</button>
      </div> : null}
    </fieldset>}
  </section>;
}
