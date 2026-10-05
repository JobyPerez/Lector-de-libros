# Visual Page Editor

## API Boundary

The builder consumes the existing types from `app/api.ts`, without defining or modifying API types. Markdown is stored in `VisualBlock.text` (the current type's field name). A multiline string is ONE atom, never a sequence of paragraph identities.

Required helper contracts:

```ts
fetchBookPage(accessToken, bookId, pageNumber, { includeInactive: true });

saveVisualPageDocument(accessToken, bookId, pageNumber, {
  expectedUpdatedAt: string,
  document: VisualPageDocument
}): Promise<{ updatedAt: string; document: VisualPageDocument }>;
```

The first helper must request editor-authorized inactive content. Its cache key is `['builder-page-visual', bookId, pageNumber, 'include-inactive']`, never Reader's public page key. Production responses must supply `page.visualDocument` derived from ALL SQL paragraphs or the stored document. `hasVisualDocument` does not gate initialization: derived documents are authoritative too.

The save helper targets the new `PUT visual-document` route. No legacy text/paragraph-line or metadata PATCH routes are used by this editor.

## Controlled Draft

`BookBuilderPage` owns history, the current document, original serialized JSON, selection and CAS version. All atom/layout mutations are immutable. Remote refetches preserve initialized drafts; a changed remote version with a dirty draft marks a conflict instead of replacing it. A 409 also flags conflict. The explicit discard control reloads remote content after confirmation.

On successful save the returned canonical document becomes both the draft and original JSON, then related queries refetch. If source image adjustments exist, the existing upload runs first and its returned version is passed to the document save. Geometry is cleared in that payload. A failed second request retains the partial-save guard and dirty document. An unresolved `page-crop` plus source-image replacement is rejected before upload: restore image adjustments, save the crop first, or replace the block's source.

OCR rerun retains the existing implementation and recovery path; successful refetch resets the visual document and history. A legacy line-count mismatch cannot block a supplied canonical document.

## Interaction

- Source zones and preview atoms select by UUID and open the same native editing dialog on desktop and mobile. The dialog owns an immutable document draft: Accept applies it as one page-history entry, while Cancel, Close and Escape discard it. Accept never saves to the API. Closing preserves the selection and returns focus without scrolling away from the originating block; moved blocks are brought back into view when necessary.
- The editing dialog counts as a pending interaction, locks background scrolling and blocks page-level undo/redo. Geometry marking stays inside the dialog and targets the concrete atom UUID, including composite fragments. Separating or ungrouping stays in the draft until Accept. A replaced base document prevents accepting a stale dialog draft.
- Numbers are depth-first layout order, including annulled atoms. Changing order moves a leaf relative to the target leaf, without changing its atom or geometry.
- Layout defaults to the received tree. Presets replace containers while retaining atom and leaf IDs, including inactive leaves. Containers can be nested, switched between row/column, assigned positive child weights and a gap of 0..48 px.
- Drag handles move atoms or containers to explicit insertion zones; cycle/root moves are rejected. `Mover a...` and position controls provide the keyboard alternative.
- Annul/restore changes `active`, not IDs or original image pixels. Preview excludes annulled atoms unless `Mostrar anulados` is enabled; source zones remain recoverable.
- Image width is 1..100 percent of its layout area, independent of bbox. Font scale is .5..3. Titles expose T1..T6 and an independent TOC checkbox.
- Preview clicks select rather than open the image viewer. Only `Ampliar` opens it.
- Undo/redo include structural changes and annulment. A new edit after undo drops the redo branch. Ctrl/Cmd+Z is not intercepted in textarea/input/select/contenteditable or open editing, creation and joining dialogs.
- Swipe has no broad parent allow-selector and ignores the entire visual editor, inspector and dialogs; marking/dragging/pending creation also disable it.

## Creation And Source

`Crear bloque` on an available, unchanged source image first draws a normalized bbox, then opens kind/content selection. A provisional atom has a crypto UUID and valid placeholder text. Confirming creates one atom and one distinct leaf UUID. An image crop stores only `source: 'page-crop'` and geometry: client canvas data is transient preview state and is NEVER added to the document. The backend must resolve the crop on save.

For pages without a source image, the left panel is explicitly `Contenido importado`, not a facsimile. Saved HTML is sanitized, mapped to paragraph IDs and hydrated with `useBookContentImageHtml`; it does not mirror unsaved edits. Creation does not require an image or bbox. Image sources may reuse existing images, use HTTPS/internal references, or upload PNG/JPEG/WEBP data URLs. The client limit is 1 MB INCLUDING data URL encoding; uploads do not persist until save. The server remains responsible for the aggregate JSON/body limit and validation.

`visualDocumentFromPage` is only a legacy/mock fallback when the canonical document is omitted. It creates exactly one atom per persisted paragraph, preserving IDs and flags, resolves HTML images by paragraph ID before number, and never matches metadata to split text lines.

## Shared Overlay

`PageElementOverlay` adds optional `number`/`active` element fields and optional `onCreateGeometry`/`onDrawingChange` callbacks. Existing Reader callers can omit all new props; selection and geometry behavior remains unchanged.

## Verification

Run from `apps/web`, without build or deployment:

```sh
npx tsx --test src/features/book-builder/visual-page.test.ts src/features/book-builder/visual-save.test.ts src/features/book-builder/reading-blocks.test.ts test/ocr-review-recovery.test.ts
npm run typecheck
```

Before the two required API helper contracts land, typecheck intentionally reports their missing export/signature. No compatibility shim or replacement API is added.
