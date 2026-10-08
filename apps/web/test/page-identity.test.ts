import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { readingDraftSyncAction } from "../src/features/book-builder/reading-blocks";

const reader = source("../src/features/reader/ReaderPage.tsx");
const builder = source("../src/features/book-builder/BookBuilderPage.tsx");
const gallery = source("../src/features/book-pages/BookPagesGallery.tsx");
function source(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(file: ts.SourceFile, predicate: (node: ts.Node) => boolean) {
  let match: ts.Node | undefined;
  function visit(node: ts.Node) { if (!match && predicate(node)) match = node; ts.forEachChild(node, visit); }
  visit(file);
  assert.ok(match);
  return match;
}
function evaluate(text: string, bindings: Record<string, unknown>) {
  const code = ts.transpileModule(`const evaluated = ${text};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return evaluated;`)(...Object.values(bindings));
}
function queryOptions(file: ts.SourceFile, name: string, bindings: Record<string, unknown>) {
  const node = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name) as ts.VariableDeclaration;
  return evaluate((node.initializer as ts.CallExpression).arguments[0]!.getText(file), bindings);
}
function effect(file: ts.SourceFile, marker: string, bindings: Record<string, unknown>) {
  const node = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.arguments[0]!.getText(file).includes(marker)) as ts.CallExpression;
  return evaluate(node.arguments[0]!.getText(file), bindings) as () => void;
}
function handler(file: ts.SourceFile, name: string, bindings: Record<string, unknown>) {
  const node = find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return evaluate(node.getText(file), bindings) as (...args: any[]) => Promise<void>;
}
function transport() {
  const calls: { url: string; options: RequestInit }[] = [];
  const source = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: Record<string, (...args: any[]) => Promise<any>> = {};
  new Function("exports", "require", "fetch", code)(api, () => ({}), async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ page: { pageId: "page-a", pageNumber: 9 }, updatedAt: "v2" }), { headers: { "content-type": "application/json" } });
  });
  return { api, calls };
}

test("gallery redirect retains pageId/reviewPageId when the listed number becomes stale", () => {
  const node = find(gallery, (node) => ts.isVariableDeclaration(node) && node.name.getText(gallery) === "to") as ts.VariableDeclaration;
  for (const action of ["read", "edit"]) {
    const href = evaluate(node.initializer!.getText(gallery), { action, bookId: "book", page: { pageId: "page-a", pageNumber: 1 } });
    const url = new URL(href, "http://synthetic.invalid");
    assert.equal(url.searchParams.get(action === "edit" ? "reviewPageId" : "pageId"), "page-a");
    assert.equal(url.searchParams.get(action === "edit" ? "reviewPage" : "page"), "1");
  }
});

test("reader and builder fetch moved pages by ID, with caches isolated from numeric and other ID requests", async () => {
  for (const [file, name, idKey, numberKey] of [[reader, "pageQuery", "currentPageId", "currentPageNumber"], [builder, "reviewPageQuery", "reviewPageId", "reviewPageNumber"]] as const) {
    const { api, calls } = transport();
    const bindings = { accessToken: "token", bookId: "book", reviewBookId: "book", isReviewOnlyMode: true, isPageLocationReady: true, fetchBookPage: api.fetchBookPage, [idKey]: "page-a", [numberKey]: 1 };
    const options = queryOptions(file, name, bindings);
    const response = await options.queryFn();
    assert.equal(response.page.pageNumber, 9);
    assert.equal(new URL(calls[0]!.url).searchParams.get("pageId"), "page-a");
    if (file === builder) assert.equal(new URL(calls[0]!.url).searchParams.get("includeInactive"), "true");
    assert.deepEqual(options.queryKey, queryOptions(file, name, { ...bindings, [numberKey]: 9 }).queryKey);
    assert.notDeepEqual(options.queryKey, queryOptions(file, name, { ...bindings, [idKey]: "page-b" }).queryKey);
    assert.notDeepEqual(options.queryKey, queryOptions(file, name, { ...bindings, [idKey]: "" }).queryKey);
  }
  assert.equal(queryOptions(reader, "pageQuery", { accessToken: "token", bookId: "book", isPageLocationReady: false, currentPageId: "", currentPageNumber: 1 }).enabled, false);
});

