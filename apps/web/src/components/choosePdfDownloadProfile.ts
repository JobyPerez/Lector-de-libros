import type { PdfProfile } from "../app/api";

let choosing = false;

export function choosePdfDownloadProfile(title: string, format: "pdf" | "pdf-images"): Promise<PdfProfile | null> {
  if (choosing) return Promise.resolve(null);
  choosing = true;
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "panel pdf-download-dialog";
    dialog.setAttribute("aria-labelledby", "pdf-download-title");
    dialog.setAttribute("aria-describedby", "pdf-download-description");
    const heading = document.createElement("h2");
    heading.id = "pdf-download-title";
    heading.textContent = "Descargar PDF";
    const description = document.createElement("p");
    description.id = "pdf-download-description";
    description.textContent = `Elige el tamaño y la calidad para «${title}». El libro guardado conservará su calidad original.`;
    const form = document.createElement("form");
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Calidad del PDF";
    fieldset.append(legend);
    const options: { value: PdfProfile; title: string; description: string }[] = [
      { value: "original", title: "Calidad original", description: "Conserva todos los detalles. El archivo puede ser grande." },
      { value: "balanced", title: "Equilibrado · Recomendado", description: "Reduce el peso manteniendo buena calidad para leer y estudiar." },
      { value: "compact", title: "Compacto", description: "Mayor reducción para servicios como NotebookLM. Las imágenes perderán algo de detalle." },
      ...(format === "pdf" ? [{ value: "text-only" as const, title: "Solo texto", description: "Muy ligero: texto OCR e índice, sin imágenes. Útil para consultar el contenido con IA." }] : [])
    ];
    for (const option of options) {
      const label = document.createElement("label");
      label.className = "pdf-download-choice";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "profile";
      radio.value = option.value;
      radio.checked = option.value === "balanced";
      radio.autofocus = radio.checked;
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = option.title;
      const detail = document.createElement("small");
      detail.textContent = option.description;
      text.append(name, detail);
      label.append(radio, text);
      fieldset.append(label);
    }
    const note = document.createElement("p");
    note.className = "helper-text";
    note.textContent = "El tamaño final depende de las imágenes del libro. La descarga puede tardar unos minutos en prepararse.";
    const actions = document.createElement("div");
    actions.className = "import-panel-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.textContent = "Cancelar";
    const download = document.createElement("button");
    download.type = "submit";
    download.className = "primary-button";
    download.textContent = "Descargar PDF";
    let settled = false;
    const finish = (profile: PdfProfile | null) => {
      if (settled) return;
      settled = true;
      choosing = false;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(profile);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>('input[name="profile"]:checked');
      if (selected) finish(selected.value as PdfProfile);
    };
    cancel.onclick = () => finish(null);
    dialog.oncancel = (event) => { event.preventDefault(); finish(null); };
    dialog.onclose = () => finish(null);
    actions.append(cancel, download);
    form.append(fieldset, note, actions);
    dialog.append(heading, description, form);
    document.body.append(dialog);
    try { dialog.showModal(); } catch { finish(null); }
  });
}
