import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { VisualPageDocument } from "../../app/api";
import { compositeForBlock, createVisualBlock, flattenVisualLayout, mergeVisualBlocks, moveVisualNode, orderedVisualBlocks, reorderVisualBlock, separateVisualContent, ungroupVisualNode, updateVisualBlock, visualDocumentSaveError } from "./visual-page";

const source = ts.createSourceFile("VisualPageEditor.tsx", readFileSync(new URL("./VisualPageEditor.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function component(name: string) {
  const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node?.body, `Expected component ${name}`);
  return node;
}

function evaluate(text: string, result: string, bindings: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), `${code}\nreturn ${result};`)(...Object.values(bindings));
}

function handler(owner: string, name: string, bindings: Record<string, unknown>) {
  const matches: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(component(owner));
  assert.equal(matches.length, 1, `Expected one nested ${owner}/${name}`);
  return evaluate(matches[0]!.getText(source), name, bindings) as (...args: unknown[]) => void;
}

function fixture(): VisualPageDocument {
  const blocks = Array.from({ length: 3 }, (_, index) => ({ ...createVisualBlock("text"), text: `Fragment ${index + 1}`, readAloud: index !== 1, geometry: { bbox: { left: .1, top: .1 * index, width: .2, height: .1 } } }));
  return { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "column", children: blocks.map((block) => ({ id: crypto.randomUUID(), type: "block", blockId: block.id })) } };
}

function dialogHarness(doc: VisualPageDocument, initialSelectedId = doc.blocks[0]!.id, overrides: Record<string, unknown> = {}) {
  const state = { draft: doc, selectedId: initialSelectedId, error: null as string | null };
  const accepted: [VisualPageDocument, string][] = [];
  const bindings = () => ({
    ...state, nodes: flattenVisualLayout(state.draft.layout), disabled: false, stale: false, marking: null,
    flattenVisualLayout, compositeForBlock, visualDocumentSaveError,
    setDraft: (next: VisualPageDocument) => { state.draft = next; },
    setSelectedId: (id: string) => { state.selectedId = id; },
    setError: (error: string | null) => { state.error = error; },
    onAccept: (next: VisualPageDocument, id: string) => { accepted.push([next, id]); },
    onChange: () => assert.fail("Draft edits must not reach the parent"),
    ...overrides
  });
  return {
    state, accepted,
    change: (next: VisualPageDocument) => handler("VisualInspectorDialog", "changeDraft", bindings())(next),
    accept: () => handler("VisualInspectorDialog", "accept", bindings())(),
    html: () => {
      const returned = component("VisualInspectorDialog").body!.statements.find(ts.isReturnStatement);
      assert.ok(returned?.expression);
      const element = evaluate(`const element = ${returned.expression.getText(source)};`, "element", {
        ...bindings(), React, composite: null, sourceImage: null, geometryDisabled: false,
        onCancel() {}, accept() {}, changeDraft() {}, setMarking() {},
        EditorDialog: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children),
        VisualBlockInspector: () => null, VisualCompositeInspector: () => null
      }) as React.ReactElement;
      return renderToStaticMarkup(element);
    }
  };
}

function editorHarness(doc: VisualPageDocument, selectedId = doc.blocks[0]!.id, overrides: Record<string, unknown> = {}) {
  const state = { editing: { id: selectedId, doc, sourceImage: null } as { id: string; doc: VisualPageDocument; sourceImage: null } | null, selectedId };
  const calls: [string, unknown][] = [];
  let frames = 0;
  return {
    state, calls, frames: () => frames,
    close: (next?: VisualPageDocument, id?: string) => handler("VisualPageEditor", "closeInspector", {
      doc, selectedId: state.selectedId, editing: state.editing, disabled: false, flattenVisualLayout,
      onChange: (next: VisualPageDocument) => { calls.push(["change", next]); },
      onSelect: (id: string) => { calls.push(["select", id]); state.selectedId = id; },
      setEditing: (value: null) => { state.editing = value; },
      setShowInactive: (value: boolean) => { calls.push(["inactive", value]); },
      // Layout and focus are outside these transaction tests.
      requestAnimationFrame: () => { frames++; return frames; },
      ...overrides
    })(next, id)
  };
}

test("changeDraft edits locally, clears errors and accepts the latest document and selection once", () => {
  const doc = fixture();
  const h = dialogHarness(doc);
  h.state.error = "Previous error";
  const next = updateVisualBlock(doc, h.state.selectedId, { text: "Edited locally" });
  h.change(next);
  assert.equal(h.state.draft, next);
  assert.equal(h.state.error, null);
  assert.deepEqual(h.accepted, []);
  assert.equal(doc.blocks[0]!.text, "Fragment 1");
  h.accept();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0]![0], next);
  assert.equal(h.accepted[0]![1], h.state.selectedId);
});

