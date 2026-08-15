import assert from "node:assert/strict";
import test from "node:test";

import { inferSourceType } from "../src/modules/books/book-import.js";

test("detecta PDF y EPUB por el tipo MIME", () => {
  assert.equal(inferSourceType("libro", "application/pdf"), "PDF");
  assert.equal(inferSourceType("libro", "application/epub+zip"), "EPUB");
});

test("detecta PDF y EPUB por la extension cuando el MIME es generico", () => {
  assert.equal(inferSourceType("libro.PDF", "application/octet-stream"), "PDF");
  assert.equal(inferSourceType("libro.EPUB", "application/octet-stream"), "EPUB");
});

test("rechaza formatos no admitidos", () => {
  assert.equal(inferSourceType("libro.txt", "text/plain"), null);
});
