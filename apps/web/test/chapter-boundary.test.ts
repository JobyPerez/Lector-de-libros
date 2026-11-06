import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";

import type { ReaderTocEntry } from "../src/app/api";
import { ReaderChapterBoundary } from "../src/features/reader/ReaderChapterBoundary";
import { nextChapterBoundaryPage, parseChapterBoundaryLevel, readChapterBoundaryLevel, saveChapterBoundaryLevel } from "../src/features/reader/chapter-boundary";
import { withUnsavedDom } from "./unsaved-changes-fixture";

const toc: ReaderTocEntry[] = [
  { level: 1, pageNumber: 1, paragraphNumber: 1, sequenceNumber: 1, title: "Capítulo" },
  { level: 2, pageNumber: 5, paragraphNumber: 1, sequenceNumber: 5, title: "Apartado" },
  { level: 3, pageNumber: 8, paragraphNumber: 1, sequenceNumber: 8, title: "Detalle" },
  { level: 2, pageNumber: 12, paragraphNumber: 3, sequenceNumber: 12, title: "Otro apartado" },
  { level: 1, pageNumber: 20, paragraphNumber: 1, sequenceNumber: 20, title: "Otro capítulo" }
];

test("chapter boundary respects the selected level and includes ancestor boundaries", () => {
  assert.equal(nextChapterBoundaryPage(toc, 6, 1, 1, 30), 20);
  assert.equal(nextChapterBoundaryPage(toc, 6, 1, 2, 30), 12);
  assert.equal(nextChapterBoundaryPage(toc, 6, 1, 3, 30), 8);
  assert.equal(nextChapterBoundaryPage(toc, 13, 1, 2, 30), 20);
  assert.equal(nextChapterBoundaryPage(toc, 20, 1, 3, 30), 30);
  assert.equal(nextChapterBoundaryPage([], 1, 1, 1, 30), 30);
  assert.equal(nextChapterBoundaryPage([...toc].reverse(), 6, 1, 3, 30), 8);
});

test("chapter boundary handles headings on the current page", () => {
  assert.equal(nextChapterBoundaryPage(toc, 12, 2, 2, 30), 12);
  assert.equal(nextChapterBoundaryPage(toc, 12, 3, 2, 30), 20);
  assert.equal(nextChapterBoundaryPage(toc, 12, 4, 2, 30), 20);
});

test("invalid or unavailable preferences default to T1", () => {
  for (const value of [null, undefined, "invalid", "0", "4"]) assert.equal(parseChapterBoundaryLevel(value), 1);
  assert.equal(parseChapterBoundaryLevel("1"), 1);
  assert.equal(parseChapterBoundaryLevel("2"), 2);
  assert.equal(parseChapterBoundaryLevel("3"), 3);
  assert.equal(readChapterBoundaryLevel("book", "user"), 1);
  assert.doesNotThrow(() => saveChapterBoundaryLevel("book", "user", 1));
});

test("clicking the number selects a level, persists per book/user and restores on reopening", async (t) => {
  await withUnsavedDom(async ({ document, window, root, button }) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    const render = async (bookId: string) => {
      await act(async () => root.render(React.createElement(ReaderChapterBoundary, {
        bookId, toc, pageNumber: 6, paragraphNumber: 1, totalPages: 30
      })));
    };
    await render("book-a");
    const trigger = () => document.querySelector<HTMLButtonElement>(".reader-next-chapter-page")!;
    assert.equal(trigger().textContent, "→20");
    await act(async () => trigger().click());
    assert.equal(trigger().getAttribute("aria-expanded"), "true");
    await act(async () => button("T2").click());
    assert.equal(trigger().textContent, "→12");
    assert.equal(readChapterBoundaryLevel("book-a", ""), 2);
    assert.equal(readChapterBoundaryLevel("book-a", "another-user"), 1);
    assert.equal(document.querySelector('[role="group"]'), null);
    await render("book-b");
    assert.equal(trigger().textContent, "→20");
    await render("book-a");
    assert.equal(trigger().textContent, "→12");
    await act(async () => trigger().click());
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger());
    await act(async () => trigger().click());
    await act(async () => document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
  });
});
