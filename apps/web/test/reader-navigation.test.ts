import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React, { act } from "react";
import { MemoryRouter } from "react-router-dom";
import ts from "typescript";

import type { ReaderNavigationSummary } from "../src/app/api";
import { ReaderNavigationPanelContent, type ReaderNavigationListItem } from "../src/features/reader/ReaderFloatingPanels";
import { buildReaderNavigationItems, tocEntryKey } from "../src/features/reader/reader-navigation";
import { deferred, withUnsavedDom } from "./unsaved-changes-fixture";

function fixture(): Pick<ReaderNavigationSummary, "toc" | "bookmarks" | "highlights" | "notes"> {
  const date = "2026-01-01T12:00:00Z";
  const highlight = { charEnd: 10, charStart: 0, color: "GREEN" as const, createdAt: date, highlightId: "highlight", highlightedText: "Texto\n anotado", pageNumber: 3, paragraphId: "paragraph", paragraphNumber: 2, sequenceNumber: 8, updatedAt: date };
  return {
    toc: [
      { chapterId: "chapter", level: 1, pageNumber: 1, paragraphNumber: 1, sequenceNumber: 1, title: "Capítulo" },
      { chapterId: "section", level: 3, pageNumber: 3, paragraphNumber: 1, sequenceNumber: 7, title: "Apartado" }
    ],
    bookmarks: [{ bookmarkId: "bookmark", createdAt: date, isOwnedByCurrentUser: false, pageNumber: 3, paragraphId: "paragraph", paragraphNumber: 2, sequenceNumber: 8, sharedWithUserIds: [], username: "ana", visibilitySource: "DIRECT" }],
    highlights: [highlight, { ...highlight, highlightId: "standalone", paragraphNumber: 3 }],
    notes: [{ createdAt: date, highlightCharEnd: 10, highlightCharStart: 0, highlightColor: "GREEN", highlightId: "highlight", highlightedText: "Texto\n anotado", isOwnedByCurrentUser: false, noteId: "note", noteText: "Mi nota", pageNumber: 3, paragraphId: "paragraph", paragraphNumber: 2, sequenceNumber: 8, updatedAt: date, userDisplayName: "Ana" }]
  };
}

