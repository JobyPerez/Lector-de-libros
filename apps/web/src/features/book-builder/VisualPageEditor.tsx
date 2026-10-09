import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BookPageResponse, PageElementGeometry, VisualBlock, VisualCompositeContent, VisualLayoutNode, VisualPageDocument } from "../../app/api";
import { PageElementOverlay, validElementGeometry } from "../../components/PageElementOverlay";
import { replacePendingBookContentImageReferences, useBookContentImageHtml } from "../../hooks/useBookContentImageHtml";
import { VisualBlockInspector, VisualImageSourceFields } from "./VisualBlockInspector";
import { VisualCompositeInspector } from "./VisualCompositeInspector";
import { appendVisualBlock, applyVisualPreset, compositeForBlock, createVisualBlock, flattenVisualLayout, importedVisualSourceHtml, isCenteredFooterRow, mergeVisualBlocks, moveVisualNode, orderedVisualBlocks, renderVisualBlockHtml, renderVisualCompositeHtml, renderVisualStyle, safeVisualImageSource, updateVisualBlock, visualDocumentSaveError, visualUnits, type VisualContainer, type VisualPreset } from "./visual-page";
import "./visual-page.css";

function PreviewIcon({ name }: { name: "edit" | "drag" | "zoom" | "undo" | "redo" | "page" | "row" | "column" | "inactive" }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {name === "edit" ? <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /><path d="M13 20h7" /></> : null}
    {name === "drag" ? <>{[6, 12, 18].map((cy) => <Fragment key={cy}><circle cx="9" cy={cy} r="1" fill="currentColor" /><circle cx="15" cy={cy} r="1" fill="currentColor" /></Fragment>)}</> : null}
    {name === "zoom" ? <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M7 10h6M10 7v6" /></> : null}
    {name === "undo" || name === "redo" ? <g transform={name === "redo" ? "translate(24 0) scale(-1 1)" : undefined}><path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 7 7v4" /></g> : null}
    {name === "page" ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 12h6M9 16h6" /></> : null}
    {name === "row" || name === "column" ? <g transform={name === "column" ? "rotate(90 12 12)" : undefined}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></g> : null}
    {name === "inactive" ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /><path d="m3 3 18 18" /></> : null}
  </svg>;
}

function EditorDialog({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { scrollX, scrollY } = window;
    const root = document.documentElement;
    const { overflow, scrollbarGutter } = root.style;
    root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    dialog?.showModal();
    dialog?.focus({ preventScroll: true });
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    return () => {
      dialog?.close();
      root.style.overflow = overflow;
      root.style.scrollbarGutter = scrollbarGutter;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    };
  }, []);
  return createPortal(<dialog ref={ref} tabIndex={-1} className={`visual-dialog ${className}`} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button type="button" onClick={onClose}>Cerrar</button></header>{children}
  </dialog>, document.body);
}

function VisualInspectorDialog({ doc, initialSelectedId, sourceImage, disabled, geometryDisabled, stale, onAccept, onCancel, simpleTypography = false }: {
  doc: VisualPageDocument; initialSelectedId: string; sourceImage: string | null; disabled: boolean; geometryDisabled: boolean; stale: boolean;
  onAccept: (doc: VisualPageDocument, selectedId: string) => void; onCancel: () => void;
  simpleTypography?: boolean;
}) {
  const [draft, setDraft] = useState(doc);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [marking, setMarking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const geometryRef = useRef<HTMLDivElement>(null);
  const nodes = flattenVisualLayout(draft.layout);
  const composite = nodes.find((node): node is VisualContainer => node.id === selectedId && node.type !== "block" && Boolean(node.content));
  useEffect(() => { if (disabled || geometryDisabled || stale) setMarking(null); }, [disabled, geometryDisabled, stale]);
  useEffect(() => {
    if (marking) { geometryRef.current?.focus({ preventScroll: true }); geometryRef.current?.scrollIntoView({ block: "nearest" }); }
  }, [marking]);
  function changeDraft(next: VisualPageDocument) {
    setDraft(next);
    setError(null);
    if (!next.blocks.some((block) => block.id === selectedId) && !flattenVisualLayout(next.layout).some((node) => node.id === selectedId)) {
      const node = nodes.find((node) => node.id === selectedId);
      const child = node ? flattenVisualLayout(node).find((node) => node.type === "block") : null;
      setSelectedId(child?.type === "block" ? compositeForBlock(next, child.blockId)?.id ?? child.blockId : next.layout.id);
    }
  }
  function accept() {
    if (disabled || stale || marking) return;
    const validationError = visualDocumentSaveError(draft);
    if (validationError) { setError(validationError); return; }
    onAccept(draft, selectedId);
  }
  return <EditorDialog title={composite ? "Editar bloque unido" : draft.blocks.some((block) => block.id === selectedId) ? "Editar bloque" : "Editar distribucion"} className="visual-edit-dialog" onClose={onCancel}>
    <div className="visual-edit-body">
      {marking && sourceImage ? <div className="visual-edit-geometry" ref={geometryRef} tabIndex={-1}>
        <p role="status">Arrastra un rectangulo sobre el original para marcar la zona. <button type="button" onClick={() => setMarking(null)}>Cancelar marcado</button></p>
        <PageElementOverlay imageSrc={sourceImage} elements={orderedVisualBlocks(draft).map((block, index) => ({ key: block.id, text: block.text, geometry: block.geometry, active: block.active, number: index + 1 })).filter((element) => element.active || element.key === selectedId || composite?.children.some((child) => child.type === "block" && child.blockId === element.key))}
          selectedKey={marking} onSelect={setMarking} marking disabled={disabled || geometryDisabled || stale}
          onGeometryChange={(id, geometry) => { changeDraft(updateVisualBlock(draft, id, { geometry })); setMarking(null); }} />
      </div> : null}
      {composite ? <VisualCompositeInspector simpleTypography={simpleTypography} key={selectedId} doc={draft} node={composite} onChange={changeDraft} onMarkGeometry={setMarking} disabled={disabled || stale} geometryDisabled={geometryDisabled || stale} />
        : <VisualBlockInspector simpleTypography={simpleTypography} key={selectedId} doc={draft} selectedId={selectedId} onChange={changeDraft} onMarkGeometry={setMarking} disabled={disabled || stale} geometryDisabled={geometryDisabled || stale} />}
      <p className="helper-text">Aceptar actualiza la previsualizacion. Los cambios se guardan en el servidor al pulsar Guardar cambios en la pagina.</p>
    </div>
    <footer className="visual-edit-footer">
      {stale ? <p role="alert" className="error-text">La pagina ha cambiado mientras editabas. Cancela y vuelve a abrir el bloque para editar la version actual.</p> : error ? <p role="alert" className="error-text">{error}</p> : null}
      <div className="visual-actions"><button type="button" onClick={onCancel}>Cancelar</button><button type="button" disabled={disabled || stale || Boolean(marking)} onClick={accept}>Aceptar</button></div>
    </footer>
  </EditorDialog>;
}

function VisualAtom({ block, imageSrc, number, selected, onSelect, onAmplify, accessToken, bookId, multiple, dragHandle }: { block: VisualBlock; imageSrc: string | null; number: number; selected: boolean; onSelect: (modifiers?: { ctrlKey: boolean; metaKey: boolean }) => void; onAmplify: (image: { src: string; alt: string }) => void; accessToken: string | null; bookId: string; multiple: boolean; dragHandle: ReactNode }) {
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
    <div className="visual-atom-label"><span>Bloque {number}{block.kind === "heading" ? ` - T${block.headingLevel ?? 1}` : ""}{!block.active ? " (anulado)" : !block.readAloud ? " - No se lee" : ""}</span><div className="visual-atom-actions">
      {dragHandle}
      {multiple ? <label className="visual-check" title={`Seleccionar bloque ${number} para unir`}><input type="checkbox" checked={selected} disabled={!block.active || block.kind === "image"} onChange={() => onSelect()} aria-label={`Seleccionar bloque ${number} para unir`} /></label> : <button className="visual-icon-button" type="button" onClick={() => onSelect()} aria-label={`Editar bloque ${number}`} title={`Editar bloque ${number}`}><PreviewIcon name="edit" /></button>}
      {block.kind === "image" ? <button className="visual-icon-button" type="button" aria-label={`Ampliar imagen del bloque ${number}`} title={`Ampliar imagen del bloque ${number}`} onClick={() => { const image = ref.current?.querySelector("img"); if (image) onAmplify({ src: image.src, alt: block.text }); }} disabled={!safeVisualImageSource(block.source) && !(crop?.key === cropKey)}><PreviewIcon name="zoom" /></button> : null}
    </div></div>
    <div ref={ref} className="visual-atom-content" role="button" tabIndex={0} aria-label={`Seleccionar bloque ${number}: ${block.text.slice(0, 80)}`} aria-pressed={selected}
      onClick={(event) => { event.preventDefault(); onSelect({ ctrlKey: event.ctrlKey, metaKey: event.metaKey }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
      {block.kind === "image" && block.source === "page-crop" && crop?.key === cropKey ? <div dangerouslySetInnerHTML={{ __html: renderVisualBlockHtml({ ...block, source: crop.src }) }} /> : <div dangerouslySetInnerHTML={{ __html: replacePendingBookContentImageReferences(html ?? "") }} />}
      {cropError ? <p role="alert">No se pudo generar el recorte local.</p> : null}
    </div>
  </div>;
}

function CompositePreview({ node, blocks, number, selected, showInactive, onSelect, dragHandle }: {
  node: VisualContainer; blocks: VisualBlock[]; number: number; selected: boolean; showInactive: boolean; onSelect: () => void; dragHandle: ReactNode;
}) {
  return <div className={`visual-atom visual-compound${selected ? " is-selected" : ""}`} data-visual-composite-id={node.id}>
    <div className="visual-atom-label"><span>Bloque {number} unido ({node.children.length} fragmentos){node.content?.kind === "heading" ? ` - T${node.content.headingLevel ?? 1}` : ""}</span><div className="visual-atom-actions">{dragHandle}<button className="visual-icon-button" type="button" onClick={onSelect} aria-label={`Editar bloque unido ${number}`} title={`Editar bloque unido ${number}`}><PreviewIcon name="edit" /></button></div></div>
    <div className="visual-atom-content" role="button" tabIndex={0} aria-label={`Seleccionar bloque unido ${number}`} aria-pressed={selected} onClick={(event) => { event.preventDefault(); onSelect(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }} dangerouslySetInnerHTML={{ __html: renderVisualCompositeHtml(node, blocks, showInactive) }} />
  </div>;
}

export function VisualPageEditor({ doc, page, savedDocument, selectedId, onSelect, onChange, source, sourceImage, accessToken, bookId, disabled, geometryDisabled, canUndo, canRedo, onUndo, onRedo, onInteractionChange, onAmplify, initialEditId, simpleTypography = false }: {
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
  initialEditId?: string;
  simpleTypography?: boolean;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [newBlock, setNewBlock] = useState<VisualBlock | null>(null);
  const [editing, setEditing] = useState<{ id: string; doc: VisualPageDocument; sourceImage: string | null } | null>(null);
  const [multiple, setMultiple] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinContent, setJoinContent] = useState<VisualCompositeContent>({ kind: "text", separator: "paragraph", includeInToc: false });
  const [joinReading, setJoinReading] = useState("preserve");
  const editorRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dragTimerRef = useRef<number | null>(null);
  const initialEditOpenedRef = useRef(false);
  const order = orderedVisualBlocks(doc);
  const units = visualUnits(doc);
  const selectedComposite = flattenVisualLayout(doc.layout).find((node): node is VisualContainer => node.id === selectedId && node.type !== "block" && Boolean(node.content));
  const compoundMemberIds = selectedComposite?.children.flatMap((child) => child.type === "block" ? [child.blockId] : []) ?? [];
  const unitNumber = (blockId: string) => units.findIndex((unit) => unit.type === "block" ? unit.blockId === blockId : unit.children.some((child) => child.type === "block" && child.blockId === blockId)) + 1;
  const sourceHtml = useMemo(() => page.hasSourceImage ? null : importedVisualSourceHtml(page, savedDocument), [page.hasSourceImage, page.sourceHtmlContent, page.htmlContent, page.paragraphs, savedDocument]);
  const importedHtml = useBookContentImageHtml(sourceHtml, accessToken, bookId);
  useEffect(() => {
    if (!initialEditId || initialEditOpenedRef.current || disabled) return;
    const compound = compositeForBlock(doc, initialEditId);
    const id = compound?.id ?? initialEditId;
    if (!doc.blocks.some((block) => block.id === id) && !flattenVisualLayout(doc.layout).some((node) => node.id === id)) return;
    const frame = requestAnimationFrame(() => {
      initialEditOpenedRef.current = true;
      onSelect(id);
      if (compound ? !compound.children.some((child) => child.type === "block" && doc.blocks.some((block) => block.id === child.blockId && block.active)) : doc.blocks.some((block) => block.id === id && !block.active)) setShowInactive(true);
      setEditing({ id, doc, sourceImage });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialEditId, disabled, doc, sourceImage, onSelect]);
  useEffect(() => { onInteractionChange(Boolean(editing || marking || dragging || newBlock || joining)); return () => onInteractionChange(false); }, [editing, marking, dragging, newBlock, joining, onInteractionChange]);
  useEffect(() => { if (geometryDisabled || disabled) setMarking(null); }, [geometryDisabled, disabled]);
  useEffect(() => () => { if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current); }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (disabled || editing || newBlock || joining || (target instanceof Element && target.closest("textarea,input,select,[contenteditable='true']"))) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) onRedo(); else onUndo();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [disabled, editing, newBlock, joining, onUndo, onRedo]);
  function select(id: string, modifiers?: { ctrlKey: boolean; metaKey: boolean }) {
    if (multiple || modifiers?.ctrlKey || modifiers?.metaKey) {
      const block = doc.blocks.find((atom) => atom.id === id);
      if (!block?.active || block.kind === "image" || compositeForBlock(doc, id)) {
        setSelectionError("Selecciona textos o titulos activos que aun no esten unidos. Separa primero un bloque unido para recombinarlo.");
        return;
      }
      setMultiple(true);
      onSelect(null);
      setSelectionError(null);
      setSelection((ids) => ids.includes(id) ? ids.filter((key) => key !== id) : [...ids, id]);
      return;
    }
    const targetId = compositeForBlock(doc, id)?.id ?? id;
    returnFocusRef.current = document.activeElement instanceof HTMLElement && editorRef.current?.contains(document.activeElement) ? document.activeElement : null;
    onSelect(targetId);
    setMarking(null);
    setEditing({ id: targetId, doc, sourceImage });
  }
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
  function closeInspector(next?: VisualPageDocument, nextSelectedId = selectedId) {
    if (next) {
      if (disabled || doc !== editing?.doc) return;
      onChange(next);
      onSelect(nextSelectedId);
      const composite = flattenVisualLayout(next.layout).find((node) => node.id === nextSelectedId && node.type !== "block" && node.content);
      if (next.blocks.some((block) => block.id === nextSelectedId && !block.active) || composite && !flattenVisualLayout(composite).some((node) => node.type === "block" && next.blocks.some((block) => block.id === node.blockId && block.active))) setShowInactive(true);
    }
    setEditing(null);
    requestAnimationFrame(() => {
      const id = nextSelectedId ? CSS.escape(nextSelectedId) : "";
      const element = editorRef.current?.querySelector<HTMLElement>(`[data-visual-block-id="${id}"],[data-visual-composite-id="${id}"],[data-visual-node-id="${id}"]`);
      const opener = returnFocusRef.current;
      const target = opener?.isConnected ? opener : element?.querySelector<HTMLElement>("button[aria-label^='Editar'], .visual-atom-content");
      target?.focus({ preventScroll: true });
      if (next && target) {
        const bounds = target.getBoundingClientRect();
        if (bounds.top < 0 || bounds.bottom > window.innerHeight) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    });
  }
  const overlay = sourceImage ? <PageElementOverlay imageSrc={sourceImage} elements={order.filter((block) => block.active || showInactive).map((block) => {
    const content = compositeForBlock(doc, block.id)?.content ?? block;
    return { key: block.id, text: block.text, geometry: block.geometry, active: block.active, number: unitNumber(block.id), ...(simpleTypography ? { kind: content.kind, label: content.kind === "heading" ? `${unitNumber(block.id)} · T${content.headingLevel ?? 1}` : String(unitNumber(block.id)) } : {}) };
  })}
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
        <VisualAtom block={block} imageSrc={sourceImage} number={unitNumber(block.id)} selected={multiple ? selection.includes(block.id) : selectedId === block.id} multiple={multiple} onSelect={(modifiers) => select(block.id, modifiers)} onAmplify={onAmplify} accessToken={accessToken} bookId={bookId}
          dragHandle={<button className="visual-icon-button visual-drag-handle" type="button" draggable={!disabled && !multiple} disabled={disabled || multiple} aria-label={`Arrastrar bloque ${unitNumber(block.id)}`} title={`Arrastrar bloque ${unitNumber(block.id)}`} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}><PreviewIcon name="drag" /></button>} />
      </div>;
    }
    const containerStyle = Object.fromEntries(renderVisualStyle(node.style).split(";").filter(Boolean).map((declaration) => {
      const [key, value] = declaration.split(":");
      return [key!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value];
    })) as CSSProperties;
    if (node.content) {
      if (!showInactive && !hasVisibleContent(node)) return null;
      return <div className="visual-leaf" data-visual-node-id={node.id} data-layout-semantic={node.semantic} key={node.id}>
        <CompositePreview node={node} blocks={doc.blocks} number={units.findIndex((unit) => unit.id === node.id) + 1} selected={selectedId === node.id} showInactive={showInactive} onSelect={() => select(node.id)}
          dragHandle={<button className="visual-icon-button visual-drag-handle" type="button" draggable={!disabled && !multiple} disabled={disabled || multiple} aria-label={`Arrastrar bloque unido ${units.findIndex((unit) => unit.id === node.id) + 1}`} title={`Arrastrar bloque unido ${units.findIndex((unit) => unit.id === node.id) + 1}`} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}><PreviewIcon name="drag" /></button>} />
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
    const containerLabel = root ? "pagina" : node.type === "row" ? "fila" : "columna";
    return <section key={node.id} data-visual-node-id={node.id} data-layout-semantic={node.semantic} data-text-align={node.style?.alignment} style={containerStyle} className={`visual-container visual-container-${node.type}${selectedId === node.id ? " is-selected" : ""}`}>
      <header><button className="visual-icon-button" type="button" onClick={() => select(node.id)} aria-pressed={selectedId === node.id} aria-label={`Editar distribucion de ${containerLabel}`} title={`Editar distribucion de ${containerLabel}`}><PreviewIcon name={root ? "page" : node.type} /></button>
        {!root ? <button type="button" className="visual-icon-button visual-drag-handle" draggable={!disabled} disabled={disabled} aria-label={`Arrastrar ${containerLabel}`} title={`Arrastrar ${containerLabel}`} onDragStart={(event) => startDrag(event, node.id)} onDragEnd={endDrag}><PreviewIcon name="drag" /></button> : null}
      </header>
      <div className="visual-container-children" data-page-footer-row={autoFooter ? "true" : undefined} style={{ flexDirection: node.type === "row" ? "row" : "column", gap: `${node.gap ?? 12}px` }}>
        {node.children.map((child, index) => {
          const content = renderNode(child);
          return content ? <Fragment key={child.id}>{dropzone(index)}<div className="visual-layout-child" data-footer-slot={autoFooter ? index + 2 : undefined} style={{ flexGrow: node.type === "row" ? node.weights?.[index] ?? 1 : 0, flexBasis: node.type === "row" ? 0 : "auto", ...(autoFooter ? { gridColumn: index + 2, gridRow: 1 } : {}) }}>{content}</div></Fragment> : null;
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
  return <div className="visual-page-editor" ref={editorRef}>
    <div className="visual-source-column">
      <div className="visual-source-actions"><button type="button" disabled={disabled || multiple || Boolean(sourceImage && geometryDisabled)} onClick={create}>Crear bloque</button>
        <label className="visual-check"><input type="checkbox" checked={multiple} disabled={disabled || Boolean(marking)} onChange={(event) => { setMultiple(event.target.checked); setSelection([]); setSelectionError(null); onSelect(null); }} />Seleccion multiple</label>
        {multiple ? <><span role="status">{selection.length} bloques seleccionados</span><button type="button" disabled={disabled || selection.length < 2} onClick={() => { const heading = selection.some((id) => doc.blocks.find((block) => block.id === id)?.kind === "heading"); setJoinContent({ kind: heading ? "heading" : "text", separator: heading ? "line" : "paragraph", includeInToc: heading, headingLevel: 1, alignment: heading ? "center" : "left" }); setJoinReading("preserve"); setJoining(true); }}>Unir seleccionados</button><button type="button" onClick={() => { setSelection([]); setSelectionError(null); }}>Limpiar seleccion</button></> : null}
      </div>
      {selectionError ? <p role="alert" className="error-text">{selectionError}</p> : null}
      {marking ? <p role="status">Arrastra un rectangulo sobre la imagen. <button type="button" onClick={() => setMarking(null)}>Cancelar marcado</button></p> : null}
      {source(overlay)}
      {!page.hasSourceImage ? <article className="visual-imported-source"><h3>Contenido importado</h3><p className="helper-text">HTML guardado, no es un facsimil. La creacion por geometria no esta disponible.</p>
        <div className="visual-imported-html" dangerouslySetInnerHTML={{ __html: replacePendingBookContentImageReferences(importedHtml ?? "") }} onClick={(event) => { event.preventDefault(); const element = (event.target as Element).closest("[data-visual-block-id],[data-paragraph-id]"); const id = element?.getAttribute("data-visual-block-id") ?? element?.getAttribute("data-paragraph-id"); if (id && doc.blocks.some((block) => block.id === id)) select(id, { ctrlKey: event.ctrlKey, metaKey: event.metaKey }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { const element = (event.target as Element).closest("[data-visual-block-id],[data-paragraph-id]"); const id = element?.getAttribute("data-visual-block-id") ?? element?.getAttribute("data-paragraph-id"); if (id) { event.preventDefault(); select(id, { ctrlKey: event.ctrlKey, metaKey: event.metaKey }); } } }} />
      </article> : null}
    </div>
    <article className="visual-preview-column" aria-label="Previsualizacion interactiva">
      <header><div><p className="page-label">Documento visual</p><h3>Previsualizacion interactiva</h3></div><div className="visual-actions"><button className="visual-icon-button" type="button" aria-label="Deshacer" title="Deshacer (Ctrl/Cmd+Z)" disabled={disabled || !canUndo} onClick={onUndo}><PreviewIcon name="undo" /></button><button className="visual-icon-button" type="button" aria-label="Rehacer" title="Rehacer (Ctrl/Cmd+Mayus+Z)" disabled={disabled || !canRedo} onClick={onRedo}><PreviewIcon name="redo" /></button></div></header>
      <div className="visual-preview-tools"><label>Distribucion<select defaultValue="" disabled={disabled} onChange={(event) => { onChange(applyVisualPreset(doc, event.target.value as VisualPreset)); event.target.value = ""; }}><option value="" disabled>Layout actual</option><option value="one-column">1 columna</option><option value="two-columns">2 columnas</option><option value="two-by-two">2 x 2</option><option value="rows">Fila horizontal</option></select></label>
        <button className="visual-icon-button" type="button" aria-label="Mostrar anulados" title={showInactive ? "Ocultar bloques anulados" : "Mostrar bloques anulados"} aria-pressed={showInactive} onClick={() => setShowInactive((current) => !current)}><PreviewIcon name="inactive" /></button>
      </div>
      <p className="helper-text">Selecciona para editar. Arrastra desde el asa a una zona o usa Mover a... en el inspector.</p>
      <div className="visual-preview-canvas">{renderNode(doc.layout, true)}</div>
      {!order.some((block) => block.active) ? <p className="helper-text">No hay bloques activos. Activa Mostrar anulados para restaurarlos o crea uno nuevo.</p> : null}
    </article>
    {editing ? <VisualInspectorDialog simpleTypography={simpleTypography} doc={editing.doc} initialSelectedId={editing.id} sourceImage={editing.sourceImage} disabled={disabled} stale={doc !== editing.doc}
      geometryDisabled={geometryDisabled || sourceImage !== editing.sourceImage} onCancel={() => closeInspector()} onAccept={closeInspector} /> : null}
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
      }}>Unir contenido</button></div>
    </fieldset></EditorDialog> : null}
    {newBlock ? <EditorDialog title="Crear bloque" onClose={() => setNewBlock(null)}><fieldset disabled={disabled}>
      <label>Tipo<select aria-label="Tipo" value={newBlock.kind} onChange={(event) => { const kind = event.target.value as VisualBlock["kind"]; const next = createVisualBlock(kind, newBlock.geometry ?? null); setNewBlock({ ...next, id: newBlock.id }); }}><option value="text">Texto</option><option value="heading">Titulo</option><option value="image">Imagen</option></select></label>
      <label>{newBlock.kind === "image" ? "Descripcion" : "Contenido Markdown"}<textarea rows={5} value={newBlock.text} onChange={(event) => setNewBlock({ ...newBlock, text: event.target.value })} /></label>
      {newBlock.kind === "image" ? <VisualImageSourceFields block={newBlock} images={doc.blocks} onChange={(patch) => setNewBlock({ ...newBlock, ...patch })} /> : null}
      <p className="helper-text">El nuevo bloque conserva un UUID propio. Solo se persiste con Guardar cambios.</p>
      <div className="visual-actions"><button type="button" onClick={() => setNewBlock(null)}>Cancelar</button><button type="button" disabled={newBlock.kind === "image" ? !(safeVisualImageSource(newBlock.source) || newBlock.source === "page-crop" && validElementGeometry(newBlock.geometry)) : !newBlock.text.trim()} onClick={() => { onChange(appendVisualBlock(doc, newBlock)); onSelect(newBlock.id); setNewBlock(null); }}>Crear</button></div>
    </fieldset></EditorDialog> : null}
  </div>;
}
