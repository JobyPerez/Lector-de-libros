import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { createBookComment, deleteBookComment, fetchAnnotationShareUsers, fetchBookComments, updateBookComment, updateBookCommentShares, type BookComment, type BookCommentContent } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { formatExactDate, formatRelativeDate } from "../../app/date-format";
import { AnnotationShareEditor } from "../../components/AnnotationShareEditor";
import { DeletePageIcon, EditIcon, ShareIcon } from "./ReaderAnnotationIcons";
import { SortableNotesList } from "./SortableNotesList";

export function useBookComments(bookId: string) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const userId = useAuthStore((state) => state.user?.userId);
  return useQuery({
    queryKey: ["book-comments", userId, bookId],
    enabled: Boolean(accessToken && bookId),
    queryFn: () => fetchBookComments(accessToken!, bookId)
  });
}

export function BookCommentsCount({ bookId }: { bookId: string }) {
  const query = useBookComments(bookId);
  return <span className="reader-navigation-tab-count">{query.data ? query.data.comments.length : query.isError ? "—" : "…"}</span>;
}

export function CommentEditor({ initialValue, isSaving, onSave, onCancel }: {
  initialValue: BookCommentContent;
  isSaving: boolean;
  onSave: (value: BookCommentContent) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialValue.title);
  const [commentText, setCommentText] = useState(initialValue.commentText);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();
  const canSave = Boolean(title.trim() || commentText.trim());

  return (
    <form className="reader-comment-editor" onSubmit={(event) => {
      event.preventDefault();
      if (!canSave || isSaving) return;
      setError(null);
      void onSave({ title: title.trim(), commentText: commentText.trim() }).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : "No se pudo guardar el comentario.");
      });
    }}>
      <label className="reader-note-composer compact">
        <span>Título</span>
        <input aria-describedby={helpId} disabled={isSaving} maxLength={300} onChange={(event) => setTitle(event.target.value)} value={title} />
      </label>
      <label className="reader-note-composer compact">
        <span>Comentario</span>
        <textarea aria-describedby={helpId} disabled={isSaving} maxLength={10000} onChange={(event) => setCommentText(event.target.value)} rows={5} value={commentText} />
      </label>
      <p className="helper-text" id={helpId}>Rellena el título, el comentario o ambos.</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="reader-note-editor-actions">
        <button className="secondary-button" disabled={isSaving} onClick={onCancel} type="button">Cancelar</button>
        <button className="primary-button" disabled={isSaving || !canSave} type="submit">{isSaving ? "Guardando..." : "Guardar comentario"}</button>
      </div>
    </form>
  );
}

