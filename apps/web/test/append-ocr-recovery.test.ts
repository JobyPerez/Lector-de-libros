import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { loadOcrConfig } from "./ocr-config-fixture";

const source = ts.createSourceFile("BookBuilderPage.tsx", readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const normalizeOcrOptions = loadOcrConfig().normalizeOcrOptions;
type Choice = "retry" | "skip" | "cancel";
type Summary = { bookId: string; destination: string; failedCount: number; totalPages: number; ocrInput: { pageIds: string[]; [key: string]: unknown } };

function extractNode(predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, "Expected exactly one matching handler/effect");
  assert.notEqual(matches[0]!.parent, source);
  return matches[0]!;
}

function evaluate(text: string, bindings: Record<string, unknown>) {
  const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
}

function handler(name: string, bindings: Record<string, unknown>) {
  const node = extractNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return evaluate(`${node.getText(source)}\nreturn ${name};`, bindings) as (...args: any[]) => any;
}

function effect(marker: string, bindings: Record<string, unknown>) {
  const node = extractNode((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === "useEffect" && node.arguments[0]!.getText(source).includes(marker)) as ts.CallExpression;
  return evaluate(`return (${node.arguments[0]!.getText(source)})();`, bindings) as (() => void) | undefined;
}

function failureHarness() {
  let now = 1000;
  let failure: { deadline: number; fileName: string; message: string; pageIndex: number; totalPages: number } | null = null;
  const seconds: number[] = [];
  const resolver = { current: null as ((choice: Choice) => void) | null };
  const callbacks = new Map<number, () => void>();
  let id = 0;
  const bindings = {
    Date: { now: () => now },
    appendOcrFailureResolverRef: resolver,
    setAppendOcrFailure: (value: typeof failure) => { failure = value; },
    setAppendOcrFailureSeconds: (value: number) => { seconds.push(value); },
    window: {
      setInterval: (callback: () => void, milliseconds: number) => {
        assert.equal(milliseconds, 1000);
        callbacks.set(++id, callback);
        return id;
      },
      clearInterval: (timer: number) => { assert.ok(callbacks.delete(timer)); }
    }
  };
  const resolve = handler("resolveAppendOcrFailure", bindings);
  const request = handler("requestAppendOcrFailureChoice", bindings);
  return {
    request, resolve, resolver, seconds, callbacks,
    get failure() { return failure; },
    setNow(value: number) { now = value; },
    mountTimer() { return effect("const seconds = Math.max", { ...bindings, appendOcrFailure: failure, resolveAppendOcrFailure: resolve }); }
  };
}

const failureInput = { fileName: "synthetic.png", message: "synthetic OCR failure", pageIndex: 1, totalPages: 2 };

test("failure countdown waits exactly 60 seconds, then skips once and clears its resolver", async () => {
  const h = failureHarness();
  const choices: Choice[] = [];
  const pending = h.request(failureInput).then((choice: Choice) => { choices.push(choice); });
  assert.deepEqual(h.failure, { ...failureInput, deadline: 61000 });
  const cleanup = h.mountTimer()!;
  const tick = [...h.callbacks.values()][0]!;
  assert.equal(h.seconds.at(-1), 60);
  h.setNow(60001);
  tick();
  assert.equal(h.seconds.at(-1), 1);
  assert.ok(h.resolver.current);
  assert.deepEqual(choices, []);
  h.setNow(61000);
  tick();
  await pending;
  assert.equal(h.seconds.at(-1), 0);
  assert.equal(h.failure, null);
  assert.equal(h.resolver.current, null);
  tick();
  h.resolve("retry");
  assert.deepEqual(choices, ["skip"]);
  cleanup();
  assert.equal(h.callbacks.size, 0);
});

for (const choice of ["retry", "skip", "cancel"] as const) {
  test(`manual ${choice} beats the deadline and an obsolete timer cannot resolve the next failure`, async () => {
    const h = failureHarness();
    const pending = h.request(failureInput);
    const cleanup = h.mountTimer()!;
    const staleTick = [...h.callbacks.values()][0]!;
    h.setNow(60999);
    h.resolve(choice);
    h.setNow(61000);
    staleTick();
    assert.equal(await pending, choice);
    const next = h.request({ ...failureInput, pageIndex: 2 });
    const nextResolver = h.resolver.current;
    h.setNow(200000);
    staleTick();
    assert.equal(h.resolver.current, nextResolver);
    assert.equal(h.failure?.pageIndex, 2);
    cleanup();
    const cleanupNext = h.mountTimer()!;
    assert.equal(await next, "skip");
    cleanupNext();
    assert.equal(h.callbacks.size, 0);
  });
}

function appendHarness(outcomes: (string | Error)[], choices: Choice[], overrides: Record<string, unknown> = {}) {
  const calls: { file: unknown; options: Record<string, unknown> }[] = [];
  const effects: [string, any][] = [];
  const active = new Set(["review"]);
  const mounted = { current: true };
  const cancelled = { current: false };
  const files = [{ name: "same.png" }, { name: "same.png" }, { name: "third.png" }];
  const setter = (name: string) => (value: unknown) => { effects.push([name, value]); };
  let progress: unknown = null;
  let uuid = 0;
  const bindings: Record<string, unknown> = {
    accessToken: "synthetic-token", selectedBookId: "synthetic-book", selectedAppendFiles: files,
    selectedAppendBook: { languageCode: "es" }, appendSelection: { canRunOcr: () => true, selectedModelId: "synthetic-vision-model" },
    appendOcrMode: "VISION", appendAdvancedLayout: true, appendPromptOverride: "  synthetic prompt  ",
    appendResumeState: null, appendAfterPageNumber: 7, appendFailedFileIndices: [], appendPendingOcrPageIds: [],
    reviewBookId: "different-book", returnTo: "/books/synthetic-book/pages?page=7",
    activeOcrOperationsRef: { current: active }, isMountedRef: mounted, isAppendCancelRequestedRef: cancelled,
    normalizeOcrOptions, normalizeBookLanguageCode: (value: string) => value,
    crypto: { randomUUID: () => `progress-${++uuid}` },
    // Preserve file identity without requiring browser File objects in Node.
    FormData: class {
      values = new Map<string, unknown>();
      append(key: string, value: unknown) { this.values.set(key, value); }
      get(key: string) { return this.values.get(key); }
    },
    appendImagesToBook: async (token: string, bookId: string, form: { get(key: string): unknown }, options: Record<string, unknown>) => {
      assert.equal(token, "synthetic-token");
      assert.equal(bookId, "synthetic-book");
      assert.equal(form.get("languageCode"), "es");
      calls.push({ file: form.get("images"), options });
      assert.ok(outcomes.length, "Unexpected extra image import (possible duplication)");
      const outcome = outcomes.shift()!;
      if (outcome instanceof Error) throw outcome;
      const afterPage = options.afterPage as number;
      return { book: { bookId }, addedPages: 1, addedPageIds: [outcome], insertionStartPageNumber: afterPage + 1, nextAfterPage: afterPage + 1 };
    },
    fetchAppendImagesImportProgress: async () => ({ progress: { insertedPages: 0 } }),
    requestAppendOcrFailureChoice: async (failure: typeof failureInput) => {
      effects.push(["choice", failure]);
      assert.ok(choices.length, "Unexpected extra failure choice");
      return choices.shift();
    },
    setAppendImportProgress: (value: any) => { progress = typeof value === "function" ? value(progress) : value; },
    ensureAppendScreenWakeLock: async () => {}, prepareCompletionSound: setter("prepareSound"),
    playCompletionSound: setter("sound"), clearAppendSelection: setter("clear"), navigate: setter("navigate"),
    booksQuery: { refetch: async () => { effects.push(["refetch", true]); } }
  };
  for (const name of ["setIsAppending", "setAppendError", "setIsAppendCancelRequested", "setAppendProgressOffset", "setAppendProgressId", "setAppendResumeState", "setAppendFailedFileIndices", "setAppendPendingOcrPageIds", "setAppendOcrSummary", "setReviewPageNumber", "setReviewPageId"]) bindings[name] = setter(name);
  Object.assign(bindings, overrides);
  return {
    run: () => handler("handleAppendImages", bindings)({ preventDefault() {} }),
    calls, effects, files, active, mounted, cancelled,
    get summary() { return effects.find(([name]) => name === "setAppendOcrSummary")?.[1] as Summary | undefined; }
  };
}

test("repeated failures count unique file indices; skip inserts once and summary targets only pending IDs", async () => {
  const error = new Error("synthetic OCR failure");
  const h = appendHarness([error, error, "recovered-id", error, "pending-id", "success-id"], ["retry", "retry", "skip"]);
  await h.run();
  assert.deepEqual(h.effects.filter(([name]) => name === "setAppendFailedFileIndices").map(([, value]) => value), [[0], [0], [0, 1]]);
  assert.deepEqual(h.effects.filter(([name]) => name === "choice").map(([, value]) => value.pageIndex), [1, 1, 2]);
  assert.deepEqual(h.calls.map(({ file }) => file), [h.files[0], h.files[0], h.files[0], h.files[1], h.files[1], h.files[2]]);
  assert.deepEqual(h.calls.map(({ options }) => options.afterPage), [7, 7, 7, 8, 8, 9]);
  assert.deepEqual(h.calls[4]!.options, { afterPage: 8, ocrMode: "VISION", progressId: "progress-5", skipOcr: true });
  assert.equal(new Set(h.calls.map(({ options }) => options.progressId)).size, 6);
  assert.deepEqual(h.effects.filter(([name]) => name === "setAppendPendingOcrPageIds"), [["setAppendPendingOcrPageIds", ["pending-id"]]]);
  assert.deepEqual(h.summary, {
    bookId: "synthetic-book", destination: "/books/synthetic-book/pages?page=7", failedCount: 2, totalPages: 3,
    ocrInput: { pageIds: ["pending-id"], ocrMode: "VISION", advancedLayout: true, ocrModel: "synthetic-vision-model", promptOverride: "synthetic prompt" }
  });
  assert.deepEqual(h.effects.filter(([name]) => name === "navigate"), []);
  assert.deepEqual(h.effects.filter(([name]) => name === "sound"), [["sound", "error"]]);
  assert.deepEqual([...h.active], ["review"]);
  assert.deepEqual(h.effects.filter(([name]) => name === "setIsAppending"), [["setIsAppending", true], ["setIsAppending", false]]);
});

test("a successful retry remains in the historical failure count but never becomes pending OCR", async () => {
  const h = appendHarness([new Error("failure"), "recovered-id"], ["retry"], { selectedAppendFiles: [{ name: "only.png" }] });
  await h.run();
  assert.equal(h.summary?.failedCount, 1);
  assert.deepEqual(h.summary?.ocrInput.pageIds, []);
  assert.deepEqual(h.effects.filter(([name]) => name === "sound"), [["sound", "success"]]);
});

for (const decision of ["timeout", "retry", "skip", "cancel"] as const) {
  test(`${decision} resolves a live append failure without a duplicate insertion at the deadline`, async () => {
    const failure = failureHarness();
    let notify!: () => void;
    const requested = new Promise<void>((resolve) => { notify = resolve; });
    const h = appendHarness([new Error("failure"), "inserted-id"], [], {
      selectedAppendFiles: [{ name: "only.png" }],
      requestAppendOcrFailureChoice: (input: typeof failureInput) => {
        const pending = failure.request(input);
        notify();
        return pending;
      }
    });
    const pending = h.run();
    await requested;
    const cleanup = failure.mountTimer()!;
    const tick = [...failure.callbacks.values()][0]!;
    if (decision !== "timeout") {
      failure.setNow(60999);
      failure.resolve(decision);
    }
    failure.setNow(61000);
    tick();
    tick();
    await pending;
    tick();
    cleanup();
    assert.equal(h.calls.length, decision === "cancel" ? 1 : 2);
    if (decision !== "cancel") {
      assert.equal(h.calls[1]!.options.skipOcr, decision === "retry" ? undefined : true);
      assert.deepEqual(h.summary?.ocrInput.pageIds, decision === "retry" ? [] : ["inserted-id"]);
      assert.deepEqual(h.effects.find(([name]) => name === "setAppendResumeState")?.[1], { completedFiles: 1, insertionStartPageNumber: 8, nextAfterPage: 8 });
    } else {
      assert.equal(h.summary, undefined);
      assert.deepEqual(h.effects.filter(([name]) => ["refetch", "navigate"].includes(name)), []);
    }
    assert.equal(failure.resolver.current, null);
    assert.deepEqual([...h.active], ["review"]);
  });
}

test("resume preserves pending IDs and counts absolute file indices without reimporting completed files", async () => {
  const h = appendHarness([new Error("failure"), "pending-new"], ["skip"], {
    selectedAppendFiles: [{ name: "done.png" }, { name: "remaining.png" }],
    appendResumeState: { completedFiles: 1, insertionStartPageNumber: 8, nextAfterPage: 8 },
    appendFailedFileIndices: [0, 0], appendPendingOcrPageIds: ["pending-old"]
  });
  await h.run();
  assert.deepEqual(h.calls.map(({ file }) => (file as { name: string }).name), ["remaining.png", "remaining.png"]);
  assert.deepEqual(h.effects.find(([name]) => name === "setAppendFailedFileIndices")?.[1], [0, 1]);
  assert.equal(h.summary?.failedCount, 2);
  assert.deepEqual(h.summary?.ocrInput.pageIds, ["pending-old", "pending-new"]);
});

test("an error after insertion uses server progress and never retries or inserts a duplicate", async () => {
  const h = appendHarness([new Error("response lost")], [], {
    selectedAppendFiles: [{ name: "only.png" }],
    fetchAppendImagesImportProgress: async () => ({ progress: { insertedPages: 1, insertionStartPageNumber: 8, nextAfterPage: 8 } })
  });
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.summary, undefined);
  assert.deepEqual(h.effects.filter(([name]) => name === "choice"), []);
  assert.deepEqual(h.effects.find(([name]) => name === "setAppendResumeState")?.[1], { completedFiles: 1, insertionStartPageNumber: 8, nextAfterPage: 8 });
});

