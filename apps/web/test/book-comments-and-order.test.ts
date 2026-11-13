import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { Simulate } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as reactQuery from "@tanstack/react-query";
import { applyAnnotationOrder, moveAnnotation } from "../src/features/reader/annotation-order";
import { loadTestModule, withUnsavedDom } from "./unsaved-changes-fixture";

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
const auth = { useAuthStore: (selector: (state: any) => unknown) => selector({ accessToken: "synthetic", user: { userId: "user" } }) };

function loadCommentsPanel(api: Record<string, unknown>) {
  const mocks = { "../../app/api": api, "../../app/auth-store": auth, "@tanstack/react-query": reactQuery };
  const sortable = loadTestModule("../src/features/reader/SortableNotesList.tsx", mocks);
  return loadTestModule("../src/features/reader/BookCommentsPanel.tsx", { ...mocks, "./SortableNotesList": sortable });
}

test("manual order ignores deleted entries, appends new entries and never mutates navigation", () => {
  const items = [{ key: "note:a" }, { key: "highlight:b" }, { key: "note:c" }];
  assert.deepEqual(applyAnnotationOrder(items, ["deleted", "note:c", "note:a"]).map((item) => item.key), ["note:c", "note:a", "highlight:b"]);
  assert.deepEqual(moveAnnotation(items, "note:a", "note:c").map((item) => item.key), ["highlight:b", "note:c", "note:a"]);
  assert.deepEqual(items.map((item) => item.key), ["note:a", "highlight:b", "note:c"]);
  assert.equal(moveAnnotation(items, "missing", "note:a"), items);
});

test("comment editor accepts either field or both, rejects whitespace and preserves a draft after errors", async () => {
  await withUnsavedDom(async ({ root, document, button }) => {
    const { CommentEditor } = loadCommentsPanel({});
    const submissions: any[] = [];
    let fail = false;
    await act(async () => root.render(React.createElement(CommentEditor, {
      initialValue: { title: "", commentText: "" }, isSaving: false, onCancel() {},
      onSave: async (value: unknown) => { if (fail) throw new Error("No guardado"); submissions.push(value); }
    })));
    assert.equal(button("Guardar comentario").disabled, true);
    const title = document.querySelector("input")!, text = document.querySelector("textarea")!;
    const change = async (element: Element, value: string) => act(async () => Simulate.change(element, { target: { value } } as any));
    const submit = async () => act(async () => Simulate.submit(document.querySelector("form")!));
    await change(title, " \t ");
    assert.equal(button("Guardar comentario").disabled, true);
    await change(title, " Título "); await submit();
    await change(title, ""); await change(text, " Texto "); await submit();
    await change(title, "Ambos"); await submit();
    assert.deepEqual(submissions, [{ title: "Título", commentText: "" }, { title: "", commentText: "Texto" }, { title: "Ambos", commentText: "Texto" }]);
    fail = true; await submit();
    assert.equal(title.value, "Ambos");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /No guardado/);
  });
});

