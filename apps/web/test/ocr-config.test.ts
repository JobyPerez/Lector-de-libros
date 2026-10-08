import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiConfigResponse, AiSettingsResponse, OpencodeTopModelsResponse } from "../src/app/api";
import { loadOcrConfig } from "./ocr-config-fixture";

const config = { ocrModel: "gpt-5.4-mini", models: [{ id: "gpt-5.4-mini", name: "Server model", description: "Static", pricing: "Paid", supportsVision: true }] } as AiConfigResponse;
const settings = { effectiveModels: { ocrModel: "user-vision" }, settings: { opencodeOcrModel: "obsolete-saved-model", opencodeOcrVisibleModels: ["live-vision", "missing-saved"] } } as AiSettingsResponse;
const live = { source: "live", models: [{ id: "live-vision", name: "Live Vision", description: "Live", pricing: "Paid", supportsVision: true }, { id: "text-only", supportsVision: false }] } as OpencodeTopModelsResponse;

test("OCR hook retains effective user preference without offering saved or static entries", () => {
  const shared = loadOcrConfig(config, settings, live);
  let selection: ReturnType<typeof shared.useOcrModelSelection>;
  function Harness() { selection = shared.useOcrModelSelection(); return React.createElement(shared.OcrModelSelect, { models: selection.models, value: selection.selectedModelId, onChange: selection.setSelectedModelId, compatibilityMessage: selection.compatibilityMessage }); }
  const html = renderToStaticMarkup(React.createElement(Harness));
  assert.equal(selection!.selectedModelId, "user-vision");
  assert.deepEqual(selection!.models.map((model) => model.id), ["live-vision"]);
  assert.match(html, /value="" disabled="" selected/);
  assert.doesNotMatch(html, /value="user-vision"|Server model|obsolete-saved-model|text-only|missing-saved/);
  assert.equal(selection!.canRunOcr("VISION", false), false);
  assert.equal(settings.settings.opencodeOcrModel, "obsolete-saved-model");
});

test("backend live capabilities supersede outdated static false, even without static metadata", () => {
  const { resolveOcrModels } = loadOcrConfig();
  const catalog = { ...config, models: [...config.models, { ...config.models[0]!, id: "glm-5", supportsVision: false }] };
  for (const staticConfig of [catalog, undefined]) for (const id of ["glm-5", "claude-new", "grok-new", "qwen-new"]) {
    const response = { source: "live", models: [{ ...live.models[0]!, id }] } as OpencodeTopModelsResponse;
    const saved = { ...settings, effectiveModels: { ...settings.effectiveModels, ocrModel: id } };
    const result = resolveOcrModels(staticConfig, saved, response);
    assert.equal(result.selectedModelId, id);
    assert.equal(result.status, "supported");
    assert.equal(result.canRunOcr("VISION", true), true);
    assert.equal(result.canRunOcr("TEXTRACT", true), true);
    assert.deepEqual(result.models.map((model) => model.id), [id]);
  }
});

test("live incompatible selections stay unavailable and never become dropdown options", () => {
  const { resolveOcrModels, OcrModelSelect } = loadOcrConfig();
  const result = resolveOcrModels(config, settings, live, "text-only");
  assert.equal(result.status, "unsupported");
  assert.equal(result.canRunOcr("VISION", false), false);
  assert.equal(result.canRunOcr("TEXTRACT", true), false);
  assert.equal(result.canRunOcr("TEXTRACT", false), true);
  assert.equal(result.canRunOcr("LOCAL", true), true);
  const html = renderToStaticMarkup(React.createElement(OcrModelSelect, { models: result.models, value: result.selectedModelId, compatibilityMessage: result.compatibilityMessage, onChange() {} }));
  assert.doesNotMatch(html, /value="text-only"/);
  assert.match(html, /no admite imagenes/);
});

