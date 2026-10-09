import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { paragraphLines, parseReadingBlocks } from "../src/features/book-builder/reading-blocks";
import type { ParagraphElementMetadata, VisualPageDocument } from "../src/app/api";
import { loadOcrConfig } from "./ocr-config-fixture";
import { createVisualBlock, normalizeVisualDocument, renderVisualPreviewHtml, visualDocumentFromPage } from "../src/features/book-builder/visual-page";

const source = ts.createSourceFile("BookBuilderPage.tsx", readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expectedUpdatedAt = "2026-01-02T03:04:05.123456";
const editedText = `:::block synthetic\n${Array.from({ length: 14 }, (_, i) => `Synthetic line ${i + 1}`).join("\n")}`;
const metadata: ParagraphElementMetadata[] = Array.from({ length: 15 }, () => ({ role: "header", readAloud: false, geometry: null }));

function handlerNode(name: string): ts.FunctionDeclaration {
  const matches: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `Expected one nested ${name}`);
  assert.notEqual(matches[0]!.parent, source);
  return matches[0]!;
}

function evaluateHandler(name: string, bindings: Record<string, unknown>, oldGuard = false) {
  const node = handlerNode(name);
  let text = node.getText(source);
  if (oldGuard) {
    const guard = node.body!.statements.find(ts.isIfStatement)!;
    const start = guard.expression.getStart(source) - node.getStart(source);
    const end = guard.expression.getEnd() - node.getStart(source);
    // Mutate only the extracted function in memory, never the application file.
    text = `${text.slice(0, start)}reviewBlockLoadError || (${text.slice(start, end)})${text.slice(end)}`;
  }
  const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), `${javascript}\nreturn ${name};`)(...Object.values(bindings)) as (...args: unknown[]) => Promise<void>;
}

