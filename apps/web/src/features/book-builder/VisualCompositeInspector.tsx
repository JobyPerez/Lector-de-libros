import { useRef, useState } from "react";
import type { VisualBlock, VisualCompositeContent, VisualPageDocument } from "../../app/api";
import { flattenVisualLayout, moveVisualNode, reorderVisualBlock, separateVisualContent, updateVisualBlock, updateVisualNode, visualUnits, type VisualContainer } from "./visual-page";

function FragmentEditor({ block, index, onChange, onMark, geometryDisabled }: {
  block: VisualBlock; index: number; onChange: (patch: Partial<VisualBlock>) => void;
  onMark: () => void; geometryDisabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function format(marker: "**" | "*") {
    const editor = ref.current;
    if (!editor) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = block.text.slice(start, end) || "texto";
    onChange({ text: `${block.text.slice(0, start)}${marker}${selected}${marker}${block.text.slice(end)}` });
    requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(start + marker.length, start + marker.length + selected.length); });
  }
  return <section className="visual-composite-fragment">
    <label>Fragmento {index + 1}<textarea ref={ref} rows={4} value={block.text} onChange={(event) => onChange({ text: event.target.value })} /></label>
    <div className="visual-format" role="toolbar" aria-label={`Formato del fragmento ${index + 1}`}>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("**")} aria-label={`Negrita del fragmento ${index + 1}`}><strong>B</strong></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("*")} aria-label={`Cursiva del fragmento ${index + 1}`}><em>I</em></button>
      <label className="visual-check"><input type="checkbox" checked={block.readAloud} onChange={(event) => onChange({ readAloud: event.target.checked })} />Leer fragmento {index + 1}</label>
      <button type="button" disabled={geometryDisabled} onClick={onMark}>Marcar zona del fragmento {index + 1}</button>
    </div>
  </section>;
}

export function VisualCompositeInspector({ doc, node, onChange, onClose, onMarkGeometry, disabled, geometryDisabled }: {
  doc: VisualPageDocument; node: VisualContainer; onChange: (doc: VisualPageDocument) => void; onClose: () => void;
  onMarkGeometry: (id: string) => void; disabled: boolean; geometryDisabled: boolean;
}) {
  const [destination, setDestination] = useState("");
  const [position, setPosition] = useState(1);
  const content = node.content!;
  const members = node.children.flatMap((child) => child.type === "block" ? doc.blocks.filter((block) => block.id === child.blockId) : []);
  const units = visualUnits(doc);
  const number = units.findIndex((unit) => unit.id === node.id) + 1;
  const containers = flattenVisualLayout(doc.layout).filter((item): item is VisualContainer => item.type !== "block" && !item.content && !flattenVisualLayout(node).some((child) => child.id === item.id));
  const target = containers.find((item) => item.id === destination);
  function patch(patch: Partial<VisualCompositeContent>) {
    onChange({ ...doc, layout: updateVisualNode(doc.layout, node.id, (item) => ({ ...item, content: { ...content, ...patch } } as VisualContainer)) });
  }
  function bulk(patch: Partial<VisualBlock>) {
    const ids = new Set(members.map((member) => member.id));
    onChange({ ...doc, blocks: doc.blocks.map((block) => ids.has(block.id) ? { ...block, ...patch } : block) });
  }
  return <section className="visual-inspector" aria-label="Inspector del contenido unido">
    <header><h3>Bloque {number} unido ({members.length} fragmentos)</h3><button type="button" onClick={onClose}>Cerrar</button></header>
    <fieldset disabled={disabled}>
      <label>Tipo del bloque unido<select value={content.kind} onChange={(event) => patch({ kind: event.target.value as "text" | "heading", includeInToc: event.target.value === "heading" })}><option value="text">Cuerpo de texto</option><option value="heading">Titulo</option></select></label>
      <label>Separacion del contenido<select value={content.separator} onChange={(event) => patch({ separator: event.target.value as VisualCompositeContent["separator"] })}><option value="space">Espacio</option><option value="line">Salto de linea</option><option value="paragraph">Separacion de parrafos</option></select></label>
      <label>Numero / orden<input key={`${node.id}:${number}`} type="number" min={1} max={units.length} defaultValue={number} onBlur={(event) => onChange(reorderVisualBlock(doc, members[0]!.id, Number(event.target.value)))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      <label className="visual-check"><input type="checkbox" checked={members.every((member) => !member.active)} onChange={(event) => bulk({ active: !event.target.checked })} />Anular bloque unido</label>
      <label>Lectura del bloque<select value={members.every((member) => member.readAloud) ? "all" : members.every((member) => !member.readAloud) ? "none" : "mixed"} onChange={(event) => { if (event.target.value !== "mixed") bulk({ readAloud: event.target.value === "all" }); }}><option value="mixed">Preferencias por fragmento</option><option value="all">Leer todos</option><option value="none">No leer ninguno</option></select></label>
      {content.kind === "heading" ? <>
        <label>Nivel del titulo<select value={content.headingLevel ?? 1} onChange={(event) => patch({ headingLevel: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>T{level}</option>)}</select></label>
        <label className="visual-check"><input type="checkbox" checked={content.includeInToc} onChange={(event) => patch({ includeInToc: event.target.checked })} />Incluir en el indice</label>
      </> : null}
      <label>Alineacion<select value={content.alignment ?? "left"} onChange={(event) => patch({ alignment: event.target.value as "left" | "center" | "right" })}><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></label>
      <label>Escala de fuente: {content.fontScale ?? 1}<input type="range" min={0.5} max={3} step={0.05} value={content.fontScale ?? 1} onChange={(event) => patch({ fontScale: Number(event.target.value) })} /></label>
      <p className="helper-text">Una sola unidad visual. Los textos, zonas y preferencias originales se conservan por fragmento.</p>
      {members.map((member, index) => <FragmentEditor key={member.id} block={member} index={index} onChange={(patch) => onChange(updateVisualBlock(doc, member.id, patch))} onMark={() => onMarkGeometry(member.id)} geometryDisabled={geometryDisabled} />)}
      <button type="button" onClick={() => { onChange(separateVisualContent(doc, node.id)); onClose(); }}>Separar contenido</button>
      {node.id !== doc.layout.id ? <div className="visual-move-controls">
        <label>Mover bloque unido a...<select value={target?.id ?? ""} onChange={(event) => { setDestination(event.target.value); setPosition(1); }}><option value="">Elegir destino</option>{containers.map((container, index) => <option key={container.id} value={container.id}>{container.id === doc.layout.id ? "Raiz" : `${container.type === "row" ? "Fila" : "Columna"} ${index + 1}`}</option>)}</select></label>
        <label>Posicion en el destino<input type="number" min={1} max={(target?.children.length ?? 0) + 1} value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
        <button type="button" disabled={!target || !Number.isFinite(position)} onClick={() => { if (target) onChange(moveVisualNode(doc, node.id, target.id, position - 1)); }}>Mover</button>
      </div> : null}
    </fieldset>
  </section>;
}
