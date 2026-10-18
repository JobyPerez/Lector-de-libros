import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };

function loadDownload(fetch: (...args: any[]) => Promise<unknown>) {
  const api: any = {};
  const apiSource = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8")
    .replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  new Function("exports", "require", "fetch", ts.transpileModule(apiSource, { compilerOptions }).outputText)(api, () => ({}), fetch);
  const clicks: string[] = [];
  const revoked: string[] = [];
  const timers: (() => void)[] = [];
  const anchor = { href: "", download: "", click() { clicks.push(this.download); }, remove() {} };
  const result: any = {};
  const source = readFileSync(new URL("../src/app/book-download.ts", import.meta.url), "utf8");
  new Function("exports", "require", "document", "URL", "window", ts.transpileModule(source, { compilerOptions }).outputText)(
    result, () => api,
    { createElement: () => anchor, body: { append() {} } },
    { createObjectURL: () => "blob:book", revokeObjectURL: (url: string) => revoked.push(url) },
    { setTimeout: (callback: () => void) => timers.push(callback) }
  );
  return { download: result.downloadBookToDevice, clicks, revoked, timers };
}

test("download stays pending until the file body is ready and preserves the server filename", async () => {
  let finish!: (blob: Blob) => void;
  const body = new Promise<Blob>((resolve) => { finish = resolve; });
  const requests: any[][] = [];
  const harness = loadDownload(async (...args) => {
    requests.push(args);
    return { ok: true, headers: new Headers({ "Content-Disposition": 'attachment; filename="original.epub"' }), blob: () => body };
  });
  let completed = false;
  const pending = harness.download("token", "book", "Title").then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(harness.clicks, []);
  assert.equal(requests[0]![0], "http://synthetic.invalid/books/book/download-original");
  assert.equal(requests[0]![1].headers.Authorization, "Bearer token");
  finish(new Blob(["book"]));
  await pending;
  assert.deepEqual(harness.clicks, ["original.epub"]);
  assert.deepEqual(harness.revoked, []);
  harness.timers[0]!();
  assert.deepEqual(harness.revoked, ["blob:book"]);
});

test("export errors reach the caller without starting an empty download", async () => {
  const harness = loadDownload(async (url) => {
    assert.equal(url, "http://synthetic.invalid/books/book/export/pdf-images");
    return new Response(JSON.stringify({ message: "No se pudo preparar el PDF" }), { status: 500 });
  });
  await assert.rejects(harness.download("token", "book", "Title", "pdf-images"), /No se pudo preparar el PDF/);
  assert.deepEqual(harness.clicks, []);
});

test("original EPUB keeps its extension when the filename header is unavailable", async () => {
  const harness = loadDownload(async () => new Response("book", { headers: { "Content-Type": "application/epub+zip" } }));
  await harness.download("token", "book", "Title: subtitle");
  assert.deepEqual(harness.clicks, ["Title_ subtitle.epub"]);
});

test("selected compression profile reaches the authenticated export endpoint", async () => {
  for (const profile of ["balanced", "compact", "text-only"]) {
    const harness = loadDownload(async (url, options) => {
      assert.equal(url, `http://synthetic.invalid/books/book/export/pdf?profile=${profile}`);
      assert.equal(options.headers.Authorization, "Bearer token");
      return new Response("pdf", { headers: { "Content-Type": "application/pdf" } });
    });
    await harness.download("token", "book", "Title", "pdf", profile);
    assert.equal(harness.clicks.length, 1);
  }
});