function recoveryHarness(overrides: Record<string, unknown> = {}, oldGuard = false) {
  let reviewBlockLoadError = "";
  try {
    parseReadingBlocks(editedText, [], metadata);
    assert.fail("The synthetic metadata mismatch must fail closed");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /15 parrafos.*14 elementos/);
    reviewBlockLoadError = error.message;
  }
  const active = new Set<string>(["other-operation"]);
  const version = { current: { identity: "synthetic-book:page-a", updatedAt: expectedUpdatedAt } as { identity: string; updatedAt: string } | null };
  const calls: unknown[][] = [];
  const refetches: string[] = [];
  const effects: [string, unknown][] = [];
  const setter = (name: string) => (value: unknown) => { effects.push([name, value]); };
  const forbidden = () => { assert.fail("Recovery must not save old text or guess metadata"); };
  const bindings: Record<string, unknown> = {
    accessToken: "synthetic-token-not-a-credential",
    reviewBookId: "synthetic-book",
    reviewPageNumber: 7,
    reviewPageIdentity: "synthetic-book:page-a",
    reviewPageIdentityRef: { current: "synthetic-book:page-a" },
    reviewBlockLoadError,
    reviewPartialSave: false,
    reviewDraftConflict: false,
    activeOcrOperationsRef: { current: active },
    reviewDraftVersionRef: version,
    reviewOcrMode: "LOCAL",
    reviewAdvancedLayout: false,
    setReviewAdvancedLayout: setter("setReviewAdvancedLayout"),
    reviewImageRotation: 0,
    originalReviewImageRotation: 0,
    reviewImageCrop: null,
    originalReviewImageCrop: null,
    equalReviewImageCrop: (a: unknown, b: unknown) => a === b,
    selectedOcrModel: "synthetic-vision-model",
    canRunOcr: loadOcrConfig().resolveOcrModels(undefined, undefined, { source: "live", models: [{ id: "synthetic-vision-model", supportsVision: true }] } as any, "synthetic-vision-model").canRunOcr,
    compatibilityMessage: null,
    normalizeOcrOptions: loadOcrConfig().normalizeOcrOptions,
    reviewPromptOverride: "",
    visualDocumentFromPage,
    reviewDraftDirtyRef: { current: true },
    queryClient: { invalidateQueries: async () => {} },
    defaultReviewImageCrop: null,
    reviewCropToRect: (value: unknown) => value,
    confirmReviewTextReplacement: () => { effects.push(["confirm", true]); return true; },
    prepareCompletionSound: setter("prepareSound"),
    playCompletionSound: setter("sound"),
    showReviewOcrToast: setter("toast"),
    defaultVisionOcrEditablePrompt: "synthetic-default-prompt",
    reviewPageAnnotationCount: 0,
    runOcrRequestWithRetry: async (scope: string, request: () => Promise<unknown>) => {
      assert.equal(scope, "review");
      assert.ok(active.has("review"));
      assert.deepEqual(effects.filter(([name]) => name === "setIsSavingReview" || name === "setIsRerunningOcr"), [["setIsSavingReview", true], ["setIsRerunningOcr", true]]);
      return request();
    },
    rerunOcrPage: async (...args: unknown[]) => { calls.push(args); return { updatedAt: "synthetic-next-version" }; },
    editedText,
    readingBlocks: [],
    readingMetadata: forbidden,
    defaultElementMetadata: forbidden,
    setReadingBlocks: forbidden,
    persistReviewImageEdits: forbidden,
    preservePartialReviewSave: forbidden,
    updateOcrPage: forbidden,
    updatePageElements: forbidden
  };
  for (const name of ["setReviewError", "setReviewMessage", "setIsSavingReview", "setIsRerunningOcr", "setIsReviewOcrMenuVisible", "setReviewOcrMode", "setReviewPromptOverride", "setIsReviewPromptEditorOpen", "setVisualHistory", "setOriginalVisualDocument", "setReviewDraftConflict", "setReviewBlockLoadError", "setSelectedElementKey", "setIsReviewCropMode", "setReviewImageCrop", "setReviewCropDraft", "setOriginalReviewImageCrop", "setReviewImageRotation", "setOriginalReviewImageRotation"]) bindings[name] = setter(name);
  for (const name of ["reviewPageQuery", "reviewAnnotationsQuery", "reviewNavigationQuery", "booksQuery"]) {
    bindings[name] = { data: { page: { pageId: "page-a" } }, isFetching: false, refetch: async () => { assert.equal(version.current, null); refetches.push(name); return { data: { page: { pageId: "page-a", updatedAt: "synthetic-next-version", visualDocument: { version: 1, blocks: [], layout: { id: "root", type: "column", children: [] } } } } }; } };
  }
  Object.assign(bindings, overrides);
  return { run: evaluateHandler("handleRerunOcr", bindings, oldGuard), calls, refetches, effects, active, version };
}

function assertRecovery(harness: ReturnType<typeof recoveryHarness>, mode: string) {
  assert.equal(harness.calls.length, 1, "OCR recovery must reach rerunOcrPage exactly once");
  assert.deepEqual(harness.calls[0], ["synthetic-token-not-a-credential", "synthetic-book", 7, {
    expectedUpdatedAt,
    advancedLayout: false,
    ...(mode === "VISION" ? { ocrModel: "synthetic-vision-model", promptOverride: "synthetic prompt" } : {}),
    ocrMode: mode
  }, "page-a"]);
  assert.deepEqual(harness.refetches.sort(), ["booksQuery", "reviewAnnotationsQuery", "reviewNavigationQuery", "reviewPageQuery"]);
  assert.deepEqual([...harness.active], ["other-operation"]);
  assert.deepEqual(harness.version.current, { identity: "synthetic-book:page-a", updatedAt: "synthetic-next-version" });
  for (const name of ["setIsSavingReview", "setIsRerunningOcr"]) {
    assert.deepEqual(harness.effects.filter(([key]) => key === name), [[name, true], [name, false]]);
  }
  assert.deepEqual(harness.effects.filter(([name]) => name === "setReviewError"), [["setReviewError", null]]);
  assert.ok(harness.effects.some(([name, value]) => name === "sound" && value === "success"));
  assert.ok(!JSON.stringify(harness.calls).includes(editedText));
}

