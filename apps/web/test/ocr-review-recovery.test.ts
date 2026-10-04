import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { paragraphLines, parseReadingBlocks } from "../src/features/book-builder/reading-blocks";
import type { ParagraphElementMetadata } from "../src/app/api";

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
  const version = { current: { identity: "synthetic-book:7", updatedAt: expectedUpdatedAt } as { identity: string; updatedAt: string } | null };
  const calls: unknown[][] = [];
  const refetches: string[] = [];
  const effects: [string, unknown][] = [];
  const setter = (name: string) => (value: unknown) => { effects.push([name, value]); };
  const forbidden = () => { assert.fail("Recovery must not save old text or guess metadata"); };
  const bindings: Record<string, unknown> = {
    accessToken: "synthetic-token-not-a-credential",
    reviewBookId: "synthetic-book",
    reviewPageNumber: 7,
    reviewBlockLoadError,
    reviewPartialSave: false,
    reviewDraftConflict: false,
    activeOcrOperationsRef: { current: active },
    reviewDraftVersionRef: version,
    reviewOcrMode: "LOCAL",
    reviewImageRotation: 0,
    originalReviewImageRotation: 0,
    reviewImageCrop: null,
    originalReviewImageCrop: null,
    equalReviewImageCrop: (a: unknown, b: unknown) => a === b,
    selectedOcrModel: "synthetic-vision-model",
    resolveVisionPromptOverride: (value: string) => value.trim(),
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
  for (const name of ["setReviewError", "setReviewMessage", "setIsSavingReview", "setIsRerunningOcr", "setIsReviewOcrMenuVisible", "setReviewOcrMode", "setReviewPromptOverride", "setIsReviewPromptEditorOpen"]) bindings[name] = setter(name);
  for (const name of ["reviewPageQuery", "reviewAnnotationsQuery", "reviewNavigationQuery", "booksQuery"]) {
    bindings[name] = { refetch: async () => { assert.equal(version.current, null); refetches.push(name); } };
  }
  Object.assign(bindings, overrides);
  return { run: evaluateHandler("handleRerunOcr", bindings, oldGuard), calls, refetches, effects, active, version };
}

function assertRecovery(harness: ReturnType<typeof recoveryHarness>, mode: string) {
  assert.equal(harness.calls.length, 1, "OCR recovery must reach rerunOcrPage exactly once");
  assert.deepEqual(harness.calls[0], ["synthetic-token-not-a-credential", "synthetic-book", 7, {
    expectedUpdatedAt,
    ...(mode === "VISION" ? { ocrModel: "synthetic-vision-model", promptOverride: "synthetic prompt" } : {}),
    ocrMode: mode
  }]);
  assert.deepEqual(harness.refetches.sort(), ["booksQuery", "reviewAnnotationsQuery", "reviewNavigationQuery", "reviewPageQuery"]);
  assert.deepEqual([...harness.active], ["other-operation"]);
  assert.equal(harness.version.current, null);
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

for (const mode of ["TEXTRACT", "VISION", "LOCAL"]) {
  test(`${mode} recovers a metadata load error using the exact FF6 version, without old text or guessed metadata`, async () => {
    const harness = recoveryHarness();
    await harness.run(mode, "  synthetic prompt  ");
    assertRecovery(harness, mode);
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
