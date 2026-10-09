import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Simulate } from "react-dom/test-utils";
import { movePages, selectPageRange } from "../src/features/book-pages/page-order";
import { groupPagesByOutline } from "../src/features/book-pages/outline-groups";
import type { BookOutlineEntry } from "../src/app/api";
import { loadOcrConfig } from "./ocr-config-fixture";
import * as realRouter from "react-router-dom";
import { deferred, loadUnsavedChanges, withUnsavedDom } from "./unsaved-changes-fixture";

test("move preserves immutable IDs and relative order of a non-contiguous selection", () => {
  const order = ["a", "b", "c", "d", "e"];
  const selected = new Set(["d", "b"]);
  assert.deepEqual(movePages(order, selected, "a", "before"), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(movePages(order, selected, "e", "after"), ["a", "c", "e", "b", "d"]);
  assert.deepEqual(order, ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...selected], ["d", "b"]);
});

test("moving to a selected or missing target cannot lose pages", () => {
  const order = ["a", "b", "c"];
  assert.equal(movePages(order, new Set(["b"]), "b", "after"), order);
  assert.equal(movePages(order, new Set(["b"]), "missing", "before"), order);
  assert.equal(movePages(order, new Set(), "c", "before"), order);
  assert.equal(movePages(order, new Set(["missing"]), "c", "before"), order);
});

test("mobile/range selection is inclusive, additive, and supports backwards ranges", () => {
  assert.deepEqual([...selectPageRange(["a", "b", "c", "d"], new Set(["d"]), "c", "a")], ["d", "a", "b", "c"]);
  assert.deepEqual([...selectPageRange(["a", "b"], new Set(), null, "b")], ["b"]);
  assert.deepEqual([...selectPageRange(["a", "b"], new Set(), "deleted", "b")], ["b"]);
});

test("selection remains on the same page IDs after reorder", () => {
  const selected = new Set(["b", "d"]);
  const order = movePages(["a", "b", "c", "d"], selected, "a", "before");
  assert.deepEqual(order.filter((id) => selected.has(id)), ["b", "d"]);
  assert.deepEqual([...selectPageRange(order, selected, "b", "a")], ["b", "d", "a"]);
});

test("all small reorder combinations remain complete permutations", () => {
  const order = ["a", "b", "c", "d"];
  for (let mask = 0; mask < 16; mask++) {
    const selected = new Set(order.filter((_, index) => mask & (1 << index)));
    for (const target of order) for (const position of ["before", "after"] as const) {
      const next = movePages(order, selected, target, position);
      assert.equal(new Set(next).size, order.length);
      assert.deepEqual([...next].sort(), order);
      assert.deepEqual(next.filter((id) => selected.has(id)), order.filter((id) => selected.has(id)));
    }
  }
});