export function BookCommentsPanel({ bookId }: { bookId: string }) {
  const commentsQuery = useBookComments(bookId);
  const accessToken = useAuthStore((state) => state.accessToken);
  const userId = useAuthStore((state) => state.user?.userId);
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const usersQuery = useQuery({
    queryKey: ["annotation-share-users", bookId],
    enabled: Boolean(accessToken && bookId),
    queryFn: async () => (await fetchAnnotationShareUsers(accessToken!, bookId)).users
  });
  const sharableUsers = usersQuery.data ?? [];
  const canComment = commentsQuery.data?.canComment ?? false;
  const comments = commentsQuery.data?.comments ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["book-comments", userId, bookId] });

  async function saveComment(value: BookCommentContent) {
    if (!accessToken || isSaving) return;
    setIsSaving(true);
    try {
      if (editingId === "new") await createBookComment(accessToken, bookId, value);
      else if (editingId) await updateBookComment(accessToken, bookId, editingId, value);
      setEditingId(null);
      await refresh();
    } finally { setIsSaving(false); }
  }

  async function removeComment(comment: BookComment) {
    if (!accessToken || deletingId) return;
    if (!window.confirm(comment.isOwnedByCurrentUser
      ? "¿Borrar este comentario? Esta acción no se puede deshacer."
      : "¿Quitar este comentario compartido? El comentario original no se borrará.")) return;
    setDeletingId(comment.commentId);
    setError(null);
    try {
      await deleteBookComment(accessToken, bookId, comment.commentId);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo borrar el comentario.");
    } finally { setDeletingId(null); }
  }

  if (commentsQuery.isPending) return <p role="status">Cargando comentarios...</p>;
  if (commentsQuery.isError) return <div role="alert"><p className="error-text">No se pudieron cargar los comentarios.</p><button onClick={() => void commentsQuery.refetch()} type="button">Reintentar</button></div>;

  return (
    <>
      <div className="reader-navigation-section-heading">
        <strong>Comentarios del libro</strong>
        <div className="reader-navigation-section-actions">
          <span>{comments.length}</span>
          {canComment ? <button className="secondary-button" disabled={editingId !== null} onClick={() => { setError(null); setEditingId("new"); }} type="button">Añadir comentario</button> : null}
        </div>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {usersQuery.isError ? <p className="error-text" role="alert">No se pudieron cargar los destinatarios para compartir. <button onClick={() => void usersQuery.refetch()} type="button">Reintentar</button></p> : null}
      {editingId === "new" ? <CommentEditor initialValue={{ title: "", commentText: "" }} isSaving={isSaving} key="new" onCancel={() => setEditingId(null)} onSave={saveComment} /> : null}
      {!comments.length ? <p className="reader-navigation-empty">Todavía no hay comentarios sobre este libro.</p> : null}
      {comments.length ? <SortableNotesList
        bookId={bookId} scope="comments" disabled={editingId !== null || deletingId !== null}
        items={comments.map((comment) => ({ ...comment, key: `comment:${comment.commentId}` }))}
        renderItem={(comment, dragHandle) => {
          const isOwned = comment.isOwnedByCurrentUser;
          const isEditing = editingId === comment.commentId;
          const isShareOpen = shareId === comment.commentId;
          const isShared = comment.sharedWithUserIds.length > 0;
          const canShare = isOwned && canComment && sharableUsers.length > 0;
          const shareEditorId = `${panelId}-share-${comment.commentId}`;
          return (
            <article className="reader-note-card reader-book-comment-card" key={comment.commentId}>
              {dragHandle}
              {isEditing ? <CommentEditor initialValue={comment} isSaving={isSaving} key={comment.commentId} onCancel={() => setEditingId(null)} onSave={saveComment} /> : <>
                {comment.title ? <h4>{comment.title}</h4> : null}
                {comment.commentText ? <p className="reader-book-comment-text">{comment.commentText}</p> : null}
              </>}
              <div className="reader-navigation-note-meta">
                {!isOwned ? <span>Compartido por {comment.userDisplayName || `@${comment.username}`} · Solo lectura · </span> : null}
                <span title={formatExactDate(comment.createdAt) ?? undefined}>{formatRelativeDate(comment.createdAt)}</span>
              </div>
              <div className="reader-note-actions">
                {canShare ? <button
                  aria-controls={shareEditorId} aria-expanded={isShareOpen}
                  aria-label={isShareOpen ? "Cerrar opciones para compartir comentario" : isShared ? `Compartido con ${comment.sharedWithUserIds.length} persona(s)` : "Compartir comentario (Privado)"}
                  className={`reader-note-icon-button reader-postit-share-btn ${isShared ? "shared" : ""} ${isShareOpen ? "active" : ""}`}
                  onClick={() => setShareId(isShareOpen ? null : comment.commentId)}
                  title={isShared ? `Compartido con ${comment.sharedWithUserIds.length} persona(s)` : "Compartir comentario (Privado)"}
                  type="button"
                ><ShareIcon />{isShared ? <span aria-hidden="true" className="reader-share-badge">{comment.sharedWithUserIds.length}</span> : null}</button> : null}
                {isOwned && canComment ? <button aria-label="Editar comentario" title="Editar comentario" className="reader-note-icon-button" disabled={editingId !== null} onClick={() => setEditingId(comment.commentId)} type="button"><EditIcon /></button> : null}
                {isOwned || comment.visibilitySource === "DIRECT" ? <button
                  aria-label={deletingId === comment.commentId ? "Quitando comentario..." : isOwned ? "Borrar comentario" : "Quitar comentario compartido"}
                  title={isOwned ? "Borrar comentario" : "Quitar de mis comentarios"}
                  className="reader-note-delete" disabled={deletingId !== null || isEditing} onClick={() => void removeComment(comment)} type="button"
                >{deletingId === comment.commentId ? <span aria-hidden="true" className="reader-bookmark-delete-spinner" /> : <DeletePageIcon />}</button> : null}
              </div>
              {canShare && isShareOpen ? <AnnotationShareEditor
                currentShares={comment.sharedWithUserIds} id={shareEditorId}
                onUpdateShares={async (userIds) => { await updateBookCommentShares(accessToken!, bookId, comment.commentId, userIds); await refresh(); }}
                privateLabel="Este comentario solo lo verás tú (Privado)." sharableUsers={sharableUsers}
              /> : null}
            </article>
          );
        }}
      /> : null}
    </>
  );
}