test("synthetic source fixture has 15 metadata entries and 14 reading lines and rejects parsing", () => {
  assert.equal(metadata.length, 15);
  assert.equal(paragraphLines(editedText).length, 14);
  assert.throws(() => parseReadingBlocks(editedText, [], metadata), /15 parrafos.*14 elementos/);
});

test("all builder entry points reject nonvision models before requests, confirmation or image writes", async () => {
  const { resolveOcrModels } = loadOcrConfig();
  const selection = resolveOcrModels({ models: [{ id: "deepseek-v4-flash", supportsVision: false }] } as any, undefined, { source: "live", models: [] }, "deepseek-v4-flash");
  for (const mode of ["VISION", "TEXTRACT"] as const) {
    const errors: unknown[] = [];
    for (const [name, prefix] of [["handleCreateFromImages", "create"], ["handleAppendImages", "append"]]) {
      const run = evaluateHandler(name!, {
        [`${prefix}Selection`]: selection,
        [`${prefix}OcrMode`]: mode, [`${prefix}AdvancedLayout`]: true,
        [prefix === "create" ? "setCreateError" : "setAppendError"]: (value: unknown) => errors.push(value)
      });
      await run({ preventDefault() {} });
    }
    assert.deepEqual(errors, [selection.compatibilityMessage, selection.compatibilityMessage]);
    const review = recoveryHarness({ canRunOcr: selection.canRunOcr, compatibilityMessage: selection.compatibilityMessage, reviewAdvancedLayout: true });
    await review.run(mode);
    assert.deepEqual(review.calls, []);
    assert.deepEqual(review.refetches, []);
    assert.deepEqual(review.effects, [["setReviewError", selection.compatibilityMessage]]);
  }
});

for (const mode of ["TEXTRACT", "VISION", "LOCAL"]) {
  test(`${mode} recovers a metadata load error using the exact FF6 version, without old text or guessed metadata`, async () => {
    const harness = recoveryHarness();
    await harness.run(mode, "  synthetic prompt  ");
    assertRecovery(harness, mode);
  });
}

for (const mode of ["TEXTRACT", "VISION", "LOCAL"]) {
  test(`${mode} recovery opt-in forwards the same selected model only for non-local modes`, async () => {
    const harness = recoveryHarness({ reviewAdvancedLayout: true });
    await harness.run(mode, "  synthetic prompt  ");
    const payload = harness.calls[0]![3];
    assert.deepEqual(payload, { expectedUpdatedAt, advancedLayout: mode !== "LOCAL", ocrMode: mode,
      ...(mode !== "LOCAL" ? { ocrModel: "synthetic-vision-model" } : {}),
      ...(mode !== "LOCAL" ? { promptOverride: "synthetic prompt" } : {}) });
    if (mode === "LOCAL") assert.ok(harness.effects.some(([name, value]) => name === "setReviewAdvancedLayout" && value === false));
  });
}

for (const [name, overrides] of [
  ["partial save", { reviewPartialSave: true }],
  ["draft conflict", { reviewDraftConflict: true }],
  ["active review OCR", { activeOcrOperationsRef: { current: new Set(["review"]) } }]
] as const) {
  test(`${name} prevents OCR recovery even with a metadata load error`, async () => {
    const harness = recoveryHarness(overrides);
    await harness.run("TEXTRACT");
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.refetches, []);
    assert.deepEqual(harness.effects, []);
    assert.equal(harness.version.current?.updatedAt, expectedUpdatedAt);
    if ("activeOcrOperationsRef" in overrides) assert.ok(overrides.activeOcrOperationsRef.current.has("review"));
  });
}

