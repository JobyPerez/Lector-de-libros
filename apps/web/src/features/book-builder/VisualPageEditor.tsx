import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BookPageResponse, PageElementGeometry, VisualBlock, VisualCompositeContent, VisualLayoutNode, VisualPageDocument } from "../../app/api";
import { PageElementOverlay, validElementGeometry } from "../../components/PageElementOverlay";
import { replacePendingBookContentImageReferences, useBookContentImageHtml } from "../../hooks/useBookContentImageHtml";
import { VisualBlockInspector, VisualImageSourceFields } from "./VisualBlockInspector";
import { VisualCompositeInspector } from "./VisualCompositeInspector";
import { appendVisualBlock, applyVisualPreset, compositeForBlock, createVisualBlock, flattenVisualLayout, importedVisualSourceHtml, isCenteredFooterRow, mergeVisualBlocks, moveVisualNode, orderedVisualBlocks, renderVisualBlockHtml, renderVisualCompositeHtml, safeVisualImageSource, updateVisualBlock, visualDocumentSaveError, visualUnits, type VisualContainer, type VisualPreset } from "./visual-page";
import "./visual-page.css";

function EditorDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return createPortal(<dialog ref={ref} className="visual-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button type="button" onClick={onClose}>Cerrar</button></header>{children}
  </dialog>, document.body);
}