test("canonical numbers follow the loaded stable page, never an in-flight cache or another ID", () => {
  for (const [file, queryName, idName, idSetter, numberSetter, marker] of [
    [reader, "pageQuery", "currentPageId", "setCurrentPageId", "setCurrentPageNumber", "setCurrentPageId(page.pageId)"],
    [builder, "reviewPageQuery", "reviewPageId", "setReviewPageId", "setReviewPageNumber", "setReviewPageId(page.pageId)"]
  ] as const) {
    const updates: unknown[][] = [];
    const bindings = { [queryName]: { data: { page: { pageId: "page-a", pageNumber: 9 } }, isFetching: false }, [idName]: "page-a", isPageLocationReady: true,
      progressHydratedRef: { current: true }, [idSetter]: (value: unknown) => updates.push(["id", value]), [numberSetter]: (value: unknown) => updates.push(["number", value]) };
    effect(file, marker, bindings)();
    assert.deepEqual(updates, [["id", "page-a"], ["number", 9]]);
    updates.length = 0;
    effect(file, marker, { ...bindings, [idName]: "page-b" })();
    effect(file, marker, { ...bindings, [queryName]: { ...bindings[queryName], isFetching: true } })();
    assert.deepEqual(updates, []);
    if (file === reader) {
      effect(file, marker, { ...bindings, isPageLocationReady: false })();
      effect(file, marker, { ...bindings, progressHydratedRef: { current: false } })();
      assert.deepEqual(updates, [], "cached page 1 cannot override progress hydration");
    }
  }
});

test("pending reader navigation cannot pin stale numeric cache data before its fresh fetch completes", () => {
  effect(reader, "if (!pendingRouteNavigationRef.current", { pendingRouteNavigationRef: { current: { pageNumber: 1 } }, isPageLocationReady: true,
    pageQuery: { data: { page: { pageId: "wrong-cached-page", pageNumber: 1 } }, isFetching: true } })();
  effect(reader, "const pendingParagraphTarget =", { pendingParagraphTargetRef: { current: 1 }, pageQuery: { isFetching: true } })();
  // No navigation or progress dependencies are injected: proceeding past the guards would fail.
});

test("canonical URL updates keep identity and use the returned position", () => {
  const calls: any[][] = [];
  effect(reader, "nextSearchParams.set", { progressHydratedRef: { current: true }, currentPageNumber: 9, currentPageId: "page-a", resolvedRequestedPageNumber: 9,
    pendingRouteNavigationRef: { current: null }, location: { pathname: "/books/book", search: "?page=1&pageId=page-a", state: { returnTo: "/books/book/pages" } }, navigate: (...args: any[]) => calls.push(args) })();
  assert.equal(calls[0]![0].search, "?page=9&pageId=page-a");
  calls.length = 0;
  effect(builder, 'params.set("reviewPage"', { isReviewOnlyMode: true, reviewPageQuery: { data: { page: { pageNumber: 9, pageId: "page-a" } }, isFetching: false },
    isReviewDirty: false, hasPendingReviewCrop: false, isVisualEditorBusy: false,
    location: { pathname: "/builder", search: "?reviewBookId=book&reviewPage=1&reviewPageId=page-a", hash: "#review-ocr", state: null }, navigate: (...args: any[]) => calls.push(args) })();
  assert.equal(calls[0]![0].search, "?reviewBookId=book&reviewPage=9&reviewPageId=page-a");
});

