import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { withUnsavedDom } from "./unsaved-changes-fixture";

function loadChooser() {
  const exports: any = {};
  const source = readFileSync(new URL("../src/components/choosePdfDownloadProfile.ts", import.meta.url), "utf8");
  new Function("exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(exports);
  return exports.choosePdfDownloadProfile as (title: string, format: "pdf" | "pdf-images") => Promise<string | null>;
}

test("PDF options default to balanced, allow each profile, and restore focus after confirmation", async () => {
  await withUnsavedDom(async ({ document, button }) => {
    const choose = loadChooser();
    const origin = document.getElementById("origin")!;
    for (const profile of ["original", "balanced", "compact", "text-only"]) {
      origin.focus();
      const pending = choose("Libro <img src=x onerror=alert(1)>", "pdf");
      const dialog = document.querySelector("dialog")!;
      assert.equal(dialog.querySelector<HTMLInputElement>("input:checked")!.value, "balanced");
      assert.equal(dialog.querySelectorAll("input[type=radio]").length, 4);
      assert.equal(dialog.querySelector("img"), null, "book titles are plain text");
      dialog.querySelector<HTMLInputElement>(`input[value='${profile}']`)!.click();
      button("Descargar PDF").click();
      assert.equal(await pending, profile);
      assert.equal(document.querySelector("dialog"), null);
      assert.equal(document.activeElement, origin);
    }
  });
});

test("image PDFs exclude text-only and cancellation starts no download, including Escape and concurrent opens", async () => {
  await withUnsavedDom(async ({ document, window, button }) => {
    const choose = loadChooser();
    const pending = choose("Libro", "pdf-images");
    assert.equal(document.querySelectorAll("input[type=radio]").length, 3);
    assert.equal(document.querySelector("input[value='text-only']"), null);
    assert.equal(await choose("Otro", "pdf"), null);
    button("Cancelar").click();
    assert.equal(await pending, null);
    const next = choose("Libro", "pdf");
    document.querySelector("dialog")!.dispatchEvent(new window.Event("cancel", { cancelable: true }));
    assert.equal(await next, null);
    assert.equal(document.querySelector("dialog"), null);
  });
});