function recoveryHarness(summary: Summary | null, overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const effects: [string, unknown][] = [];
  const busy = { current: false };
  const job = { jobId: "synthetic/job ?", status: "PENDING" };
  const forbidden = () => assert.fail("Recovery must not import images or rerun OCR by page number");
  const bindings = {
    accessToken: "synthetic-token", appendOcrSummary: summary, appendRecoveryBusyRef: busy,
    appendRecoveryJobId: "",
    setAppendRecoveryJobId: (value: string) => { bindings.appendRecoveryJobId = value; effects.push(["jobId", value]); },
    setAppendOcrSummary: (value: Summary | null) => { bindings.appendOcrSummary = value; effects.push(["summary", value]); },
    useAuthStore: { getState: () => ({ user: { userId: "synthetic-user" } }) },
    localStorage: { setItem: (key: string, value: string) => effects.push(["storage", [key, value]]) },
    setIsStartingAppendRecovery: (value: boolean) => effects.push(["loading", value]),
    setAppendError: (value: unknown) => effects.push(["error", value]),
    startBookPagesOcrJob: async (...args: unknown[]) => { calls.push(args); return job; },
    queryClient: { setQueryData: (key: unknown, value: unknown) => effects.push(["cache", [key, value]]) },
    navigate: (value: string) => effects.push(["navigate", value]),
    appendImagesToBook: forbidden, createImageBook: forbidden, rerunOcrPage: forbidden, FormData: forbidden,
    ...overrides
  };
  return { run: () => handler("handleAppendOcrRecovery", bindings)(), calls, effects, busy, job,
    get summary() { return bindings.appendOcrSummary; },
    get jobId() { return bindings.appendRecoveryJobId; }
  };
}

