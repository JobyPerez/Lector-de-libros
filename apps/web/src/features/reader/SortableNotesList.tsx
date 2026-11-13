import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAnnotationOrder, saveAnnotationOrder } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { applyAnnotationOrder, moveAnnotation } from "./annotation-order";

export function SortableNotesList<T extends { key: string }>({ bookId, items, renderItem, scope = "notes", disabled = false }: {
  bookId: string;
  items: T[];
  renderItem: (item: T, dragHandle?: ReactNode) => ReactNode;
  scope?: "notes" | "comments";
  disabled?: boolean;
}) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const userId = useAuthStore((state) => state.user?.userId);
  const queryClient = useQueryClient();
  const queryKey = ["annotation-order", userId, bookId, scope];
  const orderQuery = useQuery({ queryKey, enabled: Boolean(accessToken && bookId), queryFn: () => fetchAnnotationOrder(accessToken!, bookId, scope) });
  const [pendingKeys, setPendingKeys] = useState<string[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const drag = useRef<{ key: string; target: string; pointerId: number; startY: number; moved: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const ordered = applyAnnotationOrder(items, pendingKeys ?? orderQuery.data?.keys ?? []);
  const canMove = Boolean(accessToken && orderQuery.isSuccess && !isSaving && !disabled && ordered.length > 1);
  const itemLabel = scope === "comments" ? "comentario" : "nota";

  async function move(source: string, target: string) {
    if (!accessToken || savingRef.current || source === target) return;
    const next = moveAnnotation(ordered, source, target);
    if (next === ordered) return;
    const keys = next.map((item) => item.key);
    savingRef.current = true;
    setPendingKeys(keys);
    setIsSaving(true);
    setError(null);
    try {
      await saveAnnotationOrder(accessToken, bookId, keys, scope);
      queryClient.setQueryData(queryKey, { keys });
      setAnnouncement(`${scope === "comments" ? "Comentario movido" : "Nota movida"} a la posición ${keys.indexOf(source) + 1} de ${keys.length}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo guardar el orden.");
    } finally {
      setPendingKeys(null);
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <>
      {scope === "notes" ? <p className="helper-text">Arrastra el asa de cada nota para ordenarla. También puedes usar las flechas ↑ y ↓ sobre el asa. El orden es personal.</p> : null}
      {orderQuery.isError ? <p className="error-text" role="alert">No se pudo cargar el orden guardado. <button onClick={() => void orderQuery.refetch()} type="button">Reintentar</button></p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <span aria-live="polite" className="reader-note-order-status">{isSaving ? "Guardando orden..." : announcement}</span>
      <div className={`reader-navigation-list ${scope === "comments" ? "reader-navigation-comments-list" : "reader-navigation-notes-list"}`} ref={listRef}>
        {ordered.map((item, index) => {
          const dragHandle = <button
              aria-label={`Mover ${itemLabel} ${index + 1} de ${ordered.length}`}
              className="reader-note-drag-handle"
              disabled={!canMove}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const target = ordered[index + (event.key === "ArrowUp" ? -1 : 1)];
                if (target) void move(item.key, target.key);
              }}
              onPointerDown={(event) => {
                if (!canMove || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { key: item.key, target: item.key, pointerId: event.pointerId, startY: event.clientY, moved: false };
                setDragKey(item.key);
              }}
              onPointerMove={(event) => {
                const state = drag.current;
                if (!state || state.pointerId !== event.pointerId) return;
                if (Math.abs(event.clientY - state.startY) > 5) state.moved = true;
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-note-order-key]");
                if (target && listRef.current?.contains(target)) {
                  state.target = target.dataset.noteOrderKey!;
                  setTargetKey(state.target);
                }
                const panel = listRef.current?.closest<HTMLElement>(".reader-navigation-panel");
                const bounds = panel?.getBoundingClientRect();
                if (panel && bounds) {
                  if (event.clientY > bounds.bottom - 65) panel.scrollBy(0, 16);
                  else if (event.clientY < bounds.top + 65) panel.scrollBy(0, -16);
                }
              }}
              onPointerUp={(event) => {
                const state = drag.current;
                if (!state || state.pointerId !== event.pointerId) return;
                drag.current = null;
                setDragKey(null);
                setTargetKey(null);
                if (state.moved) void move(state.key, state.target);
              }}
              onLostPointerCapture={() => { drag.current = null; setDragKey(null); setTargetKey(null); }}
              onPointerCancel={() => { drag.current = null; setDragKey(null); setTargetKey(null); }}
              title="Arrastrar para ordenar (o usar las flechas arriba y abajo)"
              type="button"
            >⠿</button>;
          return (
            <div className={`reader-sortable-note ${scope === "comments" ? "reader-sortable-comment" : ""} ${dragKey === item.key ? "is-dragging" : ""} ${targetKey === item.key && targetKey !== dragKey ? "is-drop-target" : ""}`} data-note-order-key={item.key} key={item.key}>
              {scope === "notes" ? dragHandle : null}
              {renderItem(item, scope === "comments" ? dragHandle : undefined)}
            </div>
          );
        })}
      </div>
    </>
  );
}