function editorBookmarkCallback(bindings: Record<string, unknown>): (bookmarkId: string) => Promise<void> {
  const text = readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("BookBuilderPage.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: ts.FunctionDeclaration | undefined;
  let callback: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleDeleteReviewBookmark") handler = node;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "ReaderNavigationPanelContent") {
      const prop = node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === "onDeleteBookmark") as ts.JsxAttribute | undefined;
      if (prop?.initializer && ts.isJsxExpression(prop.initializer)) callback = prop.initializer.expression?.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler);
  assert.equal(callback, "handleDeleteReviewBookmark", "the editor must wire bookmark deletion into the shared panel");
  const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return ${callback};`)(...Object.values(bindings));
}

test("reading and editing share navigation content, with independent active locations", () => {
  const data = fixture();
  const reader = buildReaderNavigationItems(data, { activeTocEntryKey: "chapter", pageNumber: 1, paragraphNumber: 1 });
  const editor = buildReaderNavigationItems(data, { activeTocEntryKey: "section", pageNumber: 3 });
  const content = (items: ReaderNavigationListItem[]) => items.map(({ isActive, ...item }) => item);
  assert.deepEqual(content(reader), content(editor));
  assert.deepEqual(reader.filter((item) => item.isActive).map((item) => item.key), ["toc:chapter"]);
  assert.deepEqual(editor.filter((item) => item.isActive).map((item) => item.key), ["toc:section", "bookmark:bookmark", "note:note", "highlight:standalone"]);
  assert.equal(reader[0]!.isActive, true, "building the editor must not mutate the reader's location");
  assert.equal(tocEntryKey(data.toc[0]!), "chapter");
  assert.deepEqual(buildReaderNavigationItems(undefined, { activeTocEntryKey: null, pageNumber: 1 }), []);
});

test("shared navigation sorts anchors, deduplicates noted highlights and keeps sharing metadata", () => {
  const items = buildReaderNavigationItems(fixture(), { activeTocEntryKey: "section", pageNumber: 3, paragraphNumber: 2 });
  assert.deepEqual(items.map((item) => item.key), ["toc:chapter", "toc:section", "bookmark:bookmark", "note:note", "highlight:standalone"]);
  const note = items.find((item) => item.type === "note")!;
  assert.equal(note.excerpt, "Texto anotado");
  assert.equal(note.isReadOnly, true);
  assert.equal(note.authorLabel, "Ana");
  const bookmark = items.find((item) => item.type === "bookmark")!;
  assert.equal(bookmark.authorLabel, "@ana");
  assert.equal(bookmark.isOwnedByCurrentUser, false);
  assert.equal(items.find((item) => item.type === "highlight")!.isActive, false);
});

test("shared panel navigates through screen callbacks, filters levels and supports navigation-only annotations", async () => {
  await withUnsavedDom(async ({ root, document, button, window }) => {
    window.HTMLElement.prototype.scrollIntoView = function () {};
    const items = buildReaderNavigationItems(fixture(), { activeTocEntryKey: null, pageNumber: 1 });
    const selected: string[] = [];
    function Panel() {
      const [level, setLevel] = React.useState<1 | 2 | 3>(2);
      return React.createElement(ReaderNavigationPanelContent, {
        items,
        onSelectToc: (item) => selected.push(item.key),
        onSelectBookmark: (item) => selected.push(item.key),
        onSelectNote: (item) => selected.push(item.key),
        onSelectHighlight: (item) => selected.push(item.key),
        onTocMaxLevelChange: setLevel,
        tocMaxLevel: level
      });
    }
    await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Panel))));
    assert.equal(document.querySelectorAll(".reader-navigation-item-toc-card").length, 1);
    await act(async () => button("Ver hasta T3").click());
    assert.equal(document.querySelectorAll(".reader-navigation-item-toc-card").length, 2);
    await act(async () => (document.querySelectorAll(".reader-navigation-item-toc-card button")[1] as HTMLButtonElement).click());
    await act(async () => (document.querySelector(".reader-navigation-item-bookmark") as HTMLButtonElement).click());
    assert.equal(document.querySelector(".reader-note-delete"), null);
    await act(async () => (document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click());
    assert.match(document.body.textContent!, /Mi nota/);
    assert.match(document.body.textContent!, /Compartida por Ana/);
    assert.equal(document.querySelector(".reader-note-icon-button, .reader-note-delete"), null);
    const jumpButtons = document.querySelectorAll<HTMLButtonElement>(".reader-postit-jump-btn");
    assert.equal(jumpButtons.length, 2);
    for (const jump of jumpButtons) await act(async () => jump.click());
    assert.deepEqual(selected, ["toc:section", "bookmark:bookmark", "note:note", "highlight:standalone"]);
  });
});

test("reading still exposes annotation actions when callbacks are provided", async () => {
  await withUnsavedDom(async ({ root, document, window }) => {
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.confirm = () => true;
    const removed: string[] = [];
    const items = buildReaderNavigationItems(fixture(), { activeTocEntryKey: null, pageNumber: 1 });
    const select = () => {};
    await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(ReaderNavigationPanelContent, {
      items, onSelectToc: select, onSelectBookmark: select, onSelectNote: select, onSelectHighlight: select,
      onDeleteBookmark: async (id) => { removed.push(id); },
      onDeleteNote: (id) => { removed.push(id); },
      onDeleteHighlight: (id) => { removed.push(id); },
      onBeginHighlightEditing: select
    }))));
    await act(async () => (document.querySelector('[aria-label="Quitar de mis marcadores"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click());
    assert.ok(document.querySelector('[aria-label="Añadir nota al resaltado"]'));
    await act(async () => (document.querySelector('[aria-label="Quitar nota compartida"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[aria-label="Borrar resaltado"]') as HTMLButtonElement).click());
    assert.deepEqual(removed, ["bookmark", "note", "standalone"]);
  });
});

test("editor deletes owned bookmarks or removes direct shares after confirmation, without navigating or touching the draft", async () => {
  for (const owned of [true, false]) {
    await withUnsavedDom(async ({ root, document, window }) => {
      window.HTMLElement.prototype.scrollIntoView = function () {};
      let confirmed = false;
      const confirmations: string[] = [];
      window.confirm = (message) => { confirmations.push(message!); return confirmed; };
      const request = deferred<void>();
      const calls: unknown[][] = [];
      const errors: unknown[] = [];
      const onDeleteBookmark = editorBookmarkCallback({
        accessToken: "token", reviewBookId: "book",
        deleteBookmark: (...args: unknown[]) => { calls.push(["delete", ...args]); return request.promise; },
        setReviewBookmarkError: (error: unknown) => errors.push(error),
        queryClient: { invalidateQueries: async (options: unknown) => { calls.push(["invalidate", options]); } }
      });
      const data = fixture();
      data.bookmarks[0]!.isOwnedByCurrentUser = owned;
      data.bookmarks.push({ ...data.bookmarks[0]!, bookmarkId: "book-share", isOwnedByCurrentUser: false, visibilitySource: "BOOK" });
      const items = buildReaderNavigationItems(data, { activeTocEntryKey: null, pageNumber: 1 });
      const select = () => assert.fail("deleting a bookmark must not navigate the editor or reader");
      await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(ReaderNavigationPanelContent, {
        items, onSelectToc: select, onSelectBookmark: select, onSelectNote: select, onSelectHighlight: select,
        onDeleteBookmark
      }))));
      const buttons = document.querySelectorAll<HTMLButtonElement>(".reader-note-delete");
      assert.equal(buttons.length, 1, "book-wide shares must not expose deletion");
      const button = buttons[0]!;
      assert.equal(button.getAttribute("aria-label"), owned ? "Borrar marcador" : "Quitar de mis marcadores");
      await act(async () => button.click());
      assert.deepEqual(calls, [], "cancelling confirmation makes no request");
      confirmed = true;
      await act(async () => button.click());
      assert.equal(button.disabled, true);
      assert.ok(button.querySelector(".reader-bookmark-delete-spinner"));
      assert.deepEqual(calls, [["delete", "token", "book", "bookmark"]]);
      await act(async () => request.resolve());
      assert.equal(button.disabled, false);
      assert.deepEqual(errors, [null]);
      assert.deepEqual(calls.slice(1), ["reader-navigation", "reader-annotations", "builder-page-annotations"].map((key) => ["invalidate", { queryKey: [key, "book"] }]));
      assert.match(confirmations[0]!, owned ? /Borrar este marcador/ : /El marcador original no se borrará/);
    });
  }
});

test("editor bookmark deletion reports failures and guards missing credentials without refreshing page content", async () => {
  const errors: unknown[] = [];
  const bindings = {
    accessToken: "token", reviewBookId: "book",
    deleteBookmark: async () => { throw new Error("No se pudo borrar el marcador."); },
    setReviewBookmarkError: (error: unknown) => errors.push(error),
    queryClient: { invalidateQueries: () => assert.fail("a failed deletion must not refresh metadata or the editor draft") }
  };
  await editorBookmarkCallback(bindings)("bookmark");
  assert.deepEqual(errors, [null, "No se pudo borrar el marcador."]);
  errors.length = 0;
  await editorBookmarkCallback({ ...bindings, accessToken: null })("bookmark");
  await editorBookmarkCallback({ ...bindings, reviewBookId: "" })("bookmark");
  assert.deepEqual(errors, []);
});

test("editor index navigation stays in editing and awaits the unsaved-change guard without writing reading progress", async () => {
  const text = readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("BookBuilderPage.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let node: ts.FunctionDeclaration | undefined;
  function visit(item: ts.Node) {
    if (ts.isFunctionDeclaration(item) && item.name?.text === "jumpToReviewPage") node = item;
    ts.forEachChild(item, visit);
  }
  visit(source);
  assert.ok(node);
  for (const allowed of [false, true]) {
    const calls: unknown[][] = [];
    const pending = { current: false };
    const bindings = {
      reviewPageNavigationPendingRef: pending, selectedReviewBook: { totalPages: 10 }, reviewPageNumber: 1,
      confirmDiscardReviewChanges: async () => { calls.push(["confirm"]); return allowed; },
      setReviewPageNumber: (value: number) => calls.push(["page", value]),
      setReviewPageId: (value: string) => calls.push(["pageId", value]),
      setReviewPageJumpValue: (value: string) => calls.push(["input", value]),
      setReviewMessage: () => {}, setReviewError: () => {},
      setIsReviewIndexVisible: (value: boolean) => calls.push(["visible", value])
    };
    const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const jump = new Function(...Object.keys(bindings), `${code}; return jumpToReviewPage;`)(...Object.values(bindings));
    await jump(3);
    assert.deepEqual(calls, allowed ? [["confirm"], ["page", 3], ["pageId", ""], ["visible", false]] : [["confirm"], ["input", "1"]]);
    assert.equal(pending.current, false);
  }
});