test("handleSaveOcr still returns immediately on a metadata load error", async () => {
  let prevented = 0;
  const run = evaluateHandler("handleSaveOcr", {
    accessToken: "synthetic-token-not-a-credential",
    reviewBookId: "synthetic-book",
    reviewBlockLoadError: "synthetic load error",
    reviewPartialSave: false
  });
  // No later dependencies are injected: falling through the guard fails execution.
  await run({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
});

test("the recovery assertion detects the previous load-error guard injected only in memory", async () => {
  const harness = recoveryHarness({}, true);
  await harness.run("TEXTRACT");
  assert.throws(() => assertRecovery(harness, "TEXTRACT"), /OCR recovery must reach rerunOcrPage exactly once/);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.effects, []);
});

test("a failed OCR request releases the active operation and restores both loading flags", async () => {
  const harness = recoveryHarness({ rerunOcrPage: async () => { throw new Error("synthetic OCR failure"); } });
  await harness.run("LOCAL");
  assert.deepEqual([...harness.active], ["other-operation"]);
  assert.deepEqual(harness.refetches, []);
  assert.equal(harness.version.current?.updatedAt, expectedUpdatedAt);
  for (const name of ["setIsSavingReview", "setIsRerunningOcr"]) {
    assert.deepEqual(harness.effects.filter(([key]) => key === name), [[name, true], [name, false]]);
  }
  assert.ok(harness.effects.some(([name, value]) => name === "setReviewError" && value === "synthetic OCR failure"));
  assert.ok(harness.effects.some(([name, value]) => name === "sound" && value === "error"));
});

test("OCR confirmation explicitly warns about replacing saved and pending styles/layout even without annotations", async () => {
  for (const annotationCount of [0, 3]) {
    const messages: string[] = [];
    const confirm = evaluateHandler("confirmReviewTextReplacement", {
      reviewPageAnnotationCount: annotationCount, reviewPageBookmarkCount: annotationCount ? 1 : 0,
      reviewPageHighlightCount: annotationCount ? 1 : 0, reviewPageNoteCount: annotationCount ? 1 : 0,
      window: { confirm: (message: string) => { messages.push(message); return false; } }
    });
    assert.equal(await confirm("volver a ejecutar el OCR", true), false);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /reemplazará.*estilos editoriales.*maquetación manual.*guardados.*pendientes de guardar/u);
    if (annotationCount) assert.match(messages[0]!, /1 marcador, 1 resaltado, 1 nota.*recolocar/u);
    else assert.doesNotMatch(messages[0]!, /anotaciones/u);
  }
  const confirmSave = evaluateHandler("confirmReviewTextReplacement", { reviewPageAnnotationCount: 0 });
  assert.equal(await confirmSave("guardar el documento visual"), true);
});

test("canceling OCR replacement confirmation prevents image writes and OCR execution", async () => {
  let confirmations = 0;
  const harness = recoveryHarness({ confirmReviewTextReplacement: (action: string, replacesVisualContent: boolean) => {
    confirmations++;
    assert.equal(action, "volver a ejecutar el OCR");
    assert.equal(replacesVisualContent, true);
    return false;
  } });
  await harness.run("VISION");
  assert.equal(confirmations, 1);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.effects, []);
  assert.deepEqual(harness.refetches, []);
  assert.equal(harness.version.current?.updatedAt, expectedUpdatedAt);
});

