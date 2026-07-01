import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  addBookShare,
  fetchBookShares,
  fetchSharabableUsers,
  leaveBookShare,
  removeBookShare,
  setShareUserAnnotations,
  transferBookOwnership,
  updateBookShare,
  type BookRole,
  type BookShare,
  type BookSummary,
  type ShareRole,
  type SharableUser
} from "../../app/api";

type ShareBookModalProps = {
  accessToken: string;
  book: BookSummary;
  currentUserRole: BookRole;
  onClose: () => void;
};

const SHARE_ROLES: { description: string; label: string; value: ShareRole }[] = [
  { description: "Solo lectura. Puede escuchar el audio.", label: "Lector", value: "viewer" },
  { description: "Puede añadir notas y marcadores propios.", label: "Comentarista", value: "commenter" },
  { description: "Puede editar páginas, añadir o borrar contenido.", label: "Editor", value: "editor" }
];

export function ShareBookModal({ accessToken, book, currentUserRole, onClose }: ShareBookModalProps) {
  const queryClient = useQueryClient();
  const isOwner = currentUserRole === "OWNER";
  const [selectedUserId, setSelectedUserId] = useState("");
  const [newRole, setNewRole] = useState<ShareRole>("commenter");
  const [transferUsername, setTransferUsername] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const sharesQuery = useQuery({
    enabled: isOwner,
    queryFn: async () => {
      const response = await fetchBookShares(accessToken, book.bookId);
      return response.shares;
    },
    queryKey: ["book-shares", book.bookId]
  });

  const usersQuery = useQuery({
    enabled: isOwner,
    queryFn: async () => {
      const response = await fetchSharabableUsers(accessToken, book.bookId);
      return response.users;
    },
    queryKey: ["book-sharable-users", book.bookId]
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["book-shares", book.bookId] });
    void queryClient.invalidateQueries({ queryKey: ["book-sharable-users", book.bookId] });
    void queryClient.invalidateQueries({ queryKey: ["book", book.bookId] });
    void queryClient.invalidateQueries({ queryKey: ["books"] });
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUserId) {
        throw new Error("Selecciona un usuario de la lista.");
      }
      return addBookShare(accessToken, book.bookId, { role: newRole, userId: selectedUserId });
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo compartir."),
    onSuccess: () => {
      setSelectedUserId("");
      setActionMessage("Usuario añadido.");
      setActionError(null);
      invalidate();
    }
  });

  const updateMutation = useMutation({
    mutationFn: async (input: { role: ShareRole; userId: string }) =>
      updateBookShare(accessToken, book.bookId, input.userId, { role: input.role }),
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo actualizar el rol."),
    onSuccess: () => {
      setActionMessage("Rol actualizado.");
      setActionError(null);
      invalidate();
    }
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => removeBookShare(accessToken, book.bookId, userId),
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo revocar el acceso."),
    onSuccess: () => {
      setActionMessage("Acceso revocado.");
      setActionError(null);
      invalidate();
    }
  });

  const leaveMutation = useMutation({
    mutationFn: async () => leaveBookShare(accessToken, book.bookId),
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo salir del libro."),
    onSuccess: () => {
      invalidate();
      onClose();
    }
  });

  const shareAnnotationsMutation = useMutation({
    mutationFn: async (enabled: boolean) => setShareUserAnnotations(accessToken, book.bookId, enabled),
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo cambiar la opción."),
    onSuccess: (response) => {
      setActionMessage(response.shareUserAnnotations
        ? "Tus notas y marcadores ahora son visibles para los usuarios con acceso."
        : "Tus notas y marcadores vuelven a ser privados.");
      setActionError(null);
      invalidate();
    }
  });

  const transferMutation = useMutation({
    mutationFn: async () => transferBookOwnership(accessToken, book.bookId, transferUsername),
    onError: (error) => setActionError(error instanceof Error ? error.message : "No se pudo transferir la propiedad."),
    onSuccess: () => {
      setActionMessage("Propiedad transferida.");
      setActionError(null);
      setShowTransfer(false);
      setTransferUsername("");
      invalidate();
    }
  });

  const availableUsers = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUserId) {
      setActionError("Selecciona un usuario de la lista.");
      return;
    }
    addMutation.mutate();
  }

  function handleTransferSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transferUsername.trim()) {
      setActionError("Introduce el nombre de usuario del nuevo propietario.");
      return;
    }
    transferMutation.mutate();
  }

  return (
    <div aria-labelledby="share-book-title" aria-modal="true" className="share-modal-backdrop" role="dialog">
      <section className="share-modal">
        <header className="share-modal-header">
          <p className="eyebrow">Compartir libro</p>
          <h2 id="share-book-title">{book.title}</h2>
          <button aria-label="Cerrar" className="share-modal-close" onClick={onClose} type="button">
            ✕
          </button>
        </header>

        {actionError ? <p className="error-text" role="alert">{actionError}</p> : null}
        {actionMessage ? <p className="share-modal-message">{actionMessage}</p> : null}

        {isOwner ? (
          <>
            <form className="share-modal-add-form" onSubmit={handleSubmit}>
              <label className="share-modal-label" htmlFor="share-user-select">Añadir usuario</label>
              <div className="share-modal-add-row">
                <select
                  className="text-input"
                  disabled={usersQuery.isLoading}
                  id="share-user-select"
                  onChange={(event) => setSelectedUserId(event.target.value)}
                  value={selectedUserId}
                >
                  <option value="">
                    {usersQuery.isLoading
                      ? "Cargando usuarios..."
                      : availableUsers.length === 0
                        ? "No hay más usuarios para añadir"
                        : "Selecciona un usuario"}
                  </option>
                  {availableUsers.map((user: SharableUser) => (
                    <option
                      disabled={Boolean(user.role)}
                      key={user.userId}
                      value={user.userId}
                    >
                      @{user.username}
                      {user.displayName ? ` · ${user.displayName}` : ""}
                      {user.role ? " (ya compartido)" : ""}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Rol del nuevo usuario"
                  className="text-input"
                  onChange={(event) => setNewRole(event.target.value as ShareRole)}
                  value={newRole}
                >
                  {SHARE_ROLES.map((role) => (
                    <option key={role.value} value={role.value}>{role.label}</option>
                  ))}
                </select>
                <button
                  className="primary-button"
                  disabled={addMutation.isPending || !selectedUserId}
                  type="submit"
                >
                  {addMutation.isPending ? "Añadiendo..." : "Compartir"}
                </button>
              </div>
              <p className="subdued">
                {SHARE_ROLES.find((role) => role.value === newRole)?.description}
              </p>
            </form>

            <section className="share-modal-annotations">
              <label className="share-modal-toggle">
                <input
                  checked={Boolean(book.shareUserAnnotations)}
                  onChange={(event) => shareAnnotationsMutation.mutate(event.target.checked)}
                  type="checkbox"
                />
                <span>Mostrar mis notas y marcadores a todos los usuarios con acceso al libro</span>
              </label>
              <p className="subdued">
                Si está desactivado, puedes compartir cada nota o marcador con usuarios concretos al crearlos.
              </p>
            </section>

            <section className="share-modal-list">
              <h3>Usuarios con acceso</h3>
              {sharesQuery.isLoading ? <p className="subdued">Cargando...</p> : null}
              {sharesQuery.data?.length === 0 ? (
                <p className="subdued">Aún no has compartido este libro.</p>
              ) : null}
              <ul className="share-modal-share-list">
                {sharesQuery.data?.map((share) => (
                  <ShareRow
                    disabled={updateMutation.isPending || removeMutation.isPending}
                    key={share.userId}
                    onChangeRole={(role) => updateMutation.mutate({ role, userId: share.userId })}
                    onRemove={() => removeMutation.mutate(share.userId)}
                    share={share}
                  />
                ))}
              </ul>
            </section>

            <section className="share-modal-transfer">
              {showTransfer ? (
                <form className="share-modal-add-form" onSubmit={handleTransferSubmit}>
                  <label className="share-modal-label" htmlFor="transfer-username">Transferir propiedad a</label>
                  <div className="share-modal-add-row">
                    <input
                      className="text-input"
                      id="transfer-username"
                      maxLength={50}
                      onChange={(event) => setTransferUsername(event.target.value)}
                      placeholder="nuevo_propietario"
                      value={transferUsername}
                    />
                    <button
                      className="primary-button"
                      disabled={transferMutation.isPending}
                      type="submit"
                    >
                      {transferMutation.isPending ? "Transfiriendo..." : "Transferir"}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setShowTransfer(false)}
                      type="button"
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  className="secondary-button"
                  onClick={() => setShowTransfer(true)}
                  type="button"
                >
                  Transferir propiedad a otro usuario
                </button>
              )}
            </section>
          </>
        ) : (
          <section className="share-modal-info">
            <p>
              Estás accediendo a este libro como <strong>{labelForRole(currentUserRole)}</strong>.
              {book.ownerUsername ? <> Propietario: <strong>@{book.ownerUsername}</strong>.</> : null}
            </p>
            <button
              className="secondary-button"
              disabled={leaveMutation.isPending}
              onClick={() => leaveMutation.mutate()}
              type="button"
            >
              {leaveMutation.isPending ? "Saliendo..." : "Salir de este libro"}
            </button>
          </section>
        )}
      </section>
    </div>
  );
}

function labelForRole(role: BookRole): string {
  if (role === "EDITOR") return "Editor";
  if (role === "COMMENTER") return "Comentarista";
  if (role === "VIEWER") return "Lector";
  return "Propietario";
}

type ShareRowProps = {
  disabled: boolean;
  onChangeRole: (role: ShareRole) => void;
  onRemove: () => void;
  share: BookShare;
};

function ShareRow({ disabled, onChangeRole, onRemove, share }: ShareRowProps) {
  return (
    <li className="share-modal-share-row">
      <div className="share-modal-share-user">
        <strong>@{share.username}</strong>
        {share.displayName ? <span className="subdued"> · {share.displayName}</span> : null}
      </div>
      <select
        aria-label={`Rol de ${share.username}`}
        className="text-input"
        disabled={disabled}
        onChange={(event) => onChangeRole(event.target.value as ShareRole)}
        value={share.role}
      >
        {SHARE_ROLES.map((role) => (
          <option key={role.value} value={role.value}>{role.label}</option>
        ))}
      </select>
      <button
        aria-label={`Revocar acceso a ${share.username}`}
        className="secondary-button"
        disabled={disabled}
        onClick={onRemove}
        type="button"
      >
        Revocar
      </button>
    </li>
  );
}
