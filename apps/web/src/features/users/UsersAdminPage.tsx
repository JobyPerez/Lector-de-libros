import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import { createManagedUser, deleteManagedUser, fetchCurrentUser, fetchUserActivity, fetchUsers, updateManagedUser, type ManagedUser, type UserActivityAction } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

const userRemovalExitAnimationMs = 280;

type UserFormState = {
  displayName: string;
  email: string;
  password: string;
  role: "ADMIN" | "EDITOR";
  username: string;
};

const emptyForm: UserFormState = {
  displayName: "",
  email: "",
  password: "",
  role: "EDITOR",
  username: ""
};

const activityLabels: Record<UserActivityAction, string> = {
  AI_REQUEST_CREATED: "Consultó a la IA",
  AI_REQUEST_DELETED: "Eliminó consulta IA",
  AUDIO_LISTENED: "Escuchó el libro",
  BOOK_CREATED: "Creó el libro",
  BOOK_DELETED: "Borró el libro",
  BOOK_EXPORTED: "Exportó el libro",
  BOOK_IMPORTED: "Importó el libro",
  BOOK_RATED: "Calificó el libro",
  BOOK_SHARED: "Compartió el libro",
  BOOK_STATUS_UPDATED: "Cambió estado de lectura",
  BOOK_TRANSFERRED: "Transfirió libro",
  BOOK_UNSHARED: "Dejó de compartir libro",
  BOOK_UPDATED: "Modificó el libro",
  BOOK_VIEWED: "Consultó el libro",
  BOOKMARK_CREATED: "Añadió marcador",
  BOOKMARK_DELETED: "Eliminó marcador",
  CHAPTER_SUMMARY_GENERATED: "Generó resumen de capítulo",
  HIGHLIGHT_CREATED: "Subrayó texto",
  HIGHLIGHT_DELETED: "Eliminó subrayado",
  LOGIN: "Inició sesión",
  LOGOUT: "Cerró sesión",
  NOTE_CREATED: "Añadió nota",
  NOTE_DELETED: "Eliminó nota",
  NOTE_UPDATED: "Modificó nota",
  OCR_UPDATED: "Modificó OCR de página",
  PAGE_DELETED: "Eliminó página",
  PAGE_IMAGE_ROTATED: "Rotó imagen de página",
  PAGE_IMAGE_UPDATED: "Actualizó imagen de página",
  PAGE_OCR_RERUN: "Reejecutó OCR de página",
  PAGES_IMPORTED: "Añadió páginas al libro",
  PASSWORD_RESET: "Restableció contraseña",
  PROFILE_UPDATED: "Actualizó perfil",
  USER_CREATED: "Creó usuario",
  USER_DELETED: "Eliminó usuario",
  USER_UPDATED: "Modificó usuario"
};

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  }
  return totalSeconds > 0 ? `${totalSeconds} s` : "Sin escucha";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Sin actividad";
  }
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function UsersAdminPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [asideMode, setAsideMode] = useState<"activity" | "form">("activity");
  const [searchTerm, setSearchTerm] = useState("");
  const [isMobileActivityOpen, setIsMobileActivityOpen] = useState(false);
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);

  const usersQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["users"],
    queryFn: async () => {
      if (!accessToken) {
        return [];
      }

      const response = await fetchUsers(accessToken);
      return response.users;
    }
  });

  const activityQuery = useQuery({
    enabled: Boolean(accessToken && selectedUserId && asideMode === "activity"),
    queryKey: ["user-activity", selectedUserId],
    queryFn: () => fetchUserActivity(accessToken!, selectedUserId!)
  });

  useEffect(() => {
    const users = usersQuery.data ?? [];
    if (users.length === 0) {
      setSelectedUserId(null);
      return;
    }
    if (!selectedUserId || !users.some((user) => user.userId === selectedUserId)) {
      setSelectedUserId(users[0]!.userId);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!isMobileActivityOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMobileActivity();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobileActivityOpen]);

  if (!accessToken || !currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (currentUser.role !== "ADMIN") {
    return <Navigate to="/" replace />;
  }

  const adminAccessToken = accessToken;
  const adminUser = currentUser;

  const totalAdmins = (usersQuery.data ?? []).filter((managedUser) => managedUser.role === "ADMIN").length;
  const totalEditors = (usersQuery.data ?? []).filter((managedUser) => managedUser.role === "EDITOR").length;
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const filteredUsers = (usersQuery.data ?? []).filter((managedUser) => !normalizedSearch
    || managedUser.username.toLocaleLowerCase().includes(normalizedSearch)
    || managedUser.email.toLocaleLowerCase().includes(normalizedSearch)
    || managedUser.displayName?.toLocaleLowerCase().includes(normalizedSearch));
  const selectedUser = (usersQuery.data ?? []).find((managedUser) => managedUser.userId === selectedUserId) ?? null;

  function resetForm() {
    setEditingUser(null);
    setForm(emptyForm);
    setAsideMode("activity");
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsMobileActivityOpen(false);
  }

  function startEditing(user: ManagedUser) {
    setEditingUser(user);
    setForm({
      displayName: user.displayName ?? "",
      email: user.email,
      password: "",
      role: user.role,
      username: user.username
    });
    setErrorMessage(null);
    setSuccessMessage(null);
    setSelectedUserId(user.userId);
    setAsideMode("form");
    setIsMobileActivityOpen(false);
  }

  function startCreating() {
    setEditingUser(null);
    setForm(emptyForm);
    setErrorMessage(null);
    setSuccessMessage(null);
    setAsideMode("form");
    setIsMobileActivityOpen(false);
  }

  function showActivity(user: ManagedUser, trigger: HTMLButtonElement) {
    activityTriggerRef.current = trigger;
    setSelectedUserId(user.userId);
    setEditingUser(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    setAsideMode("activity");
    setIsMobileActivityOpen(true);
  }

  function closeMobileActivity() {
    setIsMobileActivityOpen(false);
    window.requestAnimationFrame(() => activityTriggerRef.current?.focus());
  }

  async function refreshCurrentUserIfNeeded(userId: string) {
    if (adminUser.userId !== userId) {
      return;
    }

    const response = await fetchCurrentUser(adminAccessToken);
    useAuthStore.setState((previous) => ({ ...previous, user: response.user }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      if (editingUser) {
        await updateManagedUser(adminAccessToken, editingUser.userId, {
          email: form.email,
          role: form.role,
          ...(form.displayName ? { displayName: form.displayName } : {}),
          ...(form.password ? { password: form.password } : {})
        });

        await refreshCurrentUserIfNeeded(editingUser.userId);
        setSuccessMessage(`Se actualizó el usuario ${editingUser.username}.`);
      } else {
        await createManagedUser(adminAccessToken, {
          email: form.email,
          password: form.password,
          role: form.role,
          username: form.username,
          ...(form.displayName ? { displayName: form.displayName } : {})
        });

        setSuccessMessage(`Se creó el usuario ${form.username}.`);
        setForm(emptyForm);
      }

      await usersQuery.refetch();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo guardar el usuario.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(user: ManagedUser) {
    const confirmed = window.confirm(`Se borrará el usuario ${user.username} y todos sus datos asociados. ¿Continuar?`);

    if (!confirmed) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setDeletingUserId(user.userId);

    try {
      await deleteManagedUser(adminAccessToken, user.userId);

      if (editingUser?.userId === user.userId) {
        resetForm();
      }

      setRemovingUserId(user.userId);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, userRemovalExitAnimationMs);
      });
      await usersQuery.refetch();
      setSuccessMessage(`Se eliminó el usuario ${user.username}.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo eliminar el usuario.");
    } finally {
      setRemovingUserId(null);
      setDeletingUserId(null);
    }
  }

  return (
    <div className="page-grid maintenance-layout user-admin-layout">
      <section className="panel wide-panel">
        <div className="panel-header user-admin-heading">
          <div>
            <p className="eyebrow">Administración</p>
            <h2>Usuarios y actividad</h2>
            <p className="subdued">Gestiona las cuentas y consulta su uso de la aplicación.</p>
          </div>
          <button className="primary-button" onClick={startCreating} type="button">Crear usuario</button>
        </div>

        <div className="stats-strip user-overview-stats">
          <article><strong>{usersQuery.data?.length ?? 0}</strong><span>Usuarios</span></article>
          <article><strong>{totalAdmins}</strong><span>Administradores</span></article>
          <article><strong>{totalEditors}</strong><span>Editores</span></article>
        </div>

        <label className="user-search-field">
          <span>Buscar usuario</span>
          <input onChange={(event) => setSearchTerm(event.target.value)} placeholder="Nombre, usuario o correo" type="search" value={searchTerm} />
        </label>

        {usersQuery.isLoading ? <p className="subdued">Cargando usuarios...</p> : null}
        {usersQuery.isError ? <p className="error-text">No se pudo recuperar la lista de usuarios.</p> : null}
        {!usersQuery.isLoading && filteredUsers.length === 0 ? <p className="empty-user-state">No hay usuarios que coincidan con la búsqueda.</p> : null}

        <div className="user-list">
          {filteredUsers.map((managedUser) => {
            const isDeletingUser = deletingUserId === managedUser.userId;
            const removalState = removingUserId === managedUser.userId ? "exiting" : isDeletingUser ? "pending" : undefined;
            const isUserRemoving = removalState !== undefined;
            const isSelected = selectedUserId === managedUser.userId && asideMode === "activity";

            return (
              <article aria-busy={isUserRemoving} className="user-row" data-removing={removalState} data-selected={isSelected || undefined} key={managedUser.userId}>
                <div className="user-row-header">
                  <div>
                    <h3>{managedUser.displayName ?? managedUser.username}</h3>
                    <p className="subdued">@{managedUser.username} · {managedUser.email}</p>
                  </div>
                  <div className="user-row-tags">
                    <span className="role-pill">{managedUser.role === "ADMIN" ? "Administrador" : "Editor"}</span>
                    {managedUser.userId === adminUser.userId ? <span className="tag-chip">Tu cuenta</span> : null}
                  </div>
                </div>

                <div className="user-card-metrics">
                  <div><strong>{managedUser.totalBooks}</strong><span>propios</span></div>
                  <div><strong>{managedUser.listenedBooks}</strong><span>escuchados</span></div>
                  <div><strong>{formatDuration(Number(managedUser.listeningSeconds))}</strong><span>escucha</span></div>
                  <div><strong>{formatDate(managedUser.lastLoginAt)}</strong><span>última conexión</span></div>
                </div>

                <div className="user-card-footer">
                  <span className="subdued">Actividad: {formatDate(managedUser.lastActivityAt)}</span>
                  <div className="inline-actions">
                    <button className={isSelected ? "primary-button" : "secondary-button"} disabled={isUserRemoving} onClick={(event) => showActivity(managedUser, event.currentTarget)} type="button">Actividad</button>
                    <button className="text-button" disabled={isUserRemoving} onClick={() => startEditing(managedUser)} type="button">Editar</button>
                    <button className="danger-button" disabled={isUserRemoving} onClick={() => void handleDelete(managedUser)} type="button">Eliminar</button>
                  </div>
                </div>

                <div aria-hidden={!isUserRemoving} className="user-row-removing-badge">
                  <span className="user-row-removing-dot" />
                  {removalState === "exiting" ? "Retirando usuario..." : "Eliminando..."}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside
        className="panel form-panel sticky-panel user-detail-panel"
        data-mobile-open={isMobileActivityOpen || undefined}
        data-mode={asideMode}
      >
        {asideMode === "activity" ? (
          <>
            <div className="panel-header compact-header user-activity-header">
              <div>
                <p className="eyebrow">Seguimiento</p>
                <h2>{selectedUser ? selectedUser.displayName ?? selectedUser.username : "Actividad"}</h2>
                {selectedUser ? <p className="subdued">@{selectedUser.username}</p> : null}
              </div>
              <div className="activity-header-actions">
                <button
                  aria-label="Refrescar historial de actividad"
                  className="secondary-button refresh-activity-button"
                  disabled={activityQuery.isFetching}
                  onClick={() => void activityQuery.refetch()}
                  title="Refrescar historial de actividad"
                  type="button"
                >
                  <span aria-hidden="true" className={activityQuery.isFetching ? "spin-animation" : ""}>🔄</span>
                  <span>{activityQuery.isFetching ? "Refrescando..." : "Refrescar"}</span>
                </button>
                <button aria-label="Cerrar actividad" className="mobile-activity-close secondary-button" onClick={closeMobileActivity} type="button">
                  Volver a usuarios
                </button>
              </div>
            </div>

            {activityQuery.isLoading ? <p className="subdued">Cargando actividad...</p> : null}
            {activityQuery.isError ? <p className="error-text">No se pudo cargar el seguimiento del usuario.</p> : null}
            {activityQuery.data ? (
              <div className="user-activity-content">
                <section className="activity-section">
                  <div className="activity-section-header">
                    <h3>Historial de actividad</h3>
                    <span className="activity-count-badge">
                      {activityQuery.data.events.length} {activityQuery.data.events.length === 1 ? "evento" : "eventos"}
                    </span>
                  </div>

                  {activityQuery.data.events.length === 0 ? (
                    <p className="subdued empty-activity-state">No hay actividad registrada todavía para este usuario.</p>
                  ) : (
                    <ol className="activity-timeline">
                      {activityQuery.data.events.map((event) => (
                        <li data-action={event.action} key={event.activityId}>
                          <span className="activity-dot" />
                          <div className="activity-item-body">
                            <div className="activity-item-main">
                              <span className="activity-action-label">
                                {activityLabels[event.action] ?? event.action}
                              </span>
                              {event.bookTitle ? (
                                <strong className="activity-book-name">{event.bookTitle}</strong>
                              ) : null}
                            </div>

                            {(event.chapterTitle || typeof event.pageNumber === "number" || (event.action === "AUDIO_LISTENED" && event.durationSeconds) || event.detail) ? (
                              <div className="activity-details-row">
                                {typeof event.pageNumber === "number" ? (
                                  <span className="activity-pill activity-page-pill">
                                    Pág. {event.pageNumber}
                                  </span>
                                ) : null}
                                {event.chapterTitle ? (
                                  <span className="activity-pill activity-chapter-pill" title={event.chapterTitle}>
                                    {event.action === "AUDIO_LISTENED" ? `Capítulo: ${event.chapterTitle}` : event.chapterTitle}
                                  </span>
                                ) : null}
                                {event.action === "AUDIO_LISTENED" && event.durationSeconds ? (
                                  <span className="activity-pill activity-duration-pill">
                                    Duración: {formatDuration(Number(event.durationSeconds))}
                                  </span>
                                ) : null}
                                {event.detail ? (
                                  <span className="activity-pill activity-detail-pill" title={event.detail}>
                                    {event.detail}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="activity-meta-row">
                              <time className="activity-time" dateTime={event.createdAt}>
                                {formatDate(event.createdAt)}
                              </time>
                              {event.action === "LOGIN" && event.ipAddress ? (
                                <span className="activity-ip">IP: {event.ipAddress}</span>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="panel-header compact-header">
              <div>
                <p className="eyebrow">Cuenta</p>
                <h2>{editingUser ? `Editar ${editingUser.username}` : "Crear usuario"}</h2>
              </div>
              <button className="text-button" onClick={resetForm} type="button">Cancelar</button>
            </div>

            <form className="stack-form" onSubmit={handleSubmit}>
              <label>Nombre visible<input onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="Nombre del usuario" value={form.displayName} /></label>
              <label>Usuario<input disabled={Boolean(editingUser)} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} placeholder="usuario" required={!editingUser} value={form.username} /></label>
              <label>Correo electrónico<input onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="usuario@dominio.com" required type="email" value={form.email} /></label>
              <label>Rol<select onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as "ADMIN" | "EDITOR" }))} value={form.role}><option value="EDITOR">Editor</option><option value="ADMIN">Administrador</option></select></label>
              <label>{editingUser ? "Nueva contraseña" : "Contraseña"}<input minLength={8} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder={editingUser ? "Vacía para mantener la actual" : "Mínimo 8 caracteres"} required={!editingUser} type="password" value={form.password} /></label>
              <p className="helper-text">Los administradores gestionan usuarios. Los editores trabajan con los libros a los que tienen acceso.</p>
              {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
              {successMessage ? <p className="success-text">{successMessage}</p> : null}
              <button className="primary-button" disabled={isSubmitting} type="submit">{isSubmitting ? "Guardando..." : editingUser ? "Actualizar usuario" : "Crear usuario"}</button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