for (const mode of ["LOCAL", "VISION", "TEXTRACT"] as const) {
  test(`${mode} recovery starts a job with saved IDs/options and no image import`, async () => {
    const h = appendHarness([new Error("failure"), "stable-page-id"], ["skip"], { selectedAppendFiles: [{ name: "only.png" }], appendOcrMode: mode });
    await h.run();
    const summary = h.summary!;
    assert.deepEqual(summary.ocrInput, { pageIds: ["stable-page-id"], ocrMode: mode, advancedLayout: mode !== "LOCAL",
      ...(mode !== "LOCAL" ? { ocrModel: "synthetic-vision-model", promptOverride: "synthetic prompt" } : {}) });
    const recovery = recoveryHarness(summary);
    await recovery.run();
    assert.deepEqual(recovery.calls, [["synthetic-token", "synthetic-book", summary.ocrInput]]);
    assert.equal(recovery.calls[0]![2], summary.ocrInput);
    assert.deepEqual(recovery.effects, [["loading", true], ["error", null],
      ["cache", [["book-pages-ocr-job", "synthetic-book", recovery.job.jobId], recovery.job]],
      ["jobId", recovery.job.jobId],
      ["storage", ["lector:gallery-ocr:synthetic-user:synthetic-book", recovery.job.jobId]], ["loading", false]]);
    assert.equal(recovery.summary, summary, "The summary must remain open after starting recovery");
    assert.equal(recovery.jobId, recovery.job.jobId);
    assert.equal(recovery.busy.current, false);
  });
}

