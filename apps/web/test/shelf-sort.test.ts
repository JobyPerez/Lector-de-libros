import assert from "node:assert/strict";
import { test } from "node:test";

import { readShelfSortMode, saveShelfSortMode } from "../src/features/shelf/shelf-sort";

test("shelf sorting persists all modes independently for each user", (t) => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    }
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  assert.equal(readShelfSortMode("alice"), "lastOpened");
  for (const mode of ["rating", "readingDate", "publicationYear", "lastOpened"] as const) {
    saveShelfSortMode("alice", mode);
    assert.equal(readShelfSortMode("alice"), mode);
    assert.equal(readShelfSortMode("bob"), "lastOpened");
  }
  values.set("lector:shelf-sort:alice", "invalid");
  assert.equal(readShelfSortMode("alice"), "lastOpened");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage blocked"); }
  });
  assert.equal(readShelfSortMode("alice"), "lastOpened");
  assert.doesNotThrow(() => saveShelfSortMode("alice", "rating"));
});
