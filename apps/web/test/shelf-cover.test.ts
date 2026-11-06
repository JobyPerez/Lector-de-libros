import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import ts from "typescript";

const shelf = ts.createSourceFile("ShelfPage.tsx", readFileSync(new URL("../src/features/shelf/ShelfPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function component(bindings: Record<string, unknown>) {
  const node = shelf.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ShelfBookCover");
  assert.ok(node);
  const code = ts.transpileModule(node.getText(shelf), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return ShelfBookCover;`)(...Object.values(bindings));
}

test("shelf only fetches near-visible covers, requests thumbnails, reuses cached blobs and releases object URLs", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://synthetic.invalid/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  function global(name: string, value: unknown) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
  global("window", dom.window);
  global("document", dom.window.document);
  global("IS_REACT_ACT_ENVIRONMENT", true);
  global("IntersectionObserver", class {
    entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      assert.equal(options.rootMargin, "200px");
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    disconnect() { this.entry.disconnected = true; }
  });
  const revoked: string[] = [];
  let objectUrls = 0;
  global("URL", { createObjectURL: () => `blob:cover-${++objectUrls}`, revokeObjectURL: (url: string) => revoked.push(url) });
  const calls: unknown[][] = [];
  let userId = "user-a";
  const Cover = component({ React, useQuery, useEffect, useRef, useState,
    useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { userId } }),
    fetchBookCover: async (...args: unknown[]) => { calls.push(args); return new Blob(["thumbnail"]); },
    buildBookMonogram: () => "LB", describeSourceType: () => "Edicion digital" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const book = { bookId: "book", updatedAt: "v1", title: "Test book", sourceType: "EPUB" };
  const render = async (visible = true, currentBook = book, accessToken: string | null = "token") => {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, visible ? React.createElement(Cover, { book: currentBook, accessToken }) : null));
    });
  };
  const intersect = async () => {
    await act(async () => {
      observers.at(-1)!.callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  };
  try {
    await render();
    assert.equal(calls.length, 0, "off-screen covers make no network request");
    await intersect();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.slice(0, 4), ["token", "book", "v1", true]);
    assert.ok(calls[0]![4] instanceof AbortSignal);
    assert.equal(observers[0]!.disconnected, true);
    assert.ok(dom.window.document.querySelector("img")?.src.startsWith("blob:cover-"));
    await render(false);
    assert.equal(revoked.length, 1);
    await render();
    await intersect();
    assert.equal(calls.length, 1, "returning to the shelf reuses its cached thumbnail");
    await render(true, { ...book, updatedAt: "v2" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    assert.equal(calls.length, 2, "a changed book version fetches a fresh cover");
    userId = "user-b";
    await render(true, { ...book, updatedAt: "v2" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    assert.equal(calls.length, 3, "different accounts do not reuse private query data");
    await render(false);
    await render(true, book, null);
    await intersect();
    assert.equal(calls.length, 3, "no cover requests without an access token");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("cover transport keeps originals by default, opts into thumbnails and propagates cancellation", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const code = ts.transpileModule(readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"https://synthetic.invalid"'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  let status = 200;
  new Function("exports", "require", "fetch", code)(api, () => ({}), async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return new Response("cover", { status });
  });
  const controller = new AbortController();
  await api.fetchBookCover!("token", "book", "v1", true, controller.signal);
  assert.equal(new URL(calls[0]!.url).searchParams.get("thumbnail"), "true");
  assert.equal(new URL(calls[0]!.url).searchParams.get("v"), "v1");
  assert.equal(calls[0]!.options.signal, controller.signal);
  await api.fetchBookCover!("token", "book");
  assert.equal(new URL(calls[1]!.url).searchParams.has("thumbnail"), false);
  status = 404;
  assert.equal(await api.fetchBookCover!("token", "missing", "v1", true), null);
});