const summaryFixture: Summary = { bookId: "synthetic-book", destination: "/books/synthetic-book/pages", failedCount: 1, totalPages: 1, ocrInput: { pageIds: ["stable-page-id"], ocrMode: "LOCAL", advancedLayout: false } };

test("recovery blocks duplicate clicks while the job request is pending", async () => {
  let finish!: (value: { jobId: string }) => void;
  let requests = 0;
  const h = recoveryHarness(summaryFixture, { startBookPagesOcrJob: () => { requests++; return new Promise((resolve) => { finish = resolve; }); } });
  const pending = h.run();
  assert.equal(h.busy.current, true);
  await h.run();
  assert.equal(requests, 1);
  finish({ jobId: "one-job" });
  await pending;
  assert.equal(h.busy.current, false);
  assert.equal(h.effects.filter(([name]) => name === "navigate").length, 0);
  assert.equal(h.jobId, "one-job");
  await h.run();
  assert.equal(requests, 1, "A second click after completion must not start another job");
});

test("recovery guards missing credentials/summary and releases the busy flag on failure", async () => {
  for (const h of [recoveryHarness(null), recoveryHarness(summaryFixture, { accessToken: null }), recoveryHarness(summaryFixture, { appendRecoveryBusyRef: { current: true } })]) {
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.effects, []);
  }
  const h = recoveryHarness(summaryFixture, { startBookPagesOcrJob: async () => { throw new Error("synthetic job failure"); } });
  await h.run();
  assert.deepEqual(h.effects, [["loading", true], ["error", null], ["error", "synthetic job failure"], ["loading", false]]);
  assert.equal(h.busy.current, false);
});