test("reorder refetch preserves dirty builder identity instead of initializing another positional draft", () => {
  const version = { current: { identity: "book:page-a", updatedAt: "v1" } };
  const dirty = { current: true };
  const conflicts: boolean[] = [];
  const bindings = { reviewBookId: "book", reviewPageId: "page-a", reviewPageNumber: 9, reviewPageQuery: { data: { page: { pageId: "page-a", pageNumber: 9, updatedAt: "v2" } }, isFetching: false },
    reviewDraftVersionRef: version, reviewDraftDirtyRef: dirty, readingDraftSyncAction, setReviewDraftConflict: (value: boolean) => conflicts.push(value) };
  effect(builder, "const remoteVersion", bindings)();
  assert.deepEqual(conflicts, [true]);
  assert.equal(version.current.identity, "book:page-a");
  assert.equal(version.current.updatedAt, "v1");
  assert.equal(dirty.current, true);
});

test("all single-page mutation transports retain the immutable target, including image/rotation/OCR/elements", async () => {
  const { api, calls } = transport();
  const requests: [string, unknown][] = [
    ["saveVisualPageDocument", { expectedUpdatedAt: "v1", document: {} }],
    ["updateOcrPage", { editedText: "text", expectedUpdatedAt: "v1" }],
    ["updatePageElements", { expectedUpdatedAt: "v1", elements: [] }],
    ["updateBookPageImageRotation", { rotation: 90 }],
    ["rerunOcrPage", { expectedUpdatedAt: "v1", ocrMode: "LOCAL" }],
    ["uploadBookPageImage", new FormData()]
  ];
  for (const [method, body] of requests) {
    await api[method]!("token", "book", 1, body, "page-a");
    assert.equal(new URL(calls.at(-1)!.url).searchParams.get("pageId"), "page-a", method);
    assert.equal((calls.at(-1)!.options.headers as Record<string, string>).Authorization, "Bearer token");
  }
  await api.fetchBookPageImage!("token", "book", 1, "v1", true, "page-a");
  assert.equal(new URL(calls.at(-1)!.url).searchParams.get("pageId"), "page-a");
  assert.equal(new URL(calls.at(-1)!.url).searchParams.get("original"), "true");
  assert.equal(new URL(calls.at(-1)!.url).searchParams.has("thumbnail"), false);
});

test("gallery image previews alone opt into thumbnail transport and use a thumbnail-specific cache key", async () => {
  const { api, calls } = transport();
  const options = queryOptions(gallery, "imageQuery", { bookId: "book", accessToken: "token", visible: true, image: true,
    page: { pageId: "page-a", pageNumber: 9, updatedAt: "v1", preview: { kind: "IMAGE" } }, fetchBookPageImage: api.fetchBookPageImage });
  await options.queryFn();
  assert.equal(options.queryKey.at(-1), "thumbnail");
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("thumbnail"), "true");
  assert.equal(url.searchParams.get("pageId"), "page-a");
  assert.equal(url.searchParams.has("original"), false);
  await api.fetchBookPageImage!("token", "book", 9, "v1", false, "page-a");
  assert.equal(new URL(calls[1]!.url).searchParams.has("thumbnail"), false, "existing reader/editor requests remain full size");
});

test("reader gallery links retain current identity/position and gallery-return recognition accepts origin search", () => {
  const node = find(reader, (node) => ts.isJsxOpeningElement(node) && node.getText(reader).includes('aria-label="Galería de páginas"')) as ts.JsxOpeningElement;
  const to = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(reader) === "to") as ts.JsxAttribute;
  const href = evaluate((to.initializer as ts.JsxExpression).expression!.getText(reader), { bookId: "book", currentPageId: "page-a", currentPageNumber: 9,
    pageQuery: { data: { page: { pageId: "stale-cache" } } } });
  assert.equal(href, "/books/book/pages?pageId=page-a&page=9");
  const flag = find(reader, (node) => ts.isVariableDeclaration(node) && node.name.getText(reader) === "isReturningToGallery") as ts.VariableDeclaration;
  assert.equal(evaluate(flag.initializer!.getText(reader), { bookId: "book", readerReturnTo: href }), true);
  assert.equal(evaluate(flag.initializer!.getText(reader), { bookId: "book", readerReturnTo: "/books/other/pages?pageId=page-a" }), false);
});

