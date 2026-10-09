import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as reactQuery from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(import.meta.url);
test("AI settings transport preserves null clears and omitted model fields", async () => {
  const requests: RequestInit[] = [];
  const source = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: any = {};
  new Function("exports", "require", "fetch", code)(api, () => ({}), async (_url: string, options: RequestInit) => {
    requests.push(options);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  await api.updateAiSettings("synthetic", { opencodeOcrModel: null, opencodeSummaryModel: null, opencodeOcrVisibleModels: ["haiku"] });
  assert.deepEqual(JSON.parse(String(requests[0]!.body)), { opencodeOcrModel: null, opencodeSummaryModel: null, opencodeOcrVisibleModels: ["haiku"] });
  await api.updateAiSettings("synthetic", { opencodeOcrVisibleModels: ["haiku"] });
  assert.deepEqual(JSON.parse(String(requests[1]!.body)), { opencodeOcrVisibleModels: ["haiku"] });
});

test("settings refresh and save publish to the real user-scoped cache consumed by OCR and AI selection", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const model = (id: string) => ({ id, name: id, description: "Live", pricing: "Paid", supportsVision: true });
  let saved = { settings: { opencodeOcrModel: "haiku" as string | null, opencodeOcrVisibleModels: ["haiku", "qwen"], opencodeSummaryModel: "haiku" as string | null, opencodeSummaryVisibleModels: ["haiku"] }, effectiveModels: { ocrModel: "haiku", summaryModel: "haiku" }, isAdmin: false };
  const submissions: any[] = [];
  let catalog = { source: "live", models: [model("haiku"), model("qwen"), model("unmarked")] };
  let userId = "user-a";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const keysSource = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("api.ts", keysSource, ts.ScriptTarget.Latest, true);
  const keys = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ["aiSettingsQueryKey", "aiCatalogQueryKey"].includes(entry.name.getText(ast)))).map((node) => node.getText(ast)).join("\n");
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX };
  const api: any = {};
  new Function("exports", ts.transpileModule(keys, { compilerOptions }).outputText)(api);
  Object.assign(api, {
    fetchAiConfig: async () => ({ models: [model("haiku"), model("qwen")], summaryModelIds: ["haiku", "qwen"], ocrModel: "unmarked" }),
    fetchAiSettings: async () => userId === "user-a" ? saved : { ...saved, effectiveModels: { ...saved.effectiveModels, ocrModel: "qwen" } },
    fetchOpencodeTopModels: async () => catalog,
    updateAiSettings: async (_token: string, payload: any) => {
      submissions.push(payload);
      saved = { ...saved, settings: { ...saved.settings, ...payload }, effectiveModels: { ocrModel: payload.opencodeOcrModel ?? "haiku", summaryModel: payload.opencodeSummaryModel ?? "qwen" } };
      return { settings: saved.settings };
    }
  });
  const auth = { useAuthStore: Object.assign((selector: (state: any) => any) => selector({ accessToken: "synthetic", user: { userId, role: "USER" } }), { setState() {} }) };
  const load = (path: string, mocks: Record<string, unknown>) => {
    const exports: any = {};
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions }).outputText;
    new Function("exports", "require", code)(exports, (id: string) => id === "@tanstack/react-query" ? reactQuery : mocks[id] ?? require(id));
    return exports;
  };
  const badge = load("../src/components/AiModelBadge.tsx", { "../app/api": api, "../app/auth-store": auth });
  const ocr = load("../src/components/OcrConfig.tsx", { "../app/api": api, "../app/auth-store": auth, "./AiModelBadge": badge });
  const page = load("../src/features/ai-settings/AiSettingsPage.tsx", {
    "../../app/api": api, "../../app/auth-store": auth,
    "../../app/book-language": { getDeepgramVoiceOptions: () => [], readStoredVoiceModel: (_language: string, fallback: string) => fallback, writeStoredVoiceModel() {} },
    "../../components/AwsCostBadge": { AwsCostBadge: () => null }
  });
  let selection: any;
  function Consumers() {
    selection = ocr.useOcrModelSelection("append:book");
    badge.useAiModelSelection();
    return React.createElement(ocr.OcrModelSelect, { ...selection, value: selection.selectedModelId, onChange: selection.setSelectedModelId });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = () => act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(React.Fragment, null, React.createElement(page.AiSettingsPage), React.createElement(Consumers)))); });
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    await render();
    await flush();
    await flush();
    assert.equal(selection.selectedModelId, "haiku");
    assert.equal(document.querySelectorAll("select")[0]!.value, "haiku", "own saved Haiku remains selected, not server choice");
    assert.deepEqual(selection.models.map((entry: any) => entry.id), ["haiku", "qwen"]);
    await act(async () => { selection.setSelectedModelId("qwen"); });
    catalog = { ...catalog, models: [model("haiku")] };
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Refrescar modelos OCR")!.click(); });
    await flush();
    assert.deepEqual(client.getQueryData(api.aiCatalogQueryKey("user-a", "ocr")), catalog);
    assert.deepEqual(selection.models.map((entry: any) => entry.id), ["haiku"]);
    assert.equal(selection.canRunOcr("VISION", false), false);
    catalog = { ...catalog, models: [model("haiku"), model("qwen")] };
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Refrescar modelos OCR")!.click(); });
    await flush();
    await act(async () => { selection.setSelectedModelId("haiku"); });
    await act(async () => { Simulate.change(document.querySelectorAll("select")[0]!, { target: { value: "qwen" } } as any); });
    await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    assert.equal((client.getQueryData(api.aiSettingsQueryKey("user-a")) as any).effectiveModels.ocrModel, "qwen");
    assert.equal(selection.selectedModelId, "qwen", "saving a fresh preference resets a previous override");
    const otherPreferences = ({ opencodeOcrModel, opencodeSummaryModel, ...other }: any) => other;
    const clearDefault = async (index: number) => {
      const select = document.querySelectorAll("select")[index]!;
      assert.equal(select.options[0]!.textContent, "Usar servidor");
      assert.equal(select.options[0]!.disabled, false);
      await act(async () => { Simulate.change(select, { target: { value: "" } } as any); });
      await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
      await flush();
    };
    await clearDefault(0);
    assert.equal(submissions[1].opencodeOcrModel, null);
    assert.equal(submissions[1].opencodeSummaryModel, "haiku", "clearing OCR retains the summary override");
    assert.deepEqual(otherPreferences(submissions[1]), otherPreferences(submissions[0]));
    assert.equal((client.getQueryData(api.aiSettingsQueryKey("user-a")) as any).settings.opencodeOcrModel, null);
    assert.equal(selection.selectedModelId, "haiku", "OCR consumes the freshly resolved server default after clearing");
    assert.equal(document.querySelectorAll("select")[0]!.value, "", "own null stays server choice even though effective model is Haiku");
    await clearDefault(1);
    assert.equal(submissions[2].opencodeOcrModel, null);
    assert.equal(submissions[2].opencodeSummaryModel, null);
    assert.deepEqual(otherPreferences(submissions[2]), otherPreferences(submissions[0]));
    assert.equal((client.getQueryData(api.aiSettingsQueryKey("user-a")) as any).settings.opencodeSummaryModel, null);
    assert.equal(document.querySelectorAll("select")[1]!.value, "");
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Refrescar top-5 resúmenes")!.click(); });
    await flush();
    assert.equal(document.querySelectorAll("select")[1]!.value, "", "summary catalog refresh must not select a new override for server choice");
    await act(async () => { selection.setSelectedModelId("haiku"); });
    userId = "user-b";
    await render();
    await flush();
    await flush();
    assert.equal(selection.selectedModelId, "qwen");
    assert.notEqual(client.getQueryData(api.aiSettingsQueryKey("user-a")), client.getQueryData(api.aiSettingsQueryKey("user-b")));
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
