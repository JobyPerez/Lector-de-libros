import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(import.meta.url);
const text = readFileSync(new URL("../src/features/ai-settings/AiSettingsPage.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AiSettingsPage.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && ["placeholderTopModel", "mergeWithSavedModels", "isFreeZenModelId", "ModelCheckList"].includes(node.name?.text ?? "")).map((node) => node.getText(source)).join("\n");
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX };
const code = ts.transpileModule(functions, { compilerOptions }).outputText;
const { mergeWithSavedModels, ModelCheckList } = new Function("exports", "require", `${code}\nreturn { mergeWithSavedModels, ModelCheckList };`)({}, require);

test("OCR checklist shows all compatible models while summaries retain text and saved models", () => {
  const models = [{ id: "text-only", name: "Text only", supportsVision: false },
    ...Array.from({ length: 23 }, (_, index) => ({ id: `vision-${index}`, name: `Vision ${index}`, supportsVision: true }))];
  const props = { models, visible: [], onToggle() {} };
  const ocr = renderToStaticMarkup(React.createElement(ModelCheckList, { ...props, idPrefix: "ocr" }));
  assert.equal((ocr.match(/type="checkbox"/g) ?? []).length, 23);
  assert.doesNotMatch(ocr, /Text only/);
  assert.match(ocr, /Vision 22/);
  const summary = renderToStaticMarkup(React.createElement(ModelCheckList, { ...props, models: mergeWithSavedModels(models.slice(0, 5), ["saved-summary"], "default-summary", "summary"), idPrefix: "summary" }));
  assert.match(summary, /Text only|saved-summary|default-summary/);
  assert.equal((summary.match(/type="checkbox"/g) ?? []).length, 7);
});

for (const hasSavedOcr of [false, true]) test(`settings auto-load OCR once ${hasSavedOcr ? "with" : "without"} saved preferences, refresh full/empty/error catalogs and leave summaries unchanged`, async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root")!);
  const model = (id: string, supportsVision = true) => ({ id, name: id, description: "Live metadata", pricing: "Paid", supportsVision });
  const config = { models: [model("static-only"), ...Array.from({ length: 6 }, (_, index) => model(`summary-${index}`, false))] };
  const settings = { settings: { opencodeOcrModel: hasSavedOcr ? "saved-missing" : null, opencodeOcrVisibleModels: hasSavedOcr ? ["saved-missing", "vision-12"] : [], opencodeSummaryModel: "static-only", opencodeSummaryVisibleModels: [] }, effectiveModels: { ocrModel: "saved-missing", summaryModel: "static-only" }, isAdmin: false };
  const requests: Array<{ purpose: string; refresh: boolean | undefined }> = [];
  let resolveInitial!: (value: unknown) => void;
  let response: unknown = { source: "live", models: [], warning: "Live catalogue unavailable" };
  let fail = false;
  let submitted: any;
  const mocks: Record<string, unknown> = {
    "../../app/api": {
      fetchOpencodeTopModels: async (_token: string, purpose: string, refresh: boolean | undefined) => {
        requests.push({ purpose, refresh });
        assert.equal(purpose, "ocr", "summary must not fetch when its saved model is already merged");
        if (requests.length === 1) return new Promise((resolve) => { resolveInitial = resolve; });
        if (fail) throw new Error("Refresh network failure");
        return response;
      },
      updateAiSettings: async (_token: string, payload: unknown) => { submitted = payload; return settings; }
    },
    "../../app/auth-store": { useAuthStore: Object.assign((selector: (state: unknown) => unknown) => selector({ accessToken: "synthetic-token", user: { role: "USER" } }), { setState() {} }) },
    "../../app/book-language": { getDeepgramVoiceOptions: () => [], readStoredVoiceModel: (_language: string, fallback: string) => fallback, writeStoredVoiceModel() {} },
    "../../components/AwsCostBadge": { AwsCostBadge: () => null },
    "@tanstack/react-query": {
      useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === "ai-settings" ? settings : queryKey[0] === "ai-config" ? config : undefined, refetch: async () => {}, isLoading: false }),
      useQueryClient: () => ({ invalidateQueries: async () => {} })
    }
  };
  const exports: any = {};
  new Function("exports", "require", ts.transpileModule(text, { compilerOptions }).outputText)(exports, (id: string) => mocks[id] ?? require(id));
  const selects = () => document.querySelectorAll("select");
  const ocrSelect = () => selects()[0]!;
  const summarySelect = () => selects()[1]!;
  const ocrButton = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Refrescar modelos OCR")!;
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  try {
    await act(async () => { root.render(React.createElement(exports.AiSettingsPage)); });
    assert.equal(requests.length, 1, "auto-fetch must not depend on initial static models or missing saved IDs");
    assert.equal(ocrSelect().options.length, 1, "no static OCR initial seeding or saved placeholders");
    assert.equal(ocrSelect().value, "");
    assert.doesNotMatch(ocrSelect().innerHTML, /static-only|saved-missing/);
    const initialSummary = summarySelect().innerHTML;
    assert.match(initialSummary, /static-only/);
    assert.equal(summarySelect().options.length, 6, "five curated summary models plus server option");
    await act(async () => { resolveInitial({ source: "live", models: [...Array.from({ length: 13 }, (_, index) => model(`vision-${index}`)), model("text-only", false), model("vision-free")] }); });
    assert.equal(document.querySelectorAll(".ai-model-check-list")[0]!.querySelectorAll("input").length, 13);
    assert.match(document.body.textContent!, /Catálogo completo: 13 modelos OCR compatibles/);
    assert.doesNotMatch(ocrSelect().innerHTML, /saved-missing|static-only|vision-free|text-only/);
    assert.equal(ocrSelect().value, "");
    assert.match(document.body.textContent!, /Tu modelo OCR guardado no esta disponible/);
    await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(submitted.opencodeOcrModel, "saved-missing", "catalogue must not silently change persisted preferences");
    assert.deepEqual(submitted.opencodeOcrVisibleModels, settings.settings.opencodeOcrVisibleModels);
    await act(async () => { ocrButton().click(); });
    assert.equal(ocrSelect().options.length, 1);
    assert.match(document.body.textContent!, /Live catalogue unavailable/);
    await flush();
    assert.equal(requests.length, 2, "empty response must not trigger an autoload loop");
    response = { source: "live", models: [model("saved-missing")] };
    await act(async () => { ocrButton().click(); });
    assert.equal(ocrSelect().value, "saved-missing", "live metadata restores the exact saved selection absent static metadata");
    assert.doesNotMatch(document.body.textContent!, /Tu modelo OCR guardado no esta disponible/);
    fail = true;
    await act(async () => { ocrButton().click(); });
    assert.equal(ocrSelect().options.length, 1, "failed refresh must clear the last live catalogue");
    assert.match(document.body.textContent!, /Refresh network failure/);
    await flush();
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((entry) => entry.refresh), [false, true, true, true]);
    assert.equal(summarySelect().innerHTML, initialSummary);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