test("reordering and moving a composite preserve identities and separation stays local with valid selection", () => {
  const original = fixture();
  const doc = mergeVisualBlocks(original, original.blocks.slice(0, 2).map((block) => block.id), { kind: "text", separator: "paragraph", includeInToc: false });
  const composite = compositeForBlock(doc, doc.blocks[0]!.id)!;
  const snapshot = JSON.stringify(doc);
  const h = dialogHarness(doc, composite.id);
  h.change(reorderVisualBlock(h.state.draft, doc.blocks[0]!.id, 2));
  assert.deepEqual(orderedVisualBlocks(h.state.draft).map((block) => block.id), [doc.blocks[2]!.id, doc.blocks[0]!.id, doc.blocks[1]!.id]);
  h.change(moveVisualNode(h.state.draft, composite.id, doc.layout.id, 0));
  assert.equal(h.state.selectedId, composite.id);
  assert.deepEqual(h.state.draft.blocks, original.blocks);
  assert.equal(compositeForBlock(h.state.draft, doc.blocks[0]!.id), composite);
  assert.deepEqual(flattenVisualLayout(h.state.draft.layout).filter((node) => node.type === "block"), flattenVisualLayout(original.layout).filter((node) => node.type === "block"));
  h.change(separateVisualContent(h.state.draft, composite.id));
  assert.equal(h.state.selectedId, doc.blocks[0]!.id);
  assert.equal(compositeForBlock(h.state.draft, h.state.selectedId), undefined);
  assert.deepEqual(h.state.draft.blocks, original.blocks);
  assert.deepEqual(h.accepted, []);
  assert.equal(JSON.stringify(doc), snapshot);
  assert.equal(visualDocumentSaveError(h.state.draft), null);
  h.accept();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0]![0], h.state.draft);
  assert.equal(h.accepted[0]![1], doc.blocks[0]!.id);
});

test("ungrouping the selected layout falls back to its first block without applying to the parent", () => {
  const doc = fixture();
  const group = { id: crypto.randomUUID(), type: "column" as const, children: doc.layout.type === "block" ? [] : doc.layout.children.slice(0, 2) };
  doc.layout = { ...doc.layout, type: "column", children: [group, ...flattenVisualLayout(doc.layout).filter((node) => node.type === "block").slice(2)] };
  const h = dialogHarness(doc, group.id);
  h.change(ungroupVisualNode(doc, group.id));
  assert.equal(h.state.selectedId, doc.blocks[0]!.id);
  assert.ok(h.state.draft.blocks.some((block) => block.id === h.state.selectedId));
  assert.ok(!flattenVisualLayout(h.state.draft.layout).some((node) => node.id === group.id));
  assert.deepEqual(h.accepted, []);
});

for (const [name, overrides] of [["disabled", { disabled: true }], ["stale", { stale: true }], ["marking", { marking: "active-zone" }]] as const) {
  test(`accept does nothing while ${name}`, () => {
    const h = dialogHarness(fixture(), undefined, { ...overrides, visualDocumentSaveError: () => assert.fail("Guard must run before validation") });
    h.accept();
    assert.deepEqual(h.accepted, []);
    assert.equal(h.state.error, null);
  });
}

test("accept rejects an invalid document and renders the validation error as an alert", () => {
  const doc = fixture();
  const h = dialogHarness(updateVisualBlock(doc, doc.blocks[0]!.id, { text: " " }));
  h.accept();
  assert.deepEqual(h.accepted, []);
  assert.equal(h.state.error, visualDocumentSaveError(h.state.draft));
  assert.match(h.html(), /role="alert"[^>]*>Completa el texto de los bloques activos antes de guardar\./);
});

test("Cancel clears editing and preserves parent document and selection without callbacks", () => {
  const h = editorHarness(fixture());
  const selectedId = h.state.selectedId;
  h.close();
  assert.equal(h.state.editing, null);
  assert.equal(h.state.selectedId, selectedId);
  assert.deepEqual(h.calls, []);
  assert.equal(h.frames(), 1);
});

test("closeInspector applies once with the supplied selection and defaults to the existing selection", () => {
  const doc = fixture();
  const next = updateVisualBlock(doc, doc.blocks[1]!.id, { text: "Accepted" });
  for (const id of [undefined, doc.blocks[1]!.id]) {
    const h = editorHarness(doc);
    const expectedId = id ?? h.state.selectedId;
    h.close(next, id);
    assert.deepEqual(h.calls, [["change", next], ["select", expectedId]]);
    assert.equal(h.calls[0]![1], next);
    assert.equal(h.state.selectedId, expectedId);
    assert.equal(h.state.editing, null);
    assert.equal(h.frames(), 1);
  }
});

for (const reason of ["disabled", "replaced base"] as const) {
  test(`closeInspector rejects acceptance with ${reason}`, () => {
    const doc = fixture();
    const h = editorHarness(doc, undefined, reason === "disabled" ? { disabled: true } : { doc: structuredClone(doc) });
    const editing = h.state.editing;
    h.close(updateVisualBlock(doc, doc.blocks[0]!.id, { text: "Rejected" }), doc.blocks[1]!.id);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.editing, editing);
    assert.equal(h.state.selectedId, doc.blocks[0]!.id);
    assert.equal(h.frames(), 0);
    h.close();
    assert.equal(h.state.editing, null);
    assert.deepEqual(h.calls, []);
  });
}