test("recovery does nothing when a job ID already exists", async () => {
  const h = recoveryHarness(summaryFixture, { appendRecoveryJobId: "existing-job" });
  await h.run();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.effects, []);
  assert.equal(h.jobId, "existing-job");
});

function recoveryQuery(overrides: Record<string, unknown> = {}) {
  const node = extractNode((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.name.text === "appendRecoveryQuery") as ts.VariableDeclaration;
  assert.ok(node.initializer && ts.isCallExpression(node.initializer));
  assert.equal(node.initializer.expression.getText(source), "useQuery");
  return evaluate(`return (${node.initializer.arguments[0]!.getText(source)});`, {
    accessToken: "synthetic-token", appendOcrSummary: summaryFixture, appendRecoveryJobId: "tracked/job ?",
    fetchBookPagesOcrJob: (...args: unknown[]) => args, ...overrides
  }) as { queryKey: unknown[]; queryFn: () => unknown; enabled: boolean;
    refetchInterval: (query: { state: { data?: { status: string } } }) => number | false };
}

test("recovery query uses the summary book and exact job ID for its cache key and fetch", () => {
  const query = recoveryQuery();
  assert.deepEqual(query.queryKey, ["book-pages-ocr-job", "synthetic-book", "tracked/job ?"]);
  assert.deepEqual(query.queryFn(), ["synthetic-token", "synthetic-book", "tracked/job ?"]);
  const other = recoveryQuery({ appendOcrSummary: { ...summaryFixture, bookId: "other-book" }, appendRecoveryJobId: "other-job" });
  assert.deepEqual(other.queryKey, ["book-pages-ocr-job", "other-book", "other-job"]);
  assert.deepEqual(other.queryFn(), ["synthetic-token", "other-book", "other-job"]);
});

test("recovery query is enabled only with credentials, summary and a job ID", () => {
  assert.equal(recoveryQuery().enabled, true);
  for (const overrides of [{ accessToken: null }, { appendOcrSummary: null }, { appendRecoveryJobId: "" }]) {
    assert.equal(recoveryQuery(overrides).enabled, false);
  }
});

test("recovery query polls missing, PENDING and RUNNING data and stops for terminal states", () => {
  const { refetchInterval } = recoveryQuery();
  assert.equal(refetchInterval({ state: {} }), 2000);
  for (const status of ["PENDING", "RUNNING"]) {
    assert.equal(refetchInterval({ state: { data: { status } } }), 2000, status);
  }
  for (const status of ["READY", "FAILED", "CANCELLED"]) {
    assert.equal(refetchInterval({ state: { data: { status } } }), false, status);
  }
});

function recoveryDialog(overrides: Record<string, unknown> = {}) {
  const node = extractNode((node) => ts.isConditionalExpression(node)
    && ts.isIdentifier(node.condition) && node.condition.text === "appendOcrSummary");
  return evaluate(`return (${node.getText(source)});`, {
    React, createPortal: (element: React.ReactElement) => element, document: { body: {} },
    appendOcrSummary: summaryFixture, appendRecoveryJobId: "tracked/job ?", appendRecoveryActive: true,
    appendRecoveryJob: undefined, appendRecoveryQuery: { isError: false }, appendError: null,
    isStartingAppendRecovery: false, navigate: () => assert.fail("Rendering must not navigate"),
    setAppendOcrSummary: () => assert.fail("Rendering must not close the dialog"),
    setAppendRecoveryJobId: () => assert.fail("Rendering must not reset the job"),
    handleAppendOcrRecovery: () => assert.fail("Rendering must not start another job"), ...overrides
  }) as React.ReactElement | null;
}

test("starting recovery keeps the accessible result dialog and job status visible without navigation", async () => {
  const h = recoveryHarness(summaryFixture);
  await h.run();
  const html = renderToStaticMarkup(recoveryDialog({ appendOcrSummary: h.summary, appendRecoveryJobId: h.jobId }));
  assert.match(html, /aria-label="Resultado del OCR"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Reintento de OCR/);
  assert.match(html, /Ver en galería/);
  assert.doesNotMatch(html, /Reintentar páginas sin OCR/);
  assert.deepEqual(h.effects.filter(([name]) => ["navigate", "summary"].includes(name)), []);
});

test("query errors are accessible in the open dialog and offer a working refetch action", () => {
  let refetches = 0;
  const appendRecoveryQuery = { isError: true, refetch: () => { refetches++; } };
  const html = renderToStaticMarkup(recoveryDialog({ appendRecoveryQuery }));
  assert.match(html, /role="alert"/);
  assert.match(html, /No se pudo consultar el progreso/);
  assert.match(html, /El trabajo sigue en el servidor/);
  assert.match(html, /<button[^>]*type="button"[^>]*>Consultar de nuevo<\/button>/);
  assert.doesNotMatch(renderToStaticMarkup(recoveryDialog()), /No se pudo consultar el progreso/);
  const node = extractNode((node) => ts.isJsxAttribute(node) && node.name.getText(source) === "onClick"
    && node.initializer?.getText(source).includes("appendRecoveryQuery.refetch()") === true) as ts.JsxAttribute;
  assert.ok(node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression);
  const retry = evaluate(`return (${node.initializer.expression.getText(source)});`, { appendRecoveryQuery }) as () => void;
  retry();
  assert.equal(refetches, 1);
});

test("unmount cancels a waiting choice, clears timers/wake lock and prevents skip insertion", async () => {
  const failure = failureHarness();
  let choiceRequested!: () => void;
  const requested = new Promise<void>((resolve) => { choiceRequested = resolve; });
  const h = appendHarness([new Error("failure")], [], {
    selectedAppendFiles: [{ name: "only.png" }],
    requestAppendOcrFailureChoice: (input: typeof failureInput) => {
      const pending = failure.request(input);
      choiceRequested();
      return pending;
    }
  });
  const released: string[] = [];
  const retryTimer = { current: 11 as number | null };
  const toastTimer = { current: 12 as number | null };
  const cleanup = effect('isMountedRef.current = true', {
    isMountedRef: h.mounted, isAppendCancelRequestedRef: h.cancelled,
    appendOcrFailureResolverRef: failure.resolver, ocrRetryIntervalRef: retryTimer, reviewOcrToastTimeoutRef: toastTimer,
    window: { clearInterval: (id: number) => { assert.equal(id, 11); released.push("interval"); }, clearTimeout: (id: number) => { assert.equal(id, 12); released.push("timeout"); } },
    clearAppendCancelHold: () => released.push("hold"), releaseAppendScreenWakeLock: async () => { released.push("wake-lock"); }
  })!;
  const pending = h.run();
  await requested;
  const cleanupCountdown = failure.mountTimer()!;
  const staleTick = [...failure.callbacks.values()][0]!;
  cleanup();
  failure.setNow(100000);
  staleTick();
  cleanupCountdown();
  await pending;
  assert.equal(h.mounted.current, false);
  assert.equal(h.cancelled.current, true);
  assert.equal(failure.resolver.current, null);
  assert.equal(retryTimer.current, null);
  assert.equal(toastTimer.current, null);
  assert.deepEqual(released, ["interval", "timeout", "hold", "wake-lock"]);
  assert.equal(h.calls.length, 1, "Unmount must not insert the image with skipOcr");
  assert.equal(h.summary, undefined);
  assert.deepEqual(h.effects.filter(([name]) => ["navigate", "refetch", "sound"].includes(name)), []);
  assert.deepEqual([...h.active], ["review"]);
  assert.deepEqual(h.effects.filter(([name]) => name === "setIsAppending"), [["setIsAppending", true], ["setIsAppending", false]]);
});