test("loading, failed, empty and curated catalogs never fall back to static OCR models", () => {
  const { resolveOcrModels } = loadOcrConfig();
  for (const response of [undefined, { source: "live", models: [] }, { source: "curated", models: config.models }] as (OpencodeTopModelsResponse | undefined)[]) {
    const result = resolveOcrModels(config, undefined, response);
    assert.equal(result.selectedModelId, config.ocrModel);
    assert.deepEqual(result.models, []);
    assert.equal(result.canRunOcr("VISION", false), false);
    assert.equal(result.status, "unconfirmed");
  }
});

test("loading or failed user settings cannot execute the paid server fallback", () => {
  for (const status of ["pending", "error"] as const) {
    const shared = loadOcrConfig(config, undefined, live, status);
    let selection: ReturnType<typeof shared.useOcrModelSelection>;
    function Harness() { selection = shared.useOcrModelSelection(); return null; }
    renderToStaticMarkup(React.createElement(Harness));
    assert.equal(selection!.supportsVision, false);
    assert.equal(selection!.canRunOcr("VISION", false), false);
    assert.equal(selection!.canRunOcr("TEXTRACT", false), true);
  }
});

test("failed live query cannot offer or execute stale cached models", () => {
  const shared = loadOcrConfig(config, settings, live, undefined, "error");
  let selection: ReturnType<typeof shared.useOcrModelSelection>;
  function Harness() { selection = shared.useOcrModelSelection(); return null; }
  renderToStaticMarkup(React.createElement(Harness));
  assert.deepEqual(selection!.models, []);
  assert.equal(selection!.canRunOcr("VISION", false), false);
  assert.equal(selection!.selectedModelId, "user-vision");
});

test("full live OCR catalog has no limit, excludes free models and honors visibility without saved additions", () => {
  const { resolveOcrModels } = loadOcrConfig();
  const response = { source: "live", models: [...Array.from({ length: 23 }, (_, index) => ({ ...live.models[0]!, id: `vision-${index}` })), ...["test", "big-pickle", "vision-free"].map((id) => ({ ...live.models[0]!, id }))] } as OpencodeTopModelsResponse;
  const all = resolveOcrModels(config, undefined, response, "vision-22");
  assert.equal(all.models.length, 23);
  assert.equal(all.selectedModelId, "vision-22");
  const filtered = resolveOcrModels(config, settings, response, "vision-22");
  assert.deepEqual(filtered.models.map((model) => model.id), ["vision-22"]);
  assert.equal(resolveOcrModels().models.length, 0);
});

test("one OCR normalizer handles every engine, optional trimmed prompts and LOCAL suppression", () => {
  const { defaultOcrMode, normalizeOcrOptions, usesOcrModel } = loadOcrConfig();
  assert.equal(defaultOcrMode, "TEXTRACT");
  for (const mode of ["VISION", "TEXTRACT", "LOCAL"] as const) for (const advanced of [false, true]) {
    const usesModel = mode === "VISION" || mode === "TEXTRACT" && advanced;
    assert.equal(usesOcrModel(mode, advanced), usesModel);
    assert.deepEqual(normalizeOcrOptions(mode, advanced, "explicit-model", "  custom prompt \n "), {
      ocrMode: mode, advancedLayout: advanced && mode !== "LOCAL",
      ...(usesModel ? { ocrModel: "explicit-model", promptOverride: "custom prompt" } : {})
    });
    assert.ok(!("promptOverride" in normalizeOcrOptions(mode, advanced, "explicit-model", "  \n ")));
  }
});

test("live metadata can preserve static privacy notes but empty live responses remove all options", () => {
  const { resolveOcrModels } = loadOcrConfig();
  const curated = { ...config, models: [{ ...config.models[0]!, privacyNotice: "Curated privacy notice" }] };
  const refreshed = { source: "live", models: [{ ...live.models[0]!, id: config.ocrModel }] } as OpencodeTopModelsResponse;
  const selection = resolveOcrModels(curated, undefined, refreshed);
  assert.equal(selection.selectedModel.pricing, "Paid");
  assert.equal(selection.selectedModel.privacyNotice, "Curated privacy notice");
  assert.deepEqual(resolveOcrModels(curated, settings, { source: "live", models: [], warning: "Unavailable" }).models, []);
});
