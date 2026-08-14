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
  BOOK_CREATED: "Creó el libro",
  BOOK_DELETED: "Borró el libro",
  BOOK_UPDATED: "Modificó el libro",
  BOOK_VIEWED: "Consultó el libro",
  LOGIN: "Inició sesión"
};

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  return totalSeconds > 0 ? `${totalSeconds} s` : "Sin escucha";
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Sin actividad";
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
  const activeUsers = (usersQuery.data ?? []).filter((managedUser) => managedUser.lastActivityAt).length;
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
          <article><strong>{activeUsers}</strong><span>Con actividad</span></article>
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
              <button aria-label="Cerrar actividad" className="mobile-activity-close secondary-button" onClick={closeMobileActivity} type="button">
                Volver a usuarios
              </button>
            </div>

            {activityQuery.isLoading ? <p className="subdued">Cargando actividad...</p> : null}
            {activityQuery.isError ? <p className="error-text">No se pudo cargar el seguimiento del usuario.</p> : null}
            {activityQuery.data ? (
              <div className="user-activity-content">
                <div className="activity-summary-grid">
                  <article><strong>{activityQuery.data.summary.totalLogins}</strong><span>Conexiones</span></article>
                  <article><strong>{activityQuery.data.summary.booksViewed}</strong><span>Consultas</span></article>
                  <article><strong>{activityQuery.data.summary.booksCreated}</strong><span>Creados</span></article>
                  <article><strong>{activityQuery.data.summary.booksUpdated}</strong><span>Modificados</span></article>
                  <article><strong>{activityQuery.data.summary.booksDeleted}</strong><span>Borrados</span></article>
                  <article><strong>{formatDuration(Number(activityQuery.data.summary.listeningSeconds))}</strong><span>Escucha</span></article>
                </div>

                <section className="activity-section">
                  <h3>Escucha por libro</h3>
                  {activityQuery.data.books.length === 0 ? <p className="subdued">Todavía no hay tiempo de escucha registrado.</p> : (
                    <div className="reading-book-list">
                      {activityQuery.data.books.map((book) => (
                        <article key={book.bookId}>
                          <div><strong>{book.bookTitle}</strong><span>{book.sessionCount} {book.sessionCount === 1 ? "sesión" : "sesiones"}</span></div>
                          <div><strong>{formatDuration(Number(book.listeningSeconds))}</strong><span>{formatDate(book.lastListenedAt)}</span></div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="activity-section">
                  <h3>Historial reciente</h3>
                  {activityQuery.data.events.length === 0 ? <p className="subdued">No hay eventos registrados todavía.</p> : (
                    <ol className="activity-timeline">
                      {activityQuery.data.events.map((event) => (
                        <li data-action={event.action} key={event.activityId}>
                          <span className="activity-dot" />
                          <div>
                            <strong>{activityLabels[event.action]}</strong>
                            {event.bookTitle ? <span>{event.bookTitle}</span> : null}
                            <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                            {event.action === "LOGIN" && event.ipAddress ? <small>IP {event.ipAddress}</small> : null}
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