test("advanced editor rerun explicitly installs the refreshed canonical colored block/container and survives reload", async () => {
  const block = { ...createVisualBlock("text"), text: "Canonical colored paragraph", style: { color: "#123abc", backgroundColor: "#f1f2f3" } };
  const canonical: VisualPageDocument = { version: 1, blocks: [block], layout: { id: "colored-container", type: "column", gap: 12, style: { backgroundColor: "#abcdef", borderColor: "#112233", borderWidth: 2 }, children: [{ id: "leaf", type: "block", blockId: block.id }] } };
  const invalidated: string[] = [];
  const h = recoveryHarness({ reviewAdvancedLayout: true, reviewPromptOverride: "  advanced prompt  ",
    reviewPageQuery: { data: { page: { pageId: "page-a" } }, isFetching: false, refetch: async () => ({ data: { page: { pageId: "page-a", updatedAt: "canonical-version", visualDocument: canonical, editedText: "stale legacy text", paragraphs: [] } } }) },
    queryClient: { invalidateQueries: async ({ predicate }: { predicate: (query: { queryKey: string[] }) => boolean }) => {
      for (const key of ["book-pages", "book-page", "reader-annotations", "reader-navigation", "reader-readable-neighbors"]) {
        if (predicate({ queryKey: [key, "synthetic-book"] })) invalidated.push(key);
        assert.equal(predicate({ queryKey: [key, "unrelated-book"] }), false);
      }
    } }
  });
  await h.run("TEXTRACT");
  assert.deepEqual(h.calls[0]![3], { expectedUpdatedAt, ocrMode: "TEXTRACT", advancedLayout: true, ocrModel: "synthetic-vision-model", promptOverride: "advanced prompt" });
  assert.deepEqual(h.effects.filter(([name]) => name === "setVisualHistory"), [["setVisualHistory", { past: [], present: canonical, future: [] }]]);
  assert.deepEqual(h.effects.filter(([name]) => name === "setOriginalVisualDocument"), [["setOriginalVisualDocument", JSON.stringify(canonical)]]);
  assert.deepEqual(h.version.current, { identity: "synthetic-book:page-a", updatedAt: "canonical-version" });
  assert.deepEqual(invalidated.sort(), ["book-pages", "book-page", "reader-annotations", "reader-navigation", "reader-readable-neighbors"].sort());
  const reloaded = normalizeVisualDocument(JSON.parse(JSON.stringify(canonical)));
  assert.deepEqual(reloaded, canonical);
  assert.match(renderVisualPreviewHtml(reloaded), /color:#123abc/);
  assert.match(renderVisualPreviewHtml(reloaded), /background-color:#abcdef/);
});

test("OCR completion does not clear or replace a different dirty page opened during refetch", async () => {
  const identity = { current: "synthetic-book:page-a" };
  let h: ReturnType<typeof recoveryHarness>;
  h = recoveryHarness({ reviewPageIdentityRef: identity,
    reviewPageQuery: { data: { page: { pageId: "page-a" } }, isFetching: false, refetch: async () => {
      identity.current = "synthetic-book:page-b";
      h.version.current = { identity: identity.current, updatedAt: "unrelated-dirty-version" };
      return { data: { page: { pageId: "page-a", updatedAt: "new-version" } } };
    } }
  });
  await h.run("LOCAL");
  assert.deepEqual(h.version.current, { identity: "synthetic-book:page-b", updatedAt: "unrelated-dirty-version" });
  assert.equal(h.effects.some(([name]) => ["setVisualHistory", "setOriginalVisualDocument", "setSelectedElementKey", "setReviewImageCrop"].includes(name)), false);
});

test("a failed canonical refetch reports failure, invalidates caches and never signals success", async () => {
  let invalidations = 0;
  const h = recoveryHarness({ reviewPageQuery: { data: { page: { pageId: "page-a" } }, isFetching: false, refetch: async () => ({ error: new Error("canonical refetch failed") }) },
    queryClient: { invalidateQueries: async () => { invalidations++; } }
  });
  await h.run("LOCAL");
  assert.ok(invalidations > 0);
  assert.ok(h.effects.some(([name, value]) => name === "setReviewError" && value === "canonical refetch failed"));
  assert.equal(h.effects.some(([name, value]) => name === "sound" && value === "success"), false);
  assert.equal(h.effects.some(([name]) => name === "setVisualHistory" || name === "toast"), false);
});
