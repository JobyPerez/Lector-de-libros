import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate } from "react-router-dom";

import { createManagedUser, deleteManagedUser, fetchCurrentUser, fetchUsers, updateManagedUser, type ManagedUser } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

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

export function UsersAdminPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  function resetForm() {
    setEditingUser(null);
    setForm(emptyForm);
    setErrorMessage(null);
    setSuccessMessage(null);
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

    try {
      await deleteManagedUser(adminAccessToken, user.userId);

      if (editingUser?.userId === user.userId) {
        resetForm();
      }

      setSuccessMessage(`Se eliminó el usuario ${user.username}.`);
      await usersQuery.refetch();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo eliminar el usuario.");
    }
  }

  return (
    <div className="page-grid maintenance-layout">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Administración</p>
            <h2>Mantenimiento de usuarios</h2>
          </div>
        </div>

        <div className="stats-strip">
          <article>
            <strong>{usersQuery.data?.length ?? 0}</strong>
            <span>Usuarios totales</span>
          </article>
          <article>
            <strong>{totalAdmins}</strong>
            <span>Administradores</span>
          </article>
          <article>
            <strong>{totalEditors}</strong>
            <span>Editores</span>
          </article>
        </div>

        {usersQuery.isLoading ? <p className="subdued">Cargando usuarios...</p> : null}
        {usersQuery.isError ? <p className="error-text">No se pudo recuperar la lista de usuarios.</p> : null}

        <div className="user-list">
          {(usersQuery.data ?? []).map((managedUser) => (
            <article className="user-row" key={managedUser.userId}>
              <div className="user-row-header">
                <div>
                  <h3>{managedUser.displayName ?? managedUser.username}</h3>
                  <p className="subdued">{managedUser.email}</p>
                </div>
                <div className="user-row-tags">
                  <span className="role-pill">{managedUser.role === "ADMIN" ? "Administrador" : "Editor"}</span>
                  {managedUser.userId === adminUser.userId ? <span className="tag-chip">Tu cuenta</span> : null}
                </div>
              </div>

              <dl className="meta-list compact-meta">
                <div>
                  <dt>Usuario</dt>
                  <dd>{managedUser.username}</dd>
                </div>
                <div>
                  <dt>Libros</dt>
                  <dd>{managedUser.totalBooks}</dd>
                </div>
                <div>
                  <dt>Actualizado</dt>
                  <dd>{new Date(managedUser.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>

              <div className="inline-actions">
                <button className="secondary-button" onClick={() => startEditing(managedUser)} type="button">
                  Editar
                </button>
                <button className="danger-button" onClick={() => void handleDelete(managedUser)} type="button">
                  Eliminar
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside className="panel form-panel sticky-panel">
        <div className="panel-header compact-header">
          <div>
            <p className="eyebrow">Formulario</p>
            <h2>{editingUser ? `Editar ${editingUser.username}` : "Crear usuario"}</h2>
          </div>
          {editingUser ? (
            <button className="text-button" onClick={resetForm} type="button">
              Nuevo usuario
            </button>
          ) : null}
        </div>

        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            Nombre visible
            <input
              onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="Nombre del usuario"
              value={form.displayName}
            />
          </label>

          <label>
            Usuario
            <input
              disabled={Boolean(editingUser)}
              onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
              placeholder="usuario"
              required={!editingUser}
              value={form.username}
            />
          </label>

          <label>
            Correo electrónico
            <input
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              placeholder="usuario@dominio.com"
              required
              type="email"
              value={form.email}
            />
          </label>

          <label>
            Rol
            <select
              onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as "ADMIN" | "EDITOR" }))}
              value={form.role}
            >
              <option value="EDITOR">Editor</option>
              <option value="ADMIN">Administrador</option>
            </select>
          </label>

          <label>
            {editingUser ? "Nueva contraseña" : "Contraseña"}
            <input
              minLength={8}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              placeholder={editingUser ? "Déjala vacía para mantener la actual" : "Mínimo 8 caracteres"}
              required={!editingUser}
              type="password"
              value={form.password}
            />
          </label>

          <p className="helper-text">
            Los administradores pueden mantener usuarios. Los editores sólo trabajan con su biblioteca.
          </p>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          {successMessage ? <p className="success-text">{successMessage}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Guardando..." : editingUser ? "Actualizar usuario" : "Crear usuario"}
          </button>
        </form>
      </aside>
    </div>
  );
}