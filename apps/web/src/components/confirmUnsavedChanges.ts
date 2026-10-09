export type ConfirmUnsavedChangesOptions = {
  save: () => Promise<boolean> | boolean;
  canSave?: boolean;
  message?: string;
  unavailableReason?: string;
};

let pendingConfirmation: Promise<boolean> | null = null;

export function confirmUnsavedChanges({
  save,
  canSave = true,
  message = "Tienes cambios sin guardar. ¿Qué quieres hacer?",
  unavailableReason = "No se pueden guardar los cambios en este momento."
}: ConfirmUnsavedChangesOptions): Promise<boolean> {
  if (pendingConfirmation) {
    return Promise.resolve(false);
  }

  const confirmation = new Promise<boolean>((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "panel unsaved-changes-dialog";
    dialog.style.margin = "auto";
    dialog.style.width = "min(480px, calc(100vw - 32px))";
    dialog.style.maxHeight = "calc(100dvh - 32px)";
    dialog.style.overflow = "auto";
    dialog.setAttribute("aria-label", "Cambios sin guardar");
    dialog.setAttribute("aria-describedby", "unsaved-changes-description");

    const heading = document.createElement("h2");
    heading.textContent = "Cambios sin guardar";
    const description = document.createElement("p");
    description.id = "unsaved-changes-description";
    description.textContent = message;
    const actions = document.createElement("div");
    actions.className = "import-panel-actions";
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "0.75rem";
    let saving = false;
    let settled = false;

    const finish = (leave: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
      resolve(leave);
    };

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "primary-button";
    saveButton.textContent = "Salir guardando";
    saveButton.disabled = !canSave;
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "secondary-button";
    discardButton.textContent = "Salir sin guardar";
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "secondary-button";
    backButton.textContent = "Volver";
    backButton.autofocus = true;

    saveButton.onclick = async () => {
      if (saving || settled || !canSave) return;
      saving = true;
      saveButton.disabled = discardButton.disabled = backButton.disabled = true;
      saveButton.textContent = "Guardando...";
      dialog.setAttribute("aria-busy", "true");
      try {
        finish(await save() === true);
      } catch {
        finish(false);
      }
    };
    discardButton.onclick = () => { if (!saving) finish(true); };
    backButton.onclick = () => { if (!saving) finish(false); };
    dialog.oncancel = (event) => {
      event.preventDefault();
      if (!saving) finish(false);
    };

    dialog.append(heading, description);
    if (!canSave) {
      const reason = document.createElement("p");
      reason.className = "helper-text";
      reason.textContent = unavailableReason;
      dialog.append(reason);
    }
    actions.append(backButton, discardButton, saveButton);
    dialog.append(actions);
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      dialog.remove();
      resolve(false);
    }
  });
  pendingConfirmation = confirmation;
  void confirmation.then(() => { pendingConfirmation = null; });
  return confirmation;
}
