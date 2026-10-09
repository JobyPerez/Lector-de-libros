import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { VisualPageDocument } from "../src/app/api";
import { createVisualBlock, updateVisualBlock, updateVisualNode, visualDocumentSaveError } from "../src/features/book-builder/visual-page";

function handler(file: string, owner: string, name: string, bindings: Record<string, unknown>) {
  const text = readFileSync(new URL(`../src/features/${file}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === owner);
  assert.ok(component);
  let found: ts.FunctionDeclaration | undefined;
  function visit(item: ts.Node) {
    if (ts.isFunctionDeclaration(item) && item.name?.text === name) found = item;
    ts.forEachChild(item, visit);
  }
  visit(component);
  assert.ok(found);
  const code = ts.transpileModule(found.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
}

function fixture(): VisualPageDocument {
  const block = { ...createVisualBlock("text"), text: "Texto" };
  return { version: 1, blocks: [block], layout: { id: "root", type: "column", children: [{ id: "leaf", type: "block", blockId: block.id }] } };
}

function saveHarness(overrides: Record<string, unknown> = {}) {
  const doc = fixture();
  const canonical = updateVisualBlock(doc, doc.blocks[0]!.id, { text: "Canonico" });
  const calls: unknown[][] = [];
  const effects: Record<string, unknown> = {};
  let notified = 0;
  const bindings: Record<string, unknown> = {
    history: { past: [], present: doc, future: [] },
    loadedPage: { pageId: "stable-page", pageNumber: 9, updatedAt: "v1" },
    accessToken: "token", bookId: "book", dirty: true, interacting: false, conflict: false,
    savingRef: { current: false }, alive: { current: true }, visualDocumentSaveError,
    saveVisualPageDocument: async (...args: unknown[]) => { calls.push(args); return { document: canonical, updatedAt: "v2" }; },
    onSaved: async () => { notified++; }
  };
  for (const key of ["Saving", "Error", "Message", "SavedDocument", "History", "LoadedPage", "Conflict"]) {
    bindings[`set${key}`] = (value: unknown) => { effects[key] = value; };
  }
  Object.assign(bindings, overrides);
  return { doc, canonical, calls, effects, notified: () => notified, save: handler("book-pages/GalleryPageEditor.tsx", "GalleryPageEditorSession", "save", bindings) };
}

test("gallery save uses loaded immutable identity and CAS version, adopting canonical response", async () => {
  const h = saveHarness();
  assert.equal(await h.save(), true);
  assert.deepEqual(h.calls, [["token", "book", 9, { expectedUpdatedAt: "v1", document: h.doc }, "stable-page"]]);
  assert.equal(h.effects.SavedDocument, h.canonical);
  assert.deepEqual(h.effects.History, { past: [], present: h.canonical, future: [] });
  assert.equal(h.notified(), 1);
  assert.equal(h.effects.Saving, false);
});

test("gallery conflict preserves draft and does not notify or adopt a saved document", async () => {
  const h = saveHarness({ saveVisualPageDocument: async () => { throw Object.assign(new Error("Conflict"), { statusCode: 409 }); } });
  assert.equal(await h.save(), false);
  assert.equal(h.effects.Conflict, true);
  assert.equal(h.effects.History, undefined);
  assert.equal(h.effects.SavedDocument, undefined);
  assert.equal(h.notified(), 0);
  assert.match(String(h.effects.Error), /borrador se conserva/);
});

test("gallery refresh failure reports that persistence succeeded without restoring dirty state", async () => {
  const h = saveHarness({ onSaved: async () => { throw new Error("Refresh failed"); } });
  assert.equal(await h.save(), true);
  assert.equal(h.effects.SavedDocument, h.canonical);
  assert.match(String(h.effects.Error), /Los cambios se guardaron/);
});

for (const overrides of [{ interacting: true }, { conflict: true }, { savingRef: { current: true } }, { dirty: false }]) {
  test(`gallery save refuses guarded state ${JSON.stringify(overrides)}`, async () => {
    const h = saveHarness(overrides);
    assert.equal(await h.save(), false);
    assert.deepEqual(h.calls, []);
    assert.equal(h.notified(), 0);
  });
}

test("gallery editor close and reload await confirmation and preserve the draft on Volver", async () => {
  for (const allowed of [true, false]) {
    let closed = 0;
    let cleared = 0;
    const bindings = {
      confirmExit: async () => allowed, onClose: () => { closed++; },
      setHistory: () => { cleared++; }, setSavedDocument: () => { cleared++; },
      setLoadedPage: () => { cleared++; }, setReload: () => { cleared++; }
    };
    await handler("book-pages/GalleryPageEditor.tsx", "GalleryPageEditorSession", "close", bindings)();
    await handler("book-pages/GalleryPageEditor.tsx", "GalleryPageEditorSession", "reloadPage", bindings)();
    assert.equal(closed, allowed ? 1 : 0);
    assert.equal(cleared, allowed ? 4 : 0);
  }
});

test("gallery editor refuses exits during interaction or persistence without offering discard", async () => {
  for (const saving of [true, false]) {
    const confirmExit = handler("book-pages/GalleryPageEditor.tsx", "GalleryPageEditorSession", "confirmExit", {
      savingRef: { current: saving }, exitRef: { current: { busy: !saving } }, confirmingRef: { current: false },
      confirmUnsavedChanges: () => assert.fail("Busy operations must not offer discard")
    });
    assert.equal(await confirmExit(), false);
  }
});

test("gallery typography clears both scale fields on type/heading changes, builder keeps them", () => {
  for (const simpleTypography of [true, false]) {
    const original = fixture();
    const block = { ...original.blocks[0]!, fontScale: 3, style: { fontScale: 2, color: "#123456" } };
    const doc = { ...original, blocks: [block] };
    let changed = doc;
    const patch = handler("book-builder/VisualBlockInspector.tsx", "VisualBlockInspector", "patch", {
      doc, block, simpleTypography, updateVisualBlock, onChange: (next: VisualPageDocument) => { changed = next; }
    });
    patch({ kind: "heading", headingLevel: 2 });
    assert.equal(changed.blocks[0]!.fontScale, simpleTypography ? undefined : 3);
    assert.equal(changed.blocks[0]!.style?.fontScale, simpleTypography ? undefined : 2);
    assert.equal(changed.blocks[0]!.style?.color, "#123456");
    assert.equal(block.fontScale, 3);
  }
});

test("gallery composite typography clears common, container and fragment scales without changing other styles", () => {
  const original = fixture();
  const block = { ...original.blocks[0]!, fontScale: 3, style: { fontScale: 2, color: "#123456" } };
  const node = { ...original.layout, content: { kind: "heading" as const, separator: "line" as const, includeInToc: true, fontScale: 2 }, style: { fontScale: 3, padding: 12 } };
  const doc = { ...original, blocks: [block], layout: node };
  const clearScale = handler("book-builder/VisualCompositeInspector.tsx", "VisualCompositeInspector", "clearScale", { members: [block], node, updateVisualNode });
  const next = clearScale(doc) as VisualPageDocument;
  assert.equal(next.blocks[0]!.fontScale, undefined);
  assert.equal(next.blocks[0]!.style?.fontScale, undefined);
  assert.equal(next.blocks[0]!.style?.color, "#123456");
  assert.ok(next.layout.type !== "block");
  assert.equal(next.layout.content?.fontScale, undefined);
  assert.equal(next.layout.style?.fontScale, undefined);
  assert.equal(next.layout.style?.padding, 12);
  assert.equal(node.content.fontScale, 2);
});