test("gallery transports authentication, optimistic order, stable deletion and persistent OCR endpoints", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const source = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: Record<string, (...args: any[]) => Promise<unknown>> = {};
  new Function("exports", "require", "fetch", code)(api, () => ({}), async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ pages: [], jobId: "job" }), { headers: { "content-type": "application/json" } });
  });
  await api.fetchBookPages!("token", "book");
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/pages");
  await api.fetchBookOutline!("token", "book");
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/outline");
  const order = { pageIds: ["b", "a"], expectedPageIds: ["a", "b"] };
  await api.reorderBookPages!("token", "book", order);
  assert.equal(requests.at(-1)!.options.method, "POST");
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.options.body)), order);
  await api.deleteBookPage!("token", "book", 2, "a");
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/pages/2?pageId=a");
  assert.equal(requests.at(-1)!.options.method, "DELETE");
  await api.startBookPagesOcrJob!("token", "book", { pageIds: ["a"], ocrMode: "LOCAL", advancedLayout: false });
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/ocr-jobs");
  await api.fetchBookPagesOcrJob!("token", "book", "job");
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/ocr-jobs/job");
  await api.updateBookPagesOcrJob!("token", "book", "job", "cancel");
  assert.equal(requests.at(-1)!.url, "http://synthetic.invalid/books/book/ocr-jobs/job/cancel");
  for (const request of requests) assert.equal((request.options.headers as Record<string, string>).Authorization, "Bearer token");
});

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
function galleryHarness(editor: boolean, options: { outline?: BookOutlineEntry[]; search?: string; sourceType?: string; numbers?: number[]; statuses?: string[]; job?: any; jobError?: Error; params?: Record<string, string>; visionSupported?: boolean; unsavedDecision?: "save" | "discard" | "back"; navigation?: ReturnType<typeof loadUnsavedChanges>; reorder?: () => Promise<void> } = {}) {
  const calls: unknown[][] = [];
  const invalidated: string[] = [];
  let failedDeleteId = "";
  const page = (pageId: string, pageNumber: number) => ({ pageId, pageNumber, pageLabel: null,
    preview: { kind: "CONTENT", text: `<script>not executable</script> Page ${pageNumber}` },
    capabilities: { edit: editor, delete: editor, reorder: editor, ocr: editor && options.sourceType === "IMAGES" }, updatedAt: "v1", ocrStatus: "READY" });
  const data = { pages: ["a", "b", "c"].map((id, index) => ({ ...page(id, options.numbers?.[index] ?? index + 1), ocrStatus: options.statuses?.[index] ?? "READY" })), capabilities: { reorder: editor } };
  const book = { book: { title: "Synthetic", sourceType: options.sourceType ?? "EPUB", currentUserRole: editor ? "OWNER" : "VIEWER" } };
  const searchParams = new URLSearchParams(options.search);
  const client = { invalidateQueries: async ({ predicate }: { predicate: (query: { queryKey: string[] }) => boolean }) => {
    for (const key of ["book-outline", "book-pages", "book", "book-page", "book-page-image", "reader-annotations", "reader-navigation", "reader-readable-neighbors", "builder-page-visual"]) {
      if (predicate({ queryKey: [key, "book"] })) invalidated.push(key);
      assert.equal(predicate({ queryKey: [key, "unrelated-book"] }), false);
    }
  }, setQueryData: (...args: unknown[]) => calls.push(["cache", ...args]) };
  const source = readFileSync(new URL("../src/features/book-pages/BookPagesGallery.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, React.ComponentType> = {};
  const mocks: Record<string, unknown> = {
    "@tanstack/react-query": { useQueryClient: () => client, useQuery: (query: { queryKey: string[] }) => query.queryKey[0] === "book-pages-ocr-job" ? { data: options.job, isError: !!options.jobError, error: options.jobError, refetch: async () => calls.push(["refetch-job"]) } : ({ data: query.queryKey[0] === "book-pages" ? data : query.queryKey[0] === "book" ? book : query.queryKey[0] === "book-outline" ? { outline: options.outline ?? [] } : undefined }) },
    "react-router-dom": { useBlocker: (shouldBlock: (locations: any) => boolean) => { calls.push(["dirty", shouldBlock({ currentLocation: { pathname: "/gallery", search: "", hash: "" }, nextLocation: { pathname: "/reader", search: "", hash: "" } })]); return { state: "unblocked" }; }, useParams: () => ({ bookId: "book", ...options.params }), useSearchParams: () => [searchParams], Link: ({ to, state, ...props }: any) => React.createElement("a", { ...props, href: typeof to === "string" ? to : `${to.pathname}${to.search}${to.hash}`, "data-return-to": state?.returnTo }), Navigate: ({ to, state }: any) => React.createElement("a", { href: to, "data-return-to": state?.returnTo }) },
    "../../app/auth-store": { useAuthStore: (selector: (state: unknown) => unknown) => selector({ accessToken: "token", user: { userId: "user" } }) },
    "../../app/api": { isBookEditor: (role: string) => role === "OWNER", reorderBookPages: async (...args: unknown[]) => { calls.push(["reorder", ...args]); await options.reorder?.(); return data; }, deleteBookPage: async (...args: unknown[]) => { calls.push(["delete", ...args]); if (args[3] === failedDeleteId) throw new Error("Synthetic failure"); return {}; }, startBookPagesOcrJob: async (...args: unknown[]) => { calls.push(["ocr", ...args]); return { jobId: "synthetic-job" }; } },
    "../../hooks/useUnsavedChanges": { useUnsavedChanges: (dirty: boolean) => calls.push(["dirty", dirty]), registerPendingNavigation: () => () => {} },
    "../../components/confirmUnsavedChanges": { confirmUnsavedChanges: async (confirmation: { save: () => Promise<boolean> }) => options.unsavedDecision === "save" ? confirmation.save() : options.unsavedDecision !== "back" },
    "../../components/OcrConfig": loadOcrConfig({ ocrModel: "server-model", models: [], ocrModelIds: [] }, { effectiveModels: { ocrModel: "user-model" }, settings: { opencodeOcrVisibleModels: ["user-model", "advanced-model"] } }, { source: "live", models: ["user-model", "advanced-model"].map((id) => ({ id, name: id, supportsVision: options.visionSupported ?? true })) }),
    "./page-order": { movePages, selectPageRange }, "./outline-groups": { groupPagesByOutline }, "./book-pages.css": {},
    "../../app/toc-level": { filterTocByMaxLevel: (items: { level: number }[]) => items.filter((item) => item.level <= 3), useTocMaxLevel: () => [3, () => {}] },
    "../../components/TocLevelSelector": { TocLevelSelector: () => null },
    "./GalleryPageEditor": { GalleryPageEditor: ({ page, initialBlockId, onClose, onSaved, onPendingChange }: any) => React.createElement("div", { "data-editor-page": page.pageId, "data-editor-block": initialBlockId }, React.createElement("button", { onClick: onClose }, "Cerrar editor"), React.createElement("button", { onClick: onSaved }, "Guardar editor"), React.createElement("button", { onClick: () => onPendingChange(true) }, "Modificar editor")) }
  };
  if (options.navigation) {
    mocks["react-router-dom"] = realRouter;
    mocks["../../hooks/useUnsavedChanges"] = options.navigation;
    mocks["../../components/confirmUnsavedChanges"] = options.navigation;
  }
  new Function("exports", "require", code)(exports, (id: string) => mocks[id] ?? require(id));
  return { Gallery: exports.BookPagesGallery!, Destination: exports.GalleryPageDestination!, calls, invalidated, failDelete: (id: string) => { failedDeleteId = id; } };
}

test("viewer gallery shows safely escaped EPUB text and read links without mutation controls", () => {
  const { Gallery } = galleryHarness(false);
  const html = renderToStaticMarkup(React.createElement(Gallery));
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll(".gallery-card").length, 3);
  assert.equal(document.querySelector("script"), null);
  assert.match(document.querySelector(".gallery-preview")!.textContent!, /<script>not executable/);
  assert.equal(document.querySelector("a[href='/books/book/pages/a/read']")?.getAttribute("aria-label"), "Leer");
  assert.doesNotMatch(html, /Guardar orden|Ejecutar OCR|Eliminar selección|>Editar</);
});

test("gallery and editor transport identical normalized engine/model/prompt options, including multipart create/append", async () => {
  const requests: RequestInit[] = [];
  const source = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: Record<string, (...args: any[]) => Promise<unknown>> = {};
  new Function("exports", "require", "fetch", code)(api, () => ({}), async (_url: string, options: RequestInit) => {
    requests.push(options);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const { normalizeOcrOptions } = loadOcrConfig();
  for (const mode of ["TEXTRACT", "VISION", "LOCAL"] as const) for (const advanced of [false, true]) {
    const options = normalizeOcrOptions(mode, advanced, "chosen-user-model", "  user prompt  ");
    await api.rerunOcrPage!("token", "book", 2, options, "page-a");
    const editor = JSON.parse(String(requests.at(-1)!.body));
    await api.startBookPagesOcrJob!("token", "book", { pageIds: ["page-a"], ...options });
    const { pageIds, ...gallery } = JSON.parse(String(requests.at(-1)!.body));
    assert.deepEqual(pageIds, ["page-a"]);
    assert.deepEqual(gallery, editor);
    assert.deepEqual(editor, { ocrMode: mode, advancedLayout: advanced && mode !== "LOCAL",
      ...(mode === "VISION" || mode === "TEXTRACT" && advanced ? { ocrModel: "chosen-user-model", promptOverride: "user prompt" } : {}) });
    for (const method of ["createImageBook", "appendImagesToBook"]) {
      await api[method]!("token", ...(method === "appendImagesToBook" ? ["book"] : []), new FormData(), options);
      const form = requests.at(-1)!.body as FormData;
      assert.equal(form.get("ocrMode"), editor.ocrMode);
      assert.equal(form.get("advancedLayout"), String(editor.advancedLayout));
      assert.equal(form.get("ocrModel"), editor.ocrModel ?? null);
      assert.equal(form.get("promptOverride"), editor.promptOverride ?? null);
    }
  }
});

async function withGalleryDom(options: Parameters<typeof galleryHarness>[1] & { storedJobId?: string }, run: (fixture: any) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://synthetic.invalid" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const scrolls: Element[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this); };
  if (options?.storedJobId) dom.window.localStorage.setItem("lector:gallery-ocr:user:book", options.storedJobId);
  const harness = galleryHarness(true, options);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (text: string) => [...dom.window.document.querySelectorAll("button")].find((node: any) => node.getAttribute("aria-label") === text || node.textContent === text) as HTMLButtonElement;
  try {
    await act(async () => root.render(React.createElement(harness.Gallery)));
    await run({ ...harness, dom, document: dom.window.document, root, button, scrolls });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("outline folds parent and child independently, leaves siblings visible, and editing refreshes the outline", async () => {
  const outline: BookOutlineEntry[] = [
    { chapterId: "heading-a", level: 1, pageNumber: 1, paragraphNumber: 1, title: "Chapter", beginsPageContent: true },
    { chapterId: "heading-b", level: 2, pageNumber: 2, paragraphNumber: 1, title: "Section", beginsPageContent: true },
    { chapterId: "heading-c", level: 1, pageNumber: 3, paragraphNumber: 1, title: "Sibling", beginsPageContent: true }
  ];
  await withGalleryDom({ outline }, async ({ document, button, invalidated, calls }: any) => {
    const checkbox = [...document.querySelectorAll(".gallery-toolbar label")].find((label: any) => label.textContent === "Mostrar índice").querySelector("input");
    await act(async () => checkbox.click());
    assert.equal(document.querySelectorAll(".gallery-card").length, 3);
    const toggles = [...document.querySelectorAll(".gallery-outline-toggle")] as HTMLButtonElement[];
    assert.equal(toggles.length, 3, "each heading has exactly one tree node");
    const [parent, child, sibling] = toggles;
    const content = (toggle: HTMLButtonElement) => document.getElementById(toggle.getAttribute("aria-controls"));
    assert.ok(content(parent).contains(child), "child lives inside the parent's controlled content");
    assert.equal(content(parent).firstElementChild.className, "gallery-outline-pages", "own cards precede children");
    assert.equal(content(parent).querySelector(":scope > .gallery-outline-pages [data-gallery-page-id]").dataset.galleryPageId, "a");
    await act(async () => child.click());
    assert.equal(content(child).hidden, true);
    assert.equal(content(parent).hidden, false);
    assert.equal(content(sibling).hidden, false);
    await act(async () => parent.click());
    assert.equal(content(parent).hidden, true);
    assert.equal(content(sibling).hidden, false, "folding a parent never hides a sibling root");
    await act(async () => parent.click());
    assert.equal(content(child).hidden, true, "unfolding the parent preserves the child's independent state");
    await act(async () => button("Editar título: Section").click());
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-page"), "b");
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-block"), "heading-b");
    assert.equal(child.getAttribute("aria-expanded"), "false", "editing must not toggle pages");
    await act(async () => button("Guardar editor").click());
    assert.ok(invalidated.includes("book-outline"));
    await act(async () => button("Cerrar editor").click());
    await act(async () => child.click());
    await act(async () => document.querySelector(".gallery-open-preview").click());
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-page"), "a");
    assert.equal(document.querySelector("[data-editor-page]").hasAttribute("data-editor-block"), false);
    await act(async () => button("Modificar editor").click());
    assert.deepEqual(calls.at(-1), ["dirty", true], "editor shares the existing gallery navigation blocker");
  });
});

test("shared boundary titles sit together above the unique card without navigation notices", async () => {
  const outline: BookOutlineEntry[] = [
    { chapterId: "previous", level: 1, pageNumber: 1, paragraphNumber: 1, title: "Previous", beginsPageContent: true },
    { chapterId: "previous-child", level: 2, pageNumber: 1, paragraphNumber: 2, title: "Previous child", beginsPageContent: false },
    { chapterId: "owner", level: 1, pageNumber: 2, paragraphNumber: 3, title: "Owner", beginsPageContent: false },
    { chapterId: "owner-child", level: 2, pageNumber: 2, paragraphNumber: 4, title: "Owner child", beginsPageContent: false }
  ];
  await withGalleryDom({ outline }, async ({ document, button }: any) => {
    const checkbox = [...document.querySelectorAll(".gallery-toolbar label")].find((label: any) => label.textContent === "Mostrar índice").querySelector("input");
    await act(async () => checkbox.click());
    const toggle = (title: string) => [...document.querySelectorAll(".gallery-outline-toggle")].find((entry: any) => entry.querySelector(".gallery-outline-title-text").textContent.endsWith(` · ${title}`)) as HTMLButtonElement;
    const node = (title: string) => toggle(title).closest(".gallery-outline-group");
    assert.equal(document.querySelectorAll(".gallery-card").length, 3);
    assert.deepEqual([...document.querySelectorAll("[data-gallery-page-id]")].map((entry: any) => entry.dataset.galleryPageId).sort(), ["a", "b", "c"]);
    assert.equal(node("Previous").querySelector("[data-gallery-page-id='b']"), null);
    const card = node("Owner child").querySelector("[data-gallery-page-id='b']");
    assert.ok(card, "latest branch owns the shared boundary card");
    const shared = card.closest(".gallery-outline-pages").querySelector(".gallery-shared-headings");
    assert.match(shared.textContent, /Previous/);
    assert.doesNotMatch(shared.textContent, /Owner child/, "the current heading is already shown above the shared page");
    assert.equal(shared.querySelector("a"), null, "titles edit or fold locally instead of navigating elsewhere");
    assert.doesNotMatch(document.body.textContent, /Ver página .* compartida/);
    const sharedToggles = [...shared.querySelectorAll(".gallery-outline-toggle")] as HTMLButtonElement[];
    const sharedContent = document.getElementById(sharedToggles[0]!.getAttribute("aria-controls"));
    assert.ok(sharedContent.contains(card));
    await act(async () => sharedToggles[0]!.click());
    assert.equal(sharedContent.hidden, true);
    assert.ok([...sharedToggles].every((entry) => entry.getAttribute("aria-expanded") === "false"));
    const exclusiveCard = node("Owner child").querySelector("[data-gallery-page-id='c']");
    assert.equal(exclusiveCard.closest(".gallery-outline-content").hidden, false, "shared page folding does not hide later exclusive pages");
    await act(async () => sharedToggles.at(-1)!.click());
    assert.equal(sharedContent.hidden, false);
    const previousEdit = [...shared.querySelectorAll("button")].find((entry: any) => entry.getAttribute("aria-label") === "Editar título: Previous child") as HTMLButtonElement;
    await act(async () => previousEdit.click());
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-page"), "a");
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-block"), "previous-child");
    await act(async () => button("Cerrar editor").click());
    assert.equal(document.querySelectorAll("[data-gallery-page-id='b']").length, 1);
    await act(async () => checkbox.click());
    assert.equal(document.querySelectorAll(".gallery-outline-group").length, 0);
    assert.equal(document.querySelectorAll(".gallery-card").length, 3, "flat mode retains unique cards");
  });
});

test("page 32 puts all its sibling and child titles in one header beside one thumbnail", async () => {
  const outline: BookOutlineEntry[] = [
    { chapterId: "chapter", level: 1, pageNumber: 31, paragraphNumber: 1, title: "Chapter", beginsPageContent: true },
    { chapterId: "celts", level: 2, pageNumber: 32, paragraphNumber: 1, title: "Celts", beginsPageContent: true },
    { chapterId: "iberians", level: 2, pageNumber: 32, paragraphNumber: 3, title: "Iberians", beginsPageContent: false },
    { chapterId: "strabo", level: 3, pageNumber: 32, paragraphNumber: 4, title: "Strabo", beginsPageContent: false },
    { chapterId: "elche", level: 3, pageNumber: 32, paragraphNumber: 6, title: "Elche", beginsPageContent: false },
    { chapterId: "baza", level: 3, pageNumber: 32, paragraphNumber: 8, title: "Baza", beginsPageContent: false },
    { chapterId: "next", level: 2, pageNumber: 33, paragraphNumber: 1, title: "Next", beginsPageContent: true }
  ];
  await withGalleryDom({ outline, numbers: [31, 32, 33] }, async ({ document, button }: any) => {
    const checkbox = [...document.querySelectorAll(".gallery-toolbar label")].find((label: any) => label.textContent === "Mostrar índice").querySelector("input");
    await act(async () => checkbox.click());
    const card = document.querySelector("[data-gallery-page-id='b']");
    const cluster = card.closest(".gallery-outline-group");
    const header = cluster.querySelector(":scope > .gallery-outline-heading");
    const titles = [...header.querySelectorAll(".gallery-outline-toggle")] as HTMLButtonElement[];
    assert.equal(titles.length, 5);
    assert.deepEqual(titles.map((entry) => entry.querySelector(".gallery-outline-title-text")!.textContent), ["T2 · Celts", "T2 · Iberians", "T3 · Strabo", "T3 · Elche", "T3 · Baza"]);
    assert.ok(titles.every((entry) => entry.querySelector(".gallery-outline-count")!.textContent === "(1 página)"));
    assert.equal(header.querySelector("p.helper-text"), null, "page count stays inline with the title");
    assert.ok(titles.every((entry) => entry.getAttribute("aria-controls") === titles[0]!.getAttribute("aria-controls")));
    assert.equal(cluster.querySelectorAll(".gallery-card").length, 1);
    assert.equal(cluster.querySelectorAll(".gallery-outline-group").length, 0, "shared titles do not leave empty child sections");
    assert.doesNotMatch(document.body.textContent, /Ver página .* compartida/);
    assert.equal(document.querySelectorAll(".gallery-card").length, 3);
    const rows = header.querySelectorAll(".gallery-outline-row");
    assert.equal(rows[2].style.paddingInlineStart, "0.75rem", "T3 remains visually nested beneath T2");
    await act(async () => titles[2]!.click());
    assert.equal(document.getElementById(titles[0]!.getAttribute("aria-controls")).hidden, true);
    await act(async () => titles[4]!.click());
    assert.equal(document.getElementById(titles[0]!.getAttribute("aria-controls")).hidden, false);
    await act(async () => button("Editar título: Elche").click());
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-page"), "b");
    assert.equal(document.querySelector("[data-editor-page]").getAttribute("data-editor-block"), "elche");
  });
});

test("page 8 starting a new branch belongs only to it even when its heading is not paragraph 1", async () => {
  const outline: BookOutlineEntry[] = [
    { chapterId: "old", level: 1, pageNumber: 7, paragraphNumber: 1, title: "Old branch", beginsPageContent: true },
    { chapterId: "new", level: 1, pageNumber: 8, paragraphNumber: 2, title: "New branch", beginsPageContent: true }
  ];
  await withGalleryDom({ outline, numbers: [7, 8, 9] }, async ({ document }: any) => {
    const checkbox = [...document.querySelectorAll(".gallery-toolbar label")].find((label: any) => label.textContent === "Mostrar índice").querySelector("input");
    await act(async () => checkbox.click());
    const nodes = document.querySelectorAll(".gallery-outline-group");
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].querySelector("[data-gallery-page-id='b']"), null);
    assert.ok(nodes[1].querySelector("[data-gallery-page-id='b']"));
    assert.equal(document.querySelectorAll("[data-gallery-page-id='b']").length, 1);
    assert.doesNotMatch(nodes[0].textContent, /Ver página 8 compartida/);
    assert.equal(nodes[1].querySelector(".gallery-shared-headings"), null);
    assert.equal(nodes[0].querySelector(".gallery-outline-count").textContent, "(1 página)");
    assert.equal(nodes[1].querySelector(".gallery-outline-count").textContent, "(2 páginas)");
  });
});

test("gallery blocks incompatible vision execution but allows standard Textract and LOCAL", async () => {
  await withGalleryDom({ sourceType: "IMAGES", visionSupported: false }, async ({ document, dom, button, calls }: any) => {
    const panel = [...document.querySelectorAll("fieldset")].find((element: any) => element.querySelector("legend").textContent === "OCR de la selección");
    const engine = panel.querySelector("select");
    await act(async () => button("Seleccionar todas").click());
    assert.equal(button("Ejecutar OCR").disabled, false);
    await act(async () => panel.querySelector("input[type='checkbox']").click());
    assert.equal(button("Ejecutar OCR").disabled, true);
    assert.match(panel.textContent, /no admite imagenes/);
    assert.equal(panel.querySelector(".ocr-model-select-field select").selectedOptions[0].disabled, true);
    await act(async () => { engine.value = "VISION"; engine.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    dom.window.confirm = () => { assert.fail("Incompatible OCR must not reach confirmation"); };
    await act(async () => button("Ejecutar OCR").click());
    assert.equal(calls.some((call: unknown[]) => call[0] === "ocr"), false);
    await act(async () => { engine.value = "LOCAL"; engine.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(button("Ejecutar OCR").disabled, false);
  });
});

test("gallery defaults to TEXTRACT and submits effective or explicitly selected models/prompts just like review OCR", async () => {
  for (const mode of ["TEXTRACT", "VISION", "LOCAL"]) for (const advanced of [false, true]) {
    await withGalleryDom({ sourceType: "IMAGES" }, async ({ document, dom, button, calls }: any) => {
      const panel = [...document.querySelectorAll("fieldset")].find((element: any) => element.querySelector("legend").textContent === "OCR de la selección");
      const engine = panel.querySelector("select");
      const checkbox = panel.querySelector("input[type='checkbox']");
      assert.equal(engine.value, "TEXTRACT");
      assert.equal(checkbox.checked, false);
      assert.equal(panel.querySelector(".ocr-model-select-field"), null);
      assert.equal(calls.some((call: unknown[]) => call[0] === "ocr"), false, "rendering must never run OCR");
      const changeEngine = async (value: string) => act(async () => { engine.value = value; engine.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      // Switching through LOCAL must clear the advanced phase, not restore stale opt-in.
      await act(async () => checkbox.click());
      await act(async () => Simulate.change(panel.querySelector("textarea"), { target: { value: "stale advanced prompt" } } as any));
      await changeEngine("LOCAL");
      assert.equal(checkbox.checked, false);
      assert.equal(checkbox.disabled, true);
      assert.equal(panel.querySelector(".ocr-model-select-field"), null);
      assert.equal(panel.querySelector("textarea"), null);
      await changeEngine(mode);
      if (advanced && mode !== "LOCAL") await act(async () => checkbox.click());
      const usesModel = mode === "VISION" || mode === "TEXTRACT" && advanced;
      if (usesModel) {
        const model = panel.querySelector(".ocr-model-select-field select");
        assert.equal(model.value, "user-model", "effective user preference must win over global server-model");
        assert.deepEqual([...model.options].map((option: HTMLOptionElement) => option.value), ["", "user-model", "advanced-model"]);
        assert.equal(model.options[0].disabled, true, "empty placeholder is not a model or executable selection");
        if (advanced) await act(async () => { model.value = "advanced-model"; model.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
        const prompt = panel.querySelector("textarea");
        await act(async () => Simulate.change(prompt, { target: { value: "  shared user prompt  " } } as any));
        assert.equal(prompt.value, "  shared user prompt  ");
      }
      await act(async () => button("Seleccionar todas").click());
      dom.window.confirm = () => false;
      await act(async () => button("Ejecutar OCR").click());
      assert.equal(calls.some((call: unknown[]) => call[0] === "ocr"), false);
      dom.window.confirm = () => true;
      await act(async () => button("Ejecutar OCR").click());
      assert.deepEqual(calls.filter((call: unknown[]) => call[0] === "ocr"), [["ocr", "token", "book", {
        pageIds: ["a", "b", "c"], ocrMode: mode, advancedLayout: advanced && mode !== "LOCAL",
        ...(usesModel ? { ocrModel: advanced ? "advanced-model" : "user-model", promptOverride: "shared user prompt" } : {})
      }]]);
    });
  }
});

test("terminal gallery OCR refreshes editor and reader caches only for its book", async () => {
  await withGalleryDom({ sourceType: "IMAGES", storedJobId: "job", job: {
    jobId: "job", status: "READY", attemptCount: 1, processed: 3, total: 3, failed: 0, pages: []
  } }, async ({ invalidated }: any) => {
    assert.deepEqual(invalidated.sort(), ["book-outline", "book-pages", "book", "book-page", "book-page-image", "reader-annotations", "reader-navigation", "reader-readable-neighbors", "builder-page-visual"].sort());
  });
});

test("gallery highlights and scrolls to the immutable origin once, preserves its search, and returns to its current number", async () => {
  await withGalleryDom({ search: "pageId=b&page=2", numbers: [1, 9, 3] }, async ({ document, scrolls, button, dom }: any) => {
    const origin = document.querySelector("[data-origin='true']");
    assert.equal(origin.getAttribute("aria-current"), "page");
    assert.match(origin.textContent, /Página guardada 9/);
    assert.deepEqual(scrolls, [origin]);
    assert.equal(document.querySelector("a[aria-label='Volver al lector']").getAttribute("href"), "/books/book?page=9&pageId=b");
    assert.equal(document.querySelector("a[href='/books/book/pages/a/read?pageId=b&page=2']").getAttribute("aria-label"), "Leer");
    assert.equal(document.querySelector("button[aria-label='Editar']").getAttribute("title"), "Editar página");
    await act(async () => button("Seleccionar todas").click());
    const size = [...document.querySelectorAll("select")].find((select: any) => select.parentElement.textContent.includes("Tamaño de vista previa"));
    await act(async () => { size.value = "compact"; size.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(document.querySelector(".book-gallery").dataset.previewSize, "compact");
    assert.equal(scrolls.length, 1, "selection and size changes must not repeatedly jump the viewport");
  });
});

test("image gallery offers before/after insertion links that return to the gallery", async () => {
  const { Gallery } = galleryHarness(true, { sourceType: "IMAGES" });
  const document = new JSDOM(renderToStaticMarkup(React.createElement(Gallery))).window.document;
  const before = [...document.querySelectorAll(".gallery-insert-before")] as HTMLAnchorElement[];
  const after = [...document.querySelectorAll(".gallery-insert-after")] as HTMLAnchorElement[];
  assert.equal(before.length, 3);
  assert.equal(after.length, 3);
  assert.equal(before[0]!.getAttribute("href"), "/builder?appendBookId=book&insertAfterPage=1&insertSide=before#append-pages");
  assert.equal(after[0]!.getAttribute("href"), "/builder?appendBookId=book&insertAfterPage=1&insertSide=after#append-pages");
  assert.equal(before[2]!.getAttribute("href"), "/builder?appendBookId=book&insertAfterPage=3&insertSide=before#append-pages");
  assert.equal(after[2]!.getAttribute("href"), "/builder?appendBookId=book&insertAfterPage=3&insertSide=after#append-pages");
  for (const link of [...before, ...after]) {
    assert.equal(link.getAttribute("data-return-to"), "/books/book/pages");
    assert.match(link.getAttribute("aria-label")!, /Añadir páginas (antes|después) de la página [123]/);
    assert.equal(link.textContent, "+");
  }
  const toolbar = [...document.querySelectorAll(".gallery-toolbar a")].find((entry) => entry.textContent === "Añadir páginas") as HTMLAnchorElement;
  assert.equal(toolbar.getAttribute("href"), "/builder?appendBookId=book&insertAfterPage=3&insertSide=after#append-pages");
  assert.equal(toolbar.getAttribute("data-return-to"), "/books/book/pages");
  const viewer = new JSDOM(renderToStaticMarkup(React.createElement(galleryHarness(false, { sourceType: "IMAGES" }).Gallery))).window.document;
  assert.equal(viewer.querySelectorAll(".gallery-insert").length, 0);
  assert.equal(viewer.querySelectorAll(".gallery-toolbar a").length, 0);
  const epub = new JSDOM(renderToStaticMarkup(React.createElement(galleryHarness(true, {}).Gallery))).window.document;
  assert.equal(epub.querySelectorAll(".gallery-insert").length, 0, "insertion links require IMAGES books like the builder append form");
});

test("gallery insertion links disappear while the order draft is unsaved", async () => {
  await withGalleryDom({ sourceType: "IMAGES" }, async ({ document }: any) => {
    assert.equal(document.querySelectorAll(".gallery-insert").length, 6);
    const cards = [...document.querySelectorAll(".gallery-card")];
    const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
    cards[2].getBoundingClientRect = () => ({ left: 100, width: 200 });
    await act(async () => Simulate.dragStart(cards[0].querySelector(".gallery-drag"), { dataTransfer } as any));
    await act(async () => Simulate.dragOver(cards[2], { clientX: 250, dataTransfer } as any));
    await act(async () => Simulate.drop(cards[2], { dataTransfer } as any));
    assert.equal(document.querySelectorAll(".gallery-insert").length, 0);
    assert.match(document.body.textContent, /antes de editar, añadir o eliminar/);
  });
});

test("gallery controls are accessible icons without visible button text", async () => {
  await withGalleryDom({}, async ({ document }: any) => {
    const controls = document.querySelectorAll(".gallery-icon-button");
    assert.equal(controls.length, 13);
    for (const control of controls) {
      assert.equal(control.textContent, "");
      assert.ok(control.getAttribute("aria-label"));
      assert.ok(control.getAttribute("title"));
      assert.equal(control.querySelector("svg").getAttribute("aria-hidden"), "true");
    }
  });
});

test("drag marks the pointer's insertion side until drop, and clears on leave or cancel", async () => {
  await withGalleryDom({}, async ({ document, button, calls }: any) => {
    const cards = [...document.querySelectorAll(".gallery-card")];
    const handle = cards[0].querySelector(".gallery-drag");
    const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
    cards[2].getBoundingClientRect = () => ({ left: 100, width: 200 });
    await act(async () => Simulate.dragStart(handle, { dataTransfer } as any));
    assert.equal(cards[0].dataset.dragging, "true");
    await act(async () => Simulate.dragOver(cards[2], { clientX: 150, dataTransfer } as any));
    assert.equal(cards[2].dataset.dropPosition, "before");
    assert.equal(cards[2].querySelector(".gallery-drop-label").textContent, "Insertar antes");
    assert.equal(button("Guardar orden").disabled, true, "hover must not alter the draft");
    await act(async () => Simulate.dragLeave(cards[2], { relatedTarget: cards[2].querySelector("svg") } as any));
    assert.equal(cards[2].dataset.dropPosition, "before", "moving over card children preserves the marker");
    await act(async () => Simulate.dragOver(cards[2], { clientX: 250, dataTransfer } as any));
    assert.equal(cards[2].dataset.dropPosition, "after");
    await act(async () => Simulate.drop(cards[2], { dataTransfer } as any));
    assert.equal(document.querySelector("[data-drop-position]"), null);
    assert.equal(document.querySelector("[data-dragging='true']"), null);
    assert.equal(button("Guardar orden").disabled, false);
    await act(async () => button("Guardar orden").click());
    assert.deepEqual(calls.find((call: unknown[]) => call[0] === "reorder")[3], { pageIds: ["b", "c", "a"], expectedPageIds: ["a", "b", "c"] });
    await act(async () => Simulate.dragStart(handle, { dataTransfer } as any));
    await act(async () => Simulate.dragOver(cards[2], { clientX: 150, dataTransfer } as any));
    await act(async () => Simulate.dragLeave(cards[2], { relatedTarget: null } as any));
    assert.equal(document.querySelector("[data-drop-position]"), null);
    await act(async () => Simulate.dragOver(cards[2], { clientX: 250, dataTransfer } as any));
    await act(async () => Simulate.dragEnd(handle));
    assert.equal(document.querySelector("[data-drop-position]"), null);
    assert.equal(button("Guardar orden").disabled, true);
  });
});

test("floating back-to-top appears after scrolling and respects reduced motion", async () => {
  await withGalleryDom({}, async ({ document, button, dom }: any) => {
    const calls: ScrollToOptions[] = [];
    dom.window.scrollTo = (options: ScrollToOptions) => calls.push(options);
    let reducedMotion = false;
    dom.window.matchMedia = () => ({ matches: reducedMotion });
    assert.equal(button("Volver arriba"), undefined);
    await act(async () => {
      Object.defineProperty(dom.window, "scrollY", { configurable: true, value: 500 });
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(button("Volver arriba").textContent, "");
    assert.ok(button("Volver arriba").querySelector("svg"));
    assert.equal(button("Volver arriba").parentElement, document.body, "fixed button must escape the panel's backdrop-filter containing block");
    await act(async () => button("Volver arriba").click());
    assert.deepEqual(calls.at(-1), { top: 0, behavior: "smooth" });
    assert.equal(document.activeElement.id, "gallery-title");
    reducedMotion = true;
    await act(async () => button("Volver arriba").click());
    assert.deepEqual(calls.at(-1), { top: 0, behavior: "instant" });
    await act(async () => {
      Object.defineProperty(dom.window, "scrollY", { configurable: true, value: 0 });
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(button("Volver arriba"), undefined);
  });
});

test("reader/editor destination preserves the original gallery search even when opening a different card", () => {
  for (const action of ["read", "edit"]) {
    const { Destination } = galleryHarness(true, { search: "pageId=b&page=2", params: { pageId: "a", action } });
    const document = new JSDOM(renderToStaticMarkup(React.createElement(Destination))).window.document;
    const link = document.querySelector("a")!;
    assert.equal(link.getAttribute("data-return-to"), "/books/book/pages?pageId=b&page=2");
    const url = new URL(link.getAttribute("href")!, "http://synthetic.invalid");
    assert.equal(url.searchParams.get(action === "edit" ? "reviewPageId" : "pageId"), "a");
  }
});

test("a deleted source ID is retained and never replaced by the page now at its old position", () => {
  const { Gallery } = galleryHarness(false, { search: "pageId=deleted&page=2" });
  const document = new JSDOM(renderToStaticMarkup(React.createElement(Gallery))).window.document;
  assert.equal(document.querySelector("[data-origin='true']"), null);
  assert.match(document.body.textContent!, /página de origen ya no está disponible/);
  assert.equal(document.querySelector("a[aria-label='Volver al lector']")?.getAttribute("href"), "/books/book?page=2&pageId=deleted");
});

test("OCR pending/failed shortcuts use immutable IDs and prefer job progress to stale listing status", async () => {
  await withGalleryDom({ sourceType: "IMAGES", storedJobId: "job", statuses: ["PENDING", "READY", "FAILED"], job: {
    jobId: "job", status: "RUNNING", attemptCount: 1, processed: 2, total: 3, failed: 1, pages: [
      { pageId: "a", status: "READY" }, { pageId: "b", status: "FAILED" }, { pageId: "c", status: "PENDING" }, { pageId: "deleted", status: "FAILED" }
    ]
  } }, async ({ document, button }: any) => {
    await act(async () => button("Seleccionar OCR pendiente").click());
    assert.equal(document.querySelectorAll(".gallery-card[data-selected='true']").length, 1);
    assert.match(document.querySelector(".gallery-card[data-selected='true']").textContent, /Página 3/);
    await act(async () => button("Seleccionar OCR fallido").click());
    assert.equal(document.querySelectorAll(".gallery-card[data-selected='true']").length, 1);
    assert.match(document.querySelector(".gallery-card[data-selected='true']").textContent, /Página 2/);
  });
});

test("all restored job tracking errors can be closed without cancellation and without permanently locking the gallery", async () => {
  for (const statusCode of [400, 403, 404, 500, undefined]) {
    await withGalleryDom({ sourceType: "IMAGES", storedJobId: "invalid", jobError: Object.assign(new Error("Synthetic job error"), { statusCode }) }, async ({ document, button, dom, calls }: any) => {
      assert.equal(document.querySelector("fieldset").disabled, true);
      assert.match(document.querySelector("[role='alert']").textContent, /no cancela el trabajo OCR/);
      await act(async () => button("Cerrar seguimiento").click());
      assert.equal(dom.window.localStorage.getItem("lector:gallery-ocr:user:book"), null);
      assert.equal(document.querySelector("fieldset").disabled, false);
      assert.equal(document.querySelector("[role='alert']"), null);
      assert.match(document.body.textContent, /El OCR del servidor no se ha cancelado/);
      assert.ok(calls.every((call: any[]) => call[0] === "dirty"), "closing tracking must not call cancellation or mutate server/cache state");
    });
  }
});

test("editor selection and mobile move are drafts until Save; Cancel and delete confirmation work", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://synthetic.invalid" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { Gallery, calls, failDelete } = galleryHarness(true);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (text: string) => [...dom.window.document.querySelectorAll("button")].find((node: any) => node.textContent === text) as HTMLButtonElement;
  try {
    await act(async () => root.render(React.createElement(Gallery)));
    const checkbox = dom.window.document.querySelector(".gallery-card input") as HTMLInputElement;
    await act(async () => checkbox.click());
    const selects = dom.window.document.querySelectorAll("fieldset select");
    await act(async () => { selects[0].value = "after"; selects[0].dispatchEvent(new dom.window.Event("change", { bubbles: true })); selects[1].value = "c"; selects[1].dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await act(async () => button("Mover al destino").click());
    assert.equal(calls.filter((call) => call[0] === "reorder").length, 0);
    assert.equal(button("Eliminar selección").disabled, true);
    assert.equal(button("Guardar orden").disabled, false);
    assert.ok(calls.some((call) => call[0] === "dirty" && call[1] === true));
    await act(async () => button("Cancelar").click());
    assert.equal(button("Guardar orden").disabled, true);
    await act(async () => button("Mover al destino").click());
    await act(async () => button("Guardar orden").click());
    assert.deepEqual(calls.find((call) => call[0] === "reorder")?.[3], { pageIds: ["b", "c", "a"], expectedPageIds: ["a", "b", "c"] });
    dom.window.confirm = () => false;
    await act(async () => button("Eliminar selección").click());
    assert.equal(calls.filter((call) => call[0] === "delete").length, 0);
    dom.window.confirm = () => true;
    await act(async () => button("Eliminar selección").click());
    assert.deepEqual(calls.find((call) => call[0] === "delete"), ["delete", "token", "book", 1, "a"]);
    failDelete("b");
    await act(async () => button("Seleccionar todas").click());
    await act(async () => button("Eliminar selección").click());
    assert.match(dom.window.document.querySelector("[role='alert']")!.textContent!, /1 de 3 páginas eliminadas.*Synthetic failure/);
    assert.deepEqual(calls.filter((call) => call[0] === "delete").slice(1), [["delete", "token", "book", 1, "a"], ["delete", "token", "book", 2, "b"]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("cancel order supports saving, discarding and returning without losing the draft", async () => {
  for (const unsavedDecision of ["save", "discard", "back"] as const) {
    await withGalleryDom({ unsavedDecision }, async ({ document, button, calls }: any) => {
      const cards = [...document.querySelectorAll(".gallery-card")];
      const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
      cards[2].getBoundingClientRect = () => ({ left: 100, width: 200 });
      await act(async () => Simulate.dragStart(cards[0].querySelector(".gallery-drag"), { dataTransfer } as any));
      await act(async () => Simulate.dragOver(cards[2], { clientX: 250, dataTransfer } as any));
      await act(async () => Simulate.drop(cards[2], { dataTransfer } as any));
      assert.equal(button("Guardar orden").disabled, false);
      await act(async () => button("Cancelar").click());
      assert.equal(button("Guardar orden").disabled, unsavedDecision !== "back");
      assert.equal(calls.filter((call: unknown[]) => call[0] === "reorder").length, unsavedDecision === "save" ? 1 : 0);
      if (unsavedDecision === "back") assert.deepEqual([...document.querySelectorAll(".gallery-card")].map((card: any) => card.dataset.galleryPageId), ["b", "c", "a"]);
    });
  }
});

test("gallery router navigation survives async order saving rerenders and vetoes failed saves", async () => {
  for (const success of [true, false]) {
    await withUnsavedDom(async ({ root, document, button }) => {
      const navigation = loadUnsavedChanges();
      const saving = deferred<void>();
      const { Gallery, calls } = galleryHarness(true, { navigation, reorder: () => saving.promise });
      const router = realRouter.createMemoryRouter([
        { path: "/books/:bookId/pages", element: React.createElement(Gallery) },
        { path: "/next", element: React.createElement("p", null, "Destination") }
      ], { initialEntries: ["/books/book/pages"] });
      try {
        await act(async () => root.render(React.createElement(realRouter.RouterProvider, { router })));
        const cards = [...document.querySelectorAll(".gallery-card")];
        const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
        cards[2]!.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
        await act(async () => Simulate.dragStart(cards[0]!.querySelector(".gallery-drag")!, { dataTransfer } as any));
        await act(async () => Simulate.dragOver(cards[2]!, { clientX: 250, dataTransfer } as any));
        await act(async () => Simulate.drop(cards[2]!, { dataTransfer } as any));
        await act(async () => router.navigate("/next"));
        assert.equal(document.querySelectorAll("dialog").length, 1);
        await act(async () => button("Salir guardando").click());
        assert.equal(document.querySelector("fieldset")!.disabled, true, "busy save rerenders the gallery");
        assert.equal(router.state.location.pathname, "/books/book/pages");
        assert.equal(await navigation.confirmPendingNavigation(), false, "logout/navigation cannot interrupt an in-flight save");
        assert.deepEqual(calls.find((call) => call[0] === "reorder")?.[3], { pageIds: ["b", "c", "a"], expectedPageIds: ["a", "b", "c"] });
        await act(async () => root.render(React.createElement(realRouter.RouterProvider, { router })));
        assert.equal(document.querySelectorAll("dialog").length, 1);
        await act(async () => {
          if (success) saving.resolve(); else saving.reject(new Error("Synthetic save failure"));
        });
        assert.equal(router.state.location.pathname, success ? "/next" : "/books/book/pages");
        assert.equal(document.querySelector("dialog"), null);
        assert.equal(calls.filter((call) => call[0] === "reorder").length, 1);
        if (!success) {
          assert.match(document.querySelector("[role='alert']")!.textContent!, /Synthetic save failure/);
          assert.deepEqual([...document.querySelectorAll(".gallery-card")].map((card) => (card as HTMLElement).dataset.galleryPageId), ["b", "c", "a"]);
          assert.equal(button("Guardar orden").disabled, false);
        }
      } finally { router.dispose(); }
    });
  }
});