test("comment cards allow sharing/editing only one's own and removing only direct received shares", async () => {
  await withUnsavedDom(async ({ root, document, window, button }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const date = new Date().toISOString();
    const makeComment = (id: string, source: string) => ({ commentId: id, title: id, commentText: "Texto", userId: source === "OWN" ? "user" : "author", username: "ana", userDisplayName: "Ana", createdAt: date, updatedAt: date, isOwnedByCurrentUser: source === "OWN", sharedWithUserIds: [], visibilitySource: source });
    let comments = [makeComment("own", "OWN"), makeComment("direct", "DIRECT"), makeComment("global", "BOOK")];
    const shares: unknown[] = [], removed: string[] = [];
    const api = {
      fetchAnnotationOrder: async (_token: string, _book: string, scope: string) => { assert.equal(scope, "comments"); return { keys: [] }; },
      fetchBookComments: async () => ({ canComment: true, comments }),
      fetchAnnotationShareUsers: async () => ({ users: [{ userId: "recipient", username: "bea", displayName: null }] }),
      updateBookCommentShares: async (_token: string, _book: string, id: string, users: string[]) => { shares.push([id, users]); comments = comments.map((c) => c.commentId === id ? { ...c, sharedWithUserIds: users } : c); },
      deleteBookComment: async (_token: string, _book: string, id: string) => { removed.push(id); comments = comments.filter((c) => c.commentId !== id); }
    };
    const { BookCommentsPanel, BookCommentsCount } = loadCommentsPanel(api);
    window.confirm = () => true;
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(React.Fragment, null,
      React.createElement(BookCommentsCount, { bookId: "book" }), React.createElement(BookCommentsPanel, { bookId: "book" })))));
    await flush();
    assert.equal(document.querySelectorAll("article").length, 3);
    assert.equal(document.querySelector(".reader-navigation-tab-count")?.textContent, "3");
    assert.equal(document.querySelectorAll('[aria-label^="Mover comentario"]').length, 3);
    assert.equal(document.querySelectorAll('article [aria-label^="Mover comentario"]').length, 3, "drag handles must be inside each comment card");
    assert.doesNotMatch(document.body.textContent ?? "", /Arrastra el asa/);
    assert.equal(document.querySelectorAll('[aria-label="Editar comentario"]').length, 1);
    assert.equal(document.querySelectorAll('[aria-label="Compartir comentario (Privado)"]').length, 1);
    for (const label of ["Editar comentario", "Compartir comentario (Privado)", "Borrar comentario", "Quitar comentario compartido"]) {
      const action = button(label);
      assert.ok(action.querySelector('svg[aria-hidden="true"]'), label);
      assert.equal(action.textContent, "", "actions must use icons rather than visible text");
      assert.ok(action.title, "icon buttons must retain tooltips");
    }
    assert.match(document.querySelectorAll("article")[1]!.textContent!, /Compartido por Ana · Solo lectura/);
    assert.equal(document.querySelectorAll("article")[2]!.querySelector(".reader-note-actions button"), null);
    await act(async () => button("Compartir comentario (Privado)").click());
    await act(async () => button("@bea").click());
    await act(async () => button("Guardar destinatarios").click());
    await flush();
    assert.deepEqual(shares, [["own", ["recipient"]]]);
    await act(async () => button("Quitar comentario compartido").click());
    await flush();
    assert.deepEqual(removed, ["direct"]);
    assert.equal(document.querySelectorAll("article").length, 2);
    assert.equal(document.querySelector(".reader-navigation-tab-count")?.textContent, "2");
    client.clear();
  });
});

for (const scope of ["notes", "comments"] as const) test(`${scope} reorder with keyboard and pointer drag, persist after remount, and roll back on save failure`, async () => {
  await withUnsavedDom(async ({ root, document, window, button }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const initialKeys = scope === "comments" ? ["comment:a", "comment:b", "comment:c"] : ["note:a", "highlight:b", "note:c"];
    const items = initialKeys.map((key) => ({ key }));
    const handleLabel = `Mover ${scope === "comments" ? "comentario" : "nota"} 1 de 3`;
    let keys: string[] = [], fail = false;
    const saves: string[][] = [];
    const { SortableNotesList } = loadTestModule("../src/features/reader/SortableNotesList.tsx", {
      "@tanstack/react-query": reactQuery, "../../app/auth-store": auth,
      "../../app/api": {
        fetchAnnotationOrder: async (_token: string, _book: string, requestedScope: string) => { assert.equal(requestedScope, scope); return { keys }; },
        saveAnnotationOrder: async (_token: string, _book: string, next: string[], requestedScope: string) => { assert.equal(requestedScope, scope); if (fail) throw new Error("No guardado"); saves.push(next); keys = next; }
      }
    });
    let instance = 0;
    const render = () => act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(SortableNotesList, { key: instance, bookId: "book", scope, items, renderItem: (item: { key: string }, dragHandle: React.ReactNode) => React.createElement("article", null, dragHandle, item.key) }))));
    const current = () => [...document.querySelectorAll<HTMLElement>("[data-note-order-key]")].map((element) => element.dataset.noteOrderKey);
    await render(); await flush();
    await act(async () => Simulate.keyDown(button(handleLabel), { key: "ArrowDown" }));
    await flush();
    assert.deepEqual(current(), [initialKeys[1], initialKeys[0], initialKeys[2]]);
    instance++; client.clear(); await render(); await flush();
    assert.deepEqual(current(), keys);
    const handle = button(handleLabel);
    (handle as any).setPointerCapture = () => {};
    (document as any).elementFromPoint = () => document.querySelectorAll("[data-note-order-key]")[2];
    await act(async () => Simulate.pointerDown(handle, { pointerId: 1, button: 0, clientY: 10 } as any));
    await act(async () => Simulate.pointerMove(handle, { pointerId: 1, clientY: 100, clientX: 20 } as any));
    await act(async () => Simulate.pointerUp(handle, { pointerId: 1 } as any));
    await flush();
    assert.deepEqual(current(), [initialKeys[0], initialKeys[2], initialKeys[1]]);
    assert.equal(saves.length, 2);
    fail = true;
    await act(async () => Simulate.keyDown(button(handleLabel), { key: "ArrowDown" }));
    await flush();
    assert.deepEqual(current(), keys);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /No guardado/);
    assert.deepEqual(items.map((item) => item.key), initialKeys);
    client.clear();
  });
});
