import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { clearVisualGeometry, createVisualBlock, visualDocumentSaveError } from "./visual-page";
import type { VisualPageDocument } from "../../app/api";

const source = ts.createSourceFile("BookBuilderPage.tsx", readFileSync(new URL("./BookBuilderPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const block = { ...createVisualBlock("text"), text: "Un solo atomo\nCon varias lineas", geometry: { bbox: { left: .1, top: .2, width: .3, height: .4 } } };
const doc: VisualPageDocument = { version: 1, blocks: [block], layout: { id: crypto.randomUUID(), type: "column", children: [{ id: crypto.randomUUID(), type: "block", blockId: block.id }] } };

function harness(overrides: Record<string, unknown> = {}) {
  const effects: [string, unknown][] = [];
  const calls: unknown[][] = [];
  const version = { current: { identity: "book:page-a", updatedAt: "v1" } };
  const dirty = { current: true };
  const setter = (name: string) => (value: unknown) => effects.push([name, value]);
  const bindings: Record<string, unknown> = {
    accessToken: "test-token", reviewBookId: "book", reviewPageNumber: 1, reviewBlockLoadError: null,
    reviewPageIdentity: "book:page-a",
    reviewPartialSave: false, visualDocument: doc, visualDocumentDirty: true, isSavingReview: false,
    isReviewCropMode: false, isVisualEditorBusy: false, reviewDraftConflict: false,
    reviewImageRotation: 0, originalReviewImageRotation: 0, reviewImageCrop: null, originalReviewImageCrop: null,
    equalReviewImageCrop: (a: unknown, b: unknown) => a === b, confirmReviewTextReplacement: () => true,
    clearVisualGeometry, visualDocumentSaveError, reviewDraftVersionRef: version, reviewDraftDirtyRef: dirty,
    queryClient: { invalidateQueries: async () => effects.push(["invalidatePublicQueries", true]) },
    persistReviewImageEdits: async (expected: string) => { calls.push(["image", expected]); return { updatedAt: "v2-image" }; },
    saveVisualPageDocument: async (...args: unknown[]) => { calls.push(["document", ...args]); return { updatedAt: "v3-document", document: { ...doc, blocks: [{ ...block, text: "Respuesta canonica" }] } }; },
    preservePartialReviewSave: async (message: string) => effects.push(["partial", message]),
    updateOcrPage: () => assert.fail("Legacy text route must not be called"), updatePageElements: () => assert.fail("Legacy metadata route must not be called")
  };
  bindings.defaultReviewImageCrop = { x: 0, y: 0, width: 100, height: 100 };
  bindings.reviewCropToRect = (crop: unknown) => crop;
  for (const name of ["setReviewError", "setReviewMessage", "setIsSavingReview", "setVisualHistory", "setOriginalVisualDocument", "setOriginalReviewImageRotation", "setOriginalReviewImageCrop", "setReviewImageRotation", "setReviewImageCrop", "setReviewCropDraft", "setReviewDraftConflict"]) bindings[name] = setter(name);
  for (const name of ["reviewPageQuery", "reviewAnnotationsQuery", "reviewNavigationQuery", "booksQuery"]) bindings[name] = { data: { page: { pageId: "page-a" } }, isFetching: false, refetch: async () => effects.push(["refetch", name]) };
  Object.assign(bindings, overrides);
  let handler: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSaveOcr") handler = node; ts.forEachChild(node, visit); }
  visit(source);
  assert.ok(handler);
  const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const run = new Function(...Object.keys(bindings), `${code}\nreturn handleSaveOcr;`)(...Object.values(bindings)) as (event: { preventDefault: () => void }) => Promise<void>;
  return { run: () => run({ preventDefault() {} }), calls, effects, version, dirty };
}

test("save sends the full visual document and records the returned canonical JSON before refetch", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.calls, [["document", "test-token", "book", 1, { expectedUpdatedAt: "v1", document: doc }, "page-a"]]);
  const saved = h.effects.find(([name]) => name === "setOriginalVisualDocument")?.[1];
  assert.equal(JSON.parse(String(saved)).blocks[0].text, "Respuesta canonica");
  assert.equal(h.version.current.updatedAt, "v3-document");
  assert.equal(h.dirty.current, false);
  assert.equal(h.effects.filter(([name]) => name === "refetch").length, 4);
  assert.ok(h.effects.some(([name]) => name === "invalidatePublicQueries"));
});

test("image save chains CAS version into full-document save and clears source-only geometry", async () => {
  const h = harness({ reviewImageRotation: 90 });
  await h.run();
  assert.deepEqual(h.calls, [["image", "v1"], ["document", "test-token", "book", 1, { expectedUpdatedAt: "v2-image", document: clearVisualGeometry(doc) }, "page-a"]]);
  assert.deepEqual(doc.blocks[0]!.geometry, block.geometry);
  assert.ok(h.effects.some(([name, value]) => name === "setReviewImageRotation" && value === 0));
  assert.ok(h.effects.some(([name, value]) => name === "setOriginalReviewImageRotation" && value === 0));
});

test("partial image save never marks document original, preserves dirty draft and version", async () => {
  const h = harness({ reviewImageRotation: 90, saveVisualPageDocument: async () => { throw new Error("Document rejected"); } });
  await h.run();
  assert.equal(h.version.current.updatedAt, "v2-image");
  assert.equal(h.dirty.current, true);
  assert.ok(h.effects.some(([name]) => name === "partial"));
  assert.ok(!h.effects.some(([name]) => name === "setOriginalVisualDocument"));
  assert.ok(h.effects.some(([name, value]) => name === "setIsSavingReview" && value === false));
});

test("409 preserves dirty draft, flags remote conflict and only refetches remote page", async () => {
  const h = harness({ saveVisualPageDocument: async () => { throw Object.assign(new Error("Conflict"), { statusCode: 409 }); } });
  await h.run();
  assert.equal(h.dirty.current, true);
  assert.equal(h.version.current.updatedAt, "v1");
  assert.ok(h.effects.some(([name, value]) => name === "setReviewDraftConflict" && value === true));
  assert.ok(!h.effects.some(([name]) => name === "setOriginalVisualDocument"));
  assert.deepEqual(h.effects.filter(([name]) => name === "refetch"), [["refetch", "reviewPageQuery"]]);
});

for (const guard of ["reviewPartialSave", "reviewDraftConflict", "isVisualEditorBusy", "isReviewCropMode", "isSavingReview"]) {
  test(`${guard} prevents persistence`, async () => {
    const h = harness({ [guard]: true });
    await h.run();
    assert.deepEqual(h.calls, []);
  });
}

test("unresolved crop and image replacement fail before uploading instead of creating a partial save", async () => {
  const cropDoc = { ...doc, blocks: [{ ...block, kind: "image" as const, source: "page-crop" }] };
  const h = harness({ visualDocument: cropDoc, reviewImageRotation: 90 });
  await h.run();
  assert.deepEqual(h.calls, []);
  assert.ok(h.effects.some(([name, value]) => name === "setReviewError" && String(value).includes("recorte")));
});

test("reordered page saves by immutable ID while keeping draft identity independent of position", async () => {
  const h = harness({ reviewPageNumber: 9 });
  await h.run();
  assert.deepEqual(h.calls, [["document", "test-token", "book", 9, { expectedUpdatedAt: "v1", document: doc }, "page-a"]]);
  assert.equal(h.version.current.identity, "book:page-a");
});

test("a different loaded page or pending positional fetch cannot save the previous page draft", async () => {
  for (const overrides of [{ reviewPageIdentity: "book:page-b" }, { reviewPageQuery: { isFetching: true, data: { page: { pageId: "page-a" } } } }]) {
    const h = harness(overrides);
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.equal(h.dirty.current, true);
  }
});
