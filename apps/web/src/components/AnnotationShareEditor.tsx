import { useState } from "react";
import type { AnnotationShareUser } from "../app/api";
import { ShareWithSelector } from "./ShareWithSelector";

export function AnnotationShareEditor({ id, currentShares, onUpdateShares, sharableUsers, privateLabel }: {
  id: string;
  currentShares: string[];
  onUpdateShares: (userIds: string[]) => Promise<void>;
  sharableUsers: AnnotationShareUser[];
  privateLabel: string;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = draft ?? currentShares;
  const hasChanges = draft !== null && (draft.length !== currentShares.length || draft.some((id) => !currentShares.includes(id)));

  async function handleSave() {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await onUpdateShares(selected);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudieron actualizar los destinatarios.");
    } finally { setIsSaving(false); }
  }

  return (
    <div className="ai-request-share-editor reader-bookmark-share-editor" id={id}>
      <ShareWithSelector
        disabled={isSaving}
        emptyLabel={privateLabel}
        label="Compartido con"
        onChange={(userIds) => { setDraft(userIds); setError(null); }}
        options={sharableUsers}
        selected={selected}
      />
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {hasChanges ? (
        <button className="secondary-button ai-request-share-save" disabled={isSaving} onClick={() => void handleSave()} type="button">
          {isSaving ? "Guardando..." : "Guardar destinatarios"}
        </button>
      ) : null}
    </div>
  );
}