test("builder image editing snapshots the loaded page ID before asynchronous image rendering", async () => {
  const { api, calls } = transport();
  const query = { data: { page: { pageId: "page-a" } } };
  const run = handler(builder, "persistReviewImageEdits", { accessToken: "token", reviewBookId: "book", reviewPageNumber: 1, reviewPageQuery: query,
    reviewImageSourceBlob: { blob: new Blob(["synthetic"], { type: "image/png" }), key: "source-a" }, reviewSourceImageKey: "source-a",
    reviewPageIdentity: "book:page-a", reviewDraftVersionRef: { current: { identity: "book:page-a" } },
    resolveReviewImageOutputMimeType: () => "image/png", renderReviewImageBlob: async () => { query.data.page.pageId = "page-b"; return new Blob(["edited"]); },
    reviewImageCrop: null, reviewImageRotation: 90, buildReviewImageFileName: () => "page.png", uploadBookPageImage: api.uploadBookPageImage });
  await run("v1");
  assert.equal(new URL(calls[0]!.url).searchParams.get("pageId"), "page-a");
  assert.equal((calls[0]!.options.body as FormData).get("expectedUpdatedAt"), "v1");
});

test("reader progress writes stable paragraph identity even when numeric page/sequence are stale", async () => {
  const { api, calls } = transport();
  const persisted = { current: null };
  const run = handler(reader, "persistProgress", { accessToken: "token", bookId: "book", lastPersistedProgressRef: persisted,
    pageQuery: { data: { book: { totalParagraphs: 10 } } }, setIsSavingProgress: () => {}, updateProgress: api.updateProgress });
  await run({ paragraphId: "paragraph-a", paragraphNumber: 2, sequenceNumber: 3 }, 1);
  assert.equal(JSON.parse(String(calls[0]!.options.body)).paragraphId, "paragraph-a");
  await run({ paragraphId: "paragraph-b", paragraphNumber: 2, sequenceNumber: 3 }, 1);
  assert.equal(calls.length, 2, "different paragraphs at the same numeric position cannot share progress deduplication");
  assert.equal(JSON.parse(String(calls[1]!.options.body)).paragraphId, "paragraph-b");
  await run({ paragraphNumber: 2, sequenceNumber: 3 }, 1);
  assert.equal(calls.length, 2, "missing paragraph identity must not fall back to stale numeric progress");
});

test("reader and builder delete their loaded stable page rather than the page now at its old number", async () => {
  for (const [file, name] of [[reader, "handleDeleteCurrentPage"], [builder, "handleDeleteReviewPage"]] as const) {
    const deletes: unknown[][] = [];
    const noop = () => {};
    const query = { data: { page: { pageId: "page-a", pageNumber: 9 } }, isFetching: false };
    const bindings: Record<string, unknown> = { accessToken: "token", bookId: "book", currentPageNumber: 1, reviewBookId: "book", reviewPageNumber: 1,
      pageQuery: query, reviewPageQuery: query, selectedReviewBook: {}, canEditBook: true, isDeletingPage: false, isDeletingReviewPage: false, isSavingReview: false,
      window: { confirm: () => true }, deleteBookPage: async (...args: unknown[]) => { deletes.push(args); return { nextPageNumber: null, book: { sourceType: "PDF" } }; },
      booksQuery: { refetch: async () => {} }, reviewNavigationQuery: { refetch: async () => {} }, shelfReturnTo: "/", shelfAnchorBookId: "book", navigate: noop };
    for (const setter of ["setIsDeletingPage", "setReaderError", "clearAudioResource", "clearQueuedAudioBlocks", "setAutoPlay", "setReviewError", "setReviewMessage", "setIsDeletingReviewPage", "setIsReviewOcrMenuVisible", "setIsReviewIndexVisible", "setIsFloatingReviewHeaderExpanded"]) bindings[setter] = noop;
    await handler(file, name, bindings)();
    assert.deepEqual(deletes, [["token", "book", 1, "page-a"]]);
  }
});