function VisualAtom({ block, imageSrc, number, selected, onSelect, onAmplify, accessToken, bookId, multiple }: { block: VisualBlock; imageSrc: string | null; number: number; selected: boolean; onSelect: (modifiers?: { ctrlKey: boolean; metaKey: boolean }) => void; onAmplify: (image: { src: string; alt: string }) => void; accessToken: string | null; bookId: string; multiple: boolean }) {
  const [crop, setCrop] = useState<{ key: string; src: string } | null>(null);
  const [cropError, setCropError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cropKey = `${imageSrc}:${JSON.stringify(block.geometry)}`;
  useEffect(() => {
    if (block.kind !== "image" || block.source !== "page-crop" || !imageSrc || !validElementGeometry(block.geometry)) { setCrop(null); return; }
    let active = true;
    setCropError(false);
    const image = new Image();
    image.onload = () => {
      if (!active || !validElementGeometry(block.geometry)) return;
      try {
        const box = block.geometry.bbox;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * box.width));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * box.height));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.drawImage(image, image.naturalWidth * box.left, image.naturalHeight * box.top, image.naturalWidth * box.width, image.naturalHeight * box.height, 0, 0, canvas.width, canvas.height);
        setCrop({ key: cropKey, src: canvas.toDataURL("image/png") });
      } catch { setCropError(true); }
    };
    image.onerror = () => { if (active) setCropError(true); };
    image.src = imageSrc;
    return () => { active = false; };
  }, [block.kind, block.source, cropKey]);
  const html = useBookContentImageHtml(renderVisualBlockHtml(block), accessToken, bookId);
  return <div className={`visual-atom${selected ? " is-selected" : ""}${!block.active ? " is-inactive" : ""}`} data-visual-block-id={block.id}>
    <div className="visual-atom-label"><span>Bloque {number}{block.kind === "heading" ? ` - T${block.headingLevel ?? 1}` : ""}{!block.active ? " (anulado)" : !block.readAloud ? " - No se lee" : ""}</span>{multiple ? <label className="visual-check"><input type="checkbox" checked={selected} disabled={!block.active || block.kind === "image"} onChange={() => onSelect()} aria-label={`Seleccionar bloque ${number} para unir`} />Seleccionar</label> : <button type="button" onClick={() => onSelect()} aria-label={`Editar bloque ${number}`}>Editar</button>}</div>
    <div ref={ref} className="visual-atom-content" role="button" tabIndex={0} aria-label={`Seleccionar bloque ${number}: ${block.text.slice(0, 80)}`} aria-pressed={selected}
      style={{ textAlign: block.alignment ?? "left", fontSize: `${block.fontScale ?? 1}em`, "--visual-image-width": block.imageWidth === undefined ? "auto" : `${block.imageWidth}%` } as CSSProperties}
      onClick={(event) => { event.preventDefault(); onSelect({ ctrlKey: event.ctrlKey, metaKey: event.metaKey }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
      {block.kind === "image" && block.source === "page-crop" && crop?.key === cropKey ? <figure><img src={crop.src} alt={block.text} /><figcaption>{block.text}</figcaption></figure> : <div dangerouslySetInnerHTML={{ __html: replacePendingBookContentImageReferences(html ?? "") }} />}
      {cropError ? <p role="alert">No se pudo generar el recorte local.</p> : null}
    </div>
    {block.kind === "image" ? <button type="button" onClick={() => { const image = ref.current?.querySelector("img"); if (image) onAmplify({ src: image.src, alt: block.text }); }} disabled={!safeVisualImageSource(block.source) && !(crop?.key === cropKey)}>Ampliar</button> : null}
  </div>;
}

function CompositePreview({ node, blocks, number, selected, showInactive, onSelect }: {
  node: VisualContainer; blocks: VisualBlock[]; number: number; selected: boolean; showInactive: boolean; onSelect: () => void;
}) {
  return <div className={`visual-atom visual-compound${selected ? " is-selected" : ""}`} data-visual-composite-id={node.id}>
    <div className="visual-atom-label"><span>Bloque {number} unido ({node.children.length} fragmentos){node.content?.kind === "heading" ? ` - T${node.content.headingLevel ?? 1}` : ""}</span><button type="button" onClick={onSelect} aria-label={`Editar bloque unido ${number}`}>Editar</button></div>
    <div className="visual-atom-content" role="button" tabIndex={0} aria-label={`Seleccionar bloque unido ${number}`} aria-pressed={selected} onClick={(event) => { event.preventDefault(); onSelect(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }} dangerouslySetInnerHTML={{ __html: renderVisualCompositeHtml(node, blocks, showInactive) }} />
  </div>;
}

export function VisualPageEditor({ doc, page, savedDocument, selectedId, onSelect, onChange, source, sourceImage, accessToken, bookId, disabled, geometryDisabled, canUndo, canRedo, onUndo, onRedo, onInteractionChange, onAmplify }: {
  doc: VisualPageDocument;
  page: BookPageResponse["page"];
  savedDocument: VisualPageDocument;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (doc: VisualPageDocument) => void;
  source: (overlay: ReactNode) => ReactNode;
  sourceImage: string | null;
  accessToken: string | null;
  bookId: string;
  disabled: boolean;
  geometryDisabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onInteractionChange: (busy: boolean) => void;
  onAmplify: (image: { src: string; alt: string }) => void;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [newBlock, setNewBlock] = useState<VisualBlock | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);
  const [multiple, setMultiple] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinContent, setJoinContent] = useState<VisualCompositeContent>({ kind: "text", separator: "paragraph", includeInToc: false });
  const [joinReading, setJoinReading] = useState("preserve");
  const inspectorRef = useRef<HTMLDivElement>(null);
  const dragTimerRef = useRef<number | null>(null);
  const order = orderedVisualBlocks(doc);
  const units = visualUnits(doc);
  const selectedComposite = flattenVisualLayout(doc.layout).find((node): node is VisualContainer => node.id === selectedId && node.type !== "block" && Boolean(node.content));
  const compoundMemberIds = selectedComposite?.children.flatMap((child) => child.type === "block" ? [child.blockId] : []) ?? [];
  const unitNumber = (blockId: string) => units.findIndex((unit) => unit.type === "block" ? unit.blockId === blockId : unit.children.some((child) => child.type === "block" && child.blockId === blockId)) + 1;
  const sourceHtml = useMemo(() => page.hasSourceImage ? null : importedVisualSourceHtml(page, savedDocument), [page.hasSourceImage, page.sourceHtmlContent, page.htmlContent, page.paragraphs, savedDocument]);
  const importedHtml = useBookContentImageHtml(sourceHtml, accessToken, bookId);
  useEffect(() => { onInteractionChange(Boolean(marking || dragging || newBlock || joining)); return () => onInteractionChange(false); }, [marking, dragging, newBlock, joining, onInteractionChange]);
  useEffect(() => { if (geometryDisabled || disabled) setMarking(null); }, [geometryDisabled, disabled]);
  useEffect(() => () => { if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current); }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (disabled || newBlock || (target instanceof Element && target.closest("textarea,input,select,[contenteditable='true']"))) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) onRedo(); else onUndo();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [disabled, newBlock, onUndo, onRedo]);
  function select(id: string, modifiers?: { ctrlKey: boolean; metaKey: boolean }) {
    if (multiple || modifiers?.ctrlKey || modifiers?.metaKey) {
      const block = doc.blocks.find((atom) => atom.id === id);
      if (!block?.active || block.kind === "image" || compositeForBlock(doc, id)) {
        setSelectionError("Selecciona textos o titulos activos que aun no esten unidos. Separa primero un bloque unido para recombinarlo.");
        return;
      }
      setMultiple(true);
      setMobileInspector(false);
      onSelect(null);
      setSelectionError(null);
      setSelection((ids) => ids.includes(id) ? ids.filter((key) => key !== id) : [...ids, id]);
      return;
    }
    onSelect(compositeForBlock(doc, id)?.id ?? id);
    setMarking(null);
    if (window.matchMedia("(max-width: 760px)").matches) setMobileInspector(true);
    else requestAnimationFrame(() => inspectorRef.current?.focus());
  }
  function mark(id: string) { setMobileInspector(false); setMarking(id); }
  function create() { if (sourceImage && !geometryDisabled) setMarking("new"); else setNewBlock(createVisualBlock("text")); }
  function startDrag(event: DragEvent<HTMLButtonElement>, id: string) {
    event.dataTransfer.setData("application/x-visual-node", id);
    event.dataTransfer.effectAllowed = "move";
    // Let the browser capture the native drag image before drop zones reflow the source.
    dragTimerRef.current = window.setTimeout(() => { dragTimerRef.current = null; setDragging(id); }, 0);
  }
  function endDrag() {
    if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = null;
    setDragging(null);
  }
  const closeInspector = () => { onSelect(null); setMobileInspector(false); };
  const inspector = selectedComposite ? <VisualCompositeInspector key={selectedId} doc={doc} node={selectedComposite} onChange={onChange} onClose={closeInspector} onMarkGeometry={mark} disabled={disabled} geometryDisabled={geometryDisabled} /> : <VisualBlockInspector key={selectedId} doc={doc} selectedId={selectedId} onChange={onChange} onClose={closeInspector} onMarkGeometry={mark} disabled={disabled} geometryDisabled={geometryDisabled} />;
  const overlay = sourceImage ? <PageElementOverlay imageSrc={sourceImage} elements={order.map((block) => ({ key: block.id, text: block.text, geometry: block.geometry, active: block.active, number: unitNumber(block.id) }))}
    selectedKey={selectedId} selectedKeys={multiple ? selection : compoundMemberIds} onSelect={select} marking={Boolean(marking)} disabled={geometryDisabled || disabled}
    onGeometryChange={(id, geometry) => { onChange(updateVisualBlock(doc, id, { geometry })); setMarking(null); }}
    {...(marking === "new" ? { onCreateGeometry: (geometry: PageElementGeometry) => { setNewBlock(createVisualBlock("text", geometry)); setMarking(null); } } : {})} /> : null;
  function hasVisibleContent(node: VisualLayoutNode): boolean {
    return node.type === "block" ? doc.blocks.some((block) => block.id === node.blockId && block.active) : node.children.some(hasVisibleContent);
  }
  function renderNode(node: VisualLayoutNode, root = false): ReactNode {
    if (node.type === "block") {
      const block = doc.blocks.find((atom) => atom.id === node.blockId);
      if (!block || (!block.active && !showInactive)) return null;
      return <div className="visual-leaf" key={node.id}>
        <button className="visual-drag-handle" type="button" draggable={!disabled && !multiple} disabled={disabled || multiple} aria-label={`Arrastrar bloque ${unitNumber(block.id)}`} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}>Arrastrar bloque</button>
        <VisualAtom block={block} imageSrc={sourceImage} number={unitNumber(block.id)} selected={multiple ? selection.includes(block.id) : selectedId === block.id} multiple={multiple} onSelect={(modifiers) => select(block.id, modifiers)} onAmplify={onAmplify} accessToken={accessToken} bookId={bookId} />
      </div>;
    }
    if (node.content) {
      if (!showInactive && !hasVisibleContent(node)) return null;
      return <div className="visual-leaf" data-visual-node-id={node.id} key={node.id}>
        <button className="visual-drag-handle" type="button" draggable={!disabled && !multiple} disabled={disabled || multiple} aria-label={`Arrastrar bloque unido ${units.findIndex((unit) => unit.id === node.id) + 1}`} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}>Arrastrar bloque unido</button>
        <CompositePreview node={node} blocks={doc.blocks} number={units.findIndex((unit) => unit.id === node.id) + 1} selected={selectedId === node.id} showInactive={showInactive} onSelect={() => select(node.id)} />
      </div>;
    }
    if (!root && !showInactive && !dragging && node.children.length && !hasVisibleContent(node)) return null;
    function dropzone(index: number) {
      return <div className={`visual-dropzone${dragging ? " is-dragging" : ""}`} role="group" aria-label={`Zona de soltado ${index + 1}`} onDragOver={(event) => { if (!disabled && dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => {
        event.preventDefault(); event.stopPropagation();
        const id = event.dataTransfer.getData("application/x-visual-node");
        if (!disabled && dragging === id) onChange(moveVisualNode(doc, id, node.id, index));
        endDrag();
      }}><span>Soltar aqui</span></div>;
    }
    const autoFooter = !dragging && isCenteredFooterRow(node, doc.blocks);
    return <section key={node.id} data-visual-node-id={node.id} className={`visual-container visual-container-${node.type}${selectedId === node.id ? " is-selected" : ""}`}>
      <header><button type="button" onClick={() => select(node.id)} aria-pressed={selectedId === node.id}>{root ? "Pagina" : node.type === "row" ? "Fila" : "Columna"}</button>
        {!root ? <button type="button" className="visual-drag-handle" draggable={!disabled} disabled={disabled} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}>Arrastrar {node.type === "row" ? "fila" : "columna"}</button> : null}
      </header>
      <div className="visual-container-children" data-page-footer-row={autoFooter ? "true" : undefined} style={{ flexDirection: node.type === "row" ? "row" : "column", gap: `${node.gap ?? 12}px` }}>
        {node.children.map((child, index) => {
          const content = renderNode(child);
          return content ? <Fragment key={child.id}>{dropzone(index)}<div className="visual-layout-child" data-footer-slot={autoFooter ? index + 2 : undefined} style={{ flexGrow: node.weights?.[index] ?? 1, flexBasis: node.type === "row" ? 0 : "auto", ...(autoFooter ? { gridColumn: index + 2, gridRow: 1 } : {}) }}>{content}</div></Fragment> : null;
        })}
        {dropzone(node.children.length)}
      </div>
    </section>;
  }
  const candidate = (() => {
    if (!joining) return null;
    try {
      const document = mergeVisualBlocks(doc, selection, joinContent);
      const error = visualDocumentSaveError(document);
      if (error) return { error };
      return { document, error: null };
    } catch (error) { return { error: error instanceof Error ? error.message : "No se puede unir esta seleccion." }; }
  })();
  return <div className="visual-page-editor">
    <div className="visual-source-column">
      <div className="visual-source-actions"><button type="button" disabled={disabled || multiple || Boolean(sourceImage && geometryDisabled)} onClick={create}>Crear bloque</button>
        <label className="visual-check"><input type="checkbox" checked={multiple} disabled={disabled || Boolean(marking)} onChange={(event) => { setMultiple(event.target.checked); setSelection([]); setSelectionError(null); setMobileInspector(false); onSelect(null); }} />Seleccion multiple</label>
        {multiple ? <><span role="status">{selection.length} bloques seleccionados</span><button type="button" disabled={disabled || selection.length < 2} onClick={() => { const heading = selection.some((id) => doc.blocks.find((block) => block.id === id)?.kind === "heading"); setJoinContent({ kind: heading ? "heading" : "text", separator: heading ? "line" : "paragraph", includeInToc: heading, headingLevel: 1, alignment: heading ? "center" : "left" }); setJoinReading("preserve"); setJoining(true); }}>Unir seleccionados</button><button type="button" onClick={() => { setSelection([]); setSelectionError(null); }}>Limpiar seleccion</button></> : null}
        {selectedId ? <button type="button" className="visual-open-inspector" onClick={() => setMobileInspector(true)}>Abrir inspector</button> : null}
      </div>
      {selectionError ? <p role="alert" className="error-text">{selectionError}</p> : null}
      {marking ? <p role="status">Arrastra un rectangulo sobre la imagen. <button type="button" onClick={() => setMarking(null)}>Cancelar marcado</button></p> : null}
      {source(overlay)}
      {!page.hasSourceImage ? <article className="visual-imported-source"><h3>Contenido importado</h3><p className="helper-text">HTML guardado, no es un facsimil. La creacion por geometria no esta disponible.</p>
        <div className="visual-imported-html" dangerouslySetInnerHTML={{ __html: replacePendingBookContentImageReferences(importedHtml ?? "") }} onClick={(event) => { event.preventDefault(); const element = (event.target as Element).closest("[data-visual-block-id],[data-paragraph-id]"); const id = element?.getAttribute("data-visual-block-id") ?? element?.getAttribute("data-paragraph-id"); if (id && doc.blocks.some((block) => block.id === id)) select(id, { ctrlKey: event.ctrlKey, metaKey: event.metaKey }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { const element = (event.target as Element).closest("[data-visual-block-id],[data-paragraph-id]"); const id = element?.getAttribute("data-visual-block-id") ?? element?.getAttribute("data-paragraph-id"); if (id) { event.preventDefault(); select(id, { ctrlKey: event.ctrlKey, metaKey: event.metaKey }); } } }} />
      </article> : null}
      <div className="visual-inline-inspector" ref={inspectorRef} tabIndex={-1}>{mobileInspector ? null : inspector}</div>
    </div>
    <article className="visual-preview-column" aria-label="Previsualizacion interactiva">
      <header><div><p className="page-label">Documento visual</p><h3>Previsualizacion interactiva</h3></div><div className="visual-actions"><button type="button" disabled={disabled || !canUndo} onClick={onUndo}>Deshacer</button><button type="button" disabled={disabled || !canRedo} onClick={onRedo}>Rehacer</button></div></header>
      <div className="visual-preview-tools"><label>Distribucion<select defaultValue="" disabled={disabled} onChange={(event) => { onChange(applyVisualPreset(doc, event.target.value as VisualPreset)); event.target.value = ""; }}><option value="" disabled>Layout actual</option><option value="one-column">1 columna</option><option value="two-columns">2 columnas</option><option value="two-by-two">2 x 2</option><option value="rows">Fila horizontal</option></select></label>
        <label className="visual-check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />Mostrar anulados</label>
      </div>
      <p className="helper-text">Selecciona para editar. Arrastra desde el asa a una zona o usa Mover a... en el inspector.</p>
      <div className="visual-preview-canvas">{renderNode(doc.layout, true)}</div>
      {!order.some((block) => block.active) ? <p className="helper-text">No hay bloques activos. Activa Mostrar anulados para restaurarlos o crea uno nuevo.</p> : null}
    </article>
    {mobileInspector && selectedId ? <EditorDialog title="Inspector del bloque" onClose={() => setMobileInspector(false)}>{inspector}</EditorDialog> : null}
    {joining ? <EditorDialog title="Unir contenido" onClose={() => setJoining(false)}><fieldset disabled={disabled}>
      <p>Los fragmentos se unen en el orden de lectura, conservando sus textos, IDs, zonas y anotaciones.</p>
      <label>Tipo del resultado<select value={joinContent.kind} onChange={(event) => setJoinContent({ ...joinContent, kind: event.target.value as "text" | "heading", includeInToc: event.target.value === "heading" })}><option value="text">Cuerpo de texto</option><option value="heading">Titulo</option></select></label>
      <label>Separacion<select value={joinContent.separator} onChange={(event) => setJoinContent({ ...joinContent, separator: event.target.value as VisualCompositeContent["separator"] })}><option value="space">Espacio</option><option value="line">Salto de linea</option><option value="paragraph">Separacion de parrafos</option></select></label>
      {joinContent.kind === "heading" ? <><label>Nivel del titulo<select value={joinContent.headingLevel ?? 1} onChange={(event) => setJoinContent({ ...joinContent, headingLevel: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>T{level}</option>)}</select></label><label className="visual-check"><input type="checkbox" checked={joinContent.includeInToc} onChange={(event) => setJoinContent({ ...joinContent, includeInToc: event.target.checked })} />Incluir en el indice</label></> : null}
      <label>Lectura<select value={joinReading} onChange={(event) => setJoinReading(event.target.value)}><option value="preserve">Conservar preferencias por fragmento</option><option value="all">Leer todos</option><option value="none">No leer ninguno</option></select></label>
      {candidate?.error ? <p role="alert" className="error-text">{candidate.error}</p> : candidate?.document ? <div className="visual-join-preview" dangerouslySetInnerHTML={{ __html: renderVisualCompositeHtml(compositeForBlock(candidate.document, selection[0]!)!, candidate.document.blocks) }} /> : null}
      <div className="visual-actions"><button type="button" onClick={() => setJoining(false)}>Cancelar</button><button type="button" disabled={!candidate?.document || Boolean(candidate.error)} onClick={() => {
        if (!candidate?.document) return;
        const document = candidate.document;
        if (joinReading !== "preserve") document.blocks = document.blocks.map((block) => selection.includes(block.id) ? { ...block, readAloud: joinReading === "all" } : block);
        const id = compositeForBlock(document, selection[0]!)!.id;
        onChange(document); setJoining(false); setMultiple(false); setSelection([]); setSelectionError(null); onSelect(id);
        if (window.matchMedia("(max-width: 760px)").matches) setMobileInspector(true);
        else requestAnimationFrame(() => inspectorRef.current?.focus());
      }}>Unir contenido</button></div>
    </fieldset></EditorDialog> : null}
    {newBlock ? <EditorDialog title="Crear bloque" onClose={() => setNewBlock(null)}><fieldset disabled={disabled}>
      <label>Tipo<select aria-label="Tipo" value={newBlock.kind} onChange={(event) => { const kind = event.target.value as VisualBlock["kind"]; const next = createVisualBlock(kind, newBlock.geometry ?? null); setNewBlock({ ...next, id: newBlock.id }); }}><option value="text">Texto</option><option value="heading">Titulo</option><option value="image">Imagen</option></select></label>
      <label>{newBlock.kind === "image" ? "Descripcion" : "Contenido Markdown"}<textarea rows={5} value={newBlock.text} onChange={(event) => setNewBlock({ ...newBlock, text: event.target.value })} /></label>
      {newBlock.kind === "image" ? <VisualImageSourceFields block={newBlock} images={doc.blocks} onChange={(patch) => setNewBlock({ ...newBlock, ...patch })} /> : null}
      <p className="helper-text">El nuevo bloque conserva un UUID propio. Solo se persiste con Guardar cambios.</p>
      <div className="visual-actions"><button type="button" onClick={() => setNewBlock(null)}>Cancelar</button><button type="button" disabled={newBlock.kind === "image" ? !(safeVisualImageSource(newBlock.source) || newBlock.source === "page-crop" && validElementGeometry(newBlock.geometry)) : !newBlock.text.trim()} onClick={() => { onChange(appendVisualBlock(doc, newBlock)); select(newBlock.id); setNewBlock(null); }}>Crear</button></div>
    </fieldset></EditorDialog> : null}
  </div>;
}
