import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import ts from "typescript";
import { z } from "zod";
import { normalizeZenModels } from "../src/modules/ai-settings/ai-settings.routes.js";

const vision = { modalities: { input: ["text", "image"], output: ["text"] } };
const metadata = (models: Record<string, unknown>) => ({ opencode: { models } });

test("exact OpenCode metadata intersection includes all >10 live models, not saved, aliases or other providers", () => {
  const ids = Array.from({ length: 18 }, (_, i) => `image-${i}`);
  const models = Object.fromEntries(ids.map((id) => [id, vision]));
  const payload = [...ids.map((id) => ({ id })), { id: ids[0] }, { id: "text" }, { id: "other-provider" },
    { id: "alias" }, { id: "unknown-flash" }, { id: "gpt-unknown" }, { id: "inline-false", supportsVision: false },
    { id: "inline-text", modalities: { input: ["text"], output: ["text"] } },
    { id: "image-no-text" }, { id: "inline-true", supports_vision: true }];
  const data = { ...metadata({ ...models, "saved-only": vision, "gpt-5.4-mini": vision,
    "inline-false": vision, "inline-text": vision, text: { modalities: { input: ["text"], output: ["text"] } },
    "image-no-text": { modalities: { input: ["image"], output: ["image"] } },
    "canonical-name": { ...vision, aliases: ["alias"] } }), other: { models: { "other-provider": vision } } };
  const result = normalizeZenModels(payload, "ocr", data);
  assert.equal(result.length, 19);
  assert.deepEqual(new Set(result.map((m) => m.id)), new Set([...ids, "inline-true"]));
  assert.ok(result.every((m) => m.supportsVision));
  assert.equal(normalizeZenModels(payload, "summary", data).length, 5);
  assert.deepEqual(normalizeZenModels([{ id: "gpt-5.4-mini" }], "ocr"), []);
  assert.deepEqual(normalizeZenModels(null, "ocr", data), []);
  assert.deepEqual(normalizeZenModels([null, "image-0", {}, { id: "image-0" }], "ocr", data).map((m) => m.id), ["image-0"]);
});

// Execute the real registered route with stubbed credentials, without touching the database.
const sourceText = readFileSync(new URL("../src/modules/ai-settings/ai-settings.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("routes.ts", sourceText, ts.ScriptTarget.Latest, true);
const functions = ["zenModelEntries"].map((name) => {
  const node = source.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node);
  return node.getText(source);
}).join("\n");
const start = sourceText.indexOf('  app.get("/ai-settings/opencode-models",');
const end = sourceText.indexOf("\n  });", start) + "\n  });".length;
const metadataSource = readFileSync(new URL("../src/config/opencode-model-metadata.ts", import.meta.url), "utf8").replace(/^export /gmu, "");

async function catalogue(fetcher: typeof fetch, keys: Record<string, string | undefined> = { a: "key-a", b: "key-b" }) {
  const app = Fastify();
  const fetchModelMetadata = new Function("fetch", ts.transpile(`${metadataSource}\nreturn fetchModelMetadata;`,
    { target: ts.ScriptTarget.ES2022 }))(fetcher);
  const deps = { app, fetch: fetcher, createHash, normalizeZenModels, catalogueCacheMs: 300000,
    fetchModelMetadata,
    OPENCODE_ZEN_MODELS_ENDPOINT: "https://opencode.ai/zen/v1/models", OPENCODE_USER_AGENT: "test",
    getOpenCodeRequestHeaders: (key: string) => ({ Authorization: `Bearer ${key}` }),
    getEffectiveUserAiCredentials: async (id: string) => ({ opencodeApiKey: keys[id],
      opencodeOcrVisibleModels: ["saved-only"], opencodeOcrModel: "saved-only" }),
    getSharedOnlyOcrModelId: () => null,
    getSharedOnlySummaryModelId: () => null,
    appEnv: {}, curatedFallback: () => [{ id: "must-not-use" }],
    opencodeModelsQuerySchema: z.object({ purpose: z.enum(["ocr", "summary"]).default("ocr"), refresh: z.string().optional() }),
    authenticateRequest: async (request: any) => { request.currentUser = { userId: request.headers["x-user"] ?? "a" }; } };
  new Function(...Object.keys(deps), ts.transpile(`const modelsCache = new Map();\n${functions}\n${sourceText.slice(start, end)}`,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(deps));
  await app.ready();
  return app;
}

test("route scopes availability to user, credential and purpose; refresh fetches both live and metadata", async (t) => {
  let liveCalls = 0, metadataCalls = 0;
  const keys = { a: "key-a", b: "key-b" };
  const app = await catalogue(async (url, init) => {
    assert.ok(init?.signal);
    if (String(url).includes("models.dev")) {
      metadataCalls++;
      return Response.json(metadata({ "only-a": vision, "only-b": vision, "saved-only": vision }));
    }
    liveCalls++;
    const id = (init?.headers as any).Authorization === "Bearer key-a" ? "only-a" : "only-b";
    return Response.json({ data: [{ id }] });
  }, keys);
  t.after(() => app.close());
  const get = (user = "a", query = "") => app.inject({ url: `/ai-settings/opencode-models${query}`, headers: { "x-user": user } });
  const a = (await get()).json();
  assert.deepEqual(a, { models: [{ id: "only-a", name: "only-a", description: "Modelo multimodal apto para OCR.",
    contextWindowTokens: 0, pricing: "Zen de pago por uso", supportsVision: true }], source: "live", purpose: "ocr", liveModelCount: 1, returnedModelCount: 1 });
  await get();
  assert.equal(liveCalls, 1);
  assert.deepEqual((await get("b")).json().models.map((m: any) => m.id), ["only-b"]);
  assert.equal(liveCalls, 2);
  assert.equal(metadataCalls, 1);
  await get("a", "?purpose=summary");
  assert.equal(liveCalls, 3);
  await get("a", "?refresh=true");
  assert.equal(liveCalls, 4);
  assert.equal(metadataCalls, 2);
  keys.a = "changed-key";
  assert.deepEqual((await get()).json().models.map((m: any) => m.id), ["only-b"]);
  assert.equal(liveCalls, 5);
});

test("metadata HTTP/network/malformed failure retains only inline capabilities and warns, never static fallback", async (t) => {
  for (const failure of ["http", "network", "malformed"]) {
    const app = await catalogue(async (url) => {
      if (String(url).includes("models.dev")) {
        if (failure === "network") throw new Error("network failure");
        return failure === "http" ? new Response("unavailable", { status: 503 }) : Response.json({ other: { models: {} } });
      }
      return Response.json({ data: [{ id: "gpt-5.4-mini" }, { id: "inline", ...vision }, { id: "inline-false", supportsVision: false }] });
    });
    t.after(() => app.close());
    const result = (await app.inject("/ai-settings/opencode-models?refresh=true")).json();
    assert.deepEqual(result.models.map((m: any) => m.id), ["inline"]);
    assert.equal(result.source, "live");
    assert.equal(result.warning, "No se pudieron obtener los metadatos de models.dev; solo se muestran capacidades explicitas de OpenCode.");
  }
});

test("live HTTP/network/empty/malformed failure and missing credentials never add curated or saved OCR IDs", async (t) => {
  for (const failure of ["http", "network", "empty", "malformed", "no-key"]) {
    const app = await catalogue(async (url) => {
      if (String(url).includes("models.dev")) return Response.json(metadata({ "saved-only": vision, "gpt-5.4-mini": vision }));
      if (failure === "network") throw new Error("network failure");
      if (failure === "http") return new Response("secret upstream body", { status: 403 });
      return Response.json(failure === "empty" ? { data: [] } : {});
    }, failure === "no-key" ? {} : undefined);
    t.after(() => app.close());
    const response = await app.inject("/ai-settings/opencode-models");
    const result = response.json();
    assert.deepEqual(result.models, []);
    assert.equal(result.source, "live");
    assert.equal(response.statusCode, failure === "no-key" ? 503 : 200);
    if (failure !== "no-key") assert.ok(result.warning);
    assert.doesNotMatch(JSON.stringify(result), /secret upstream body|saved-only|gpt-5.4-mini/);
  }
});

test("refresh metadata failure does not reuse previously successful metadata", async (t) => {
  let fail = false;
  const app = await catalogue(async (url) => {
    if (String(url).includes("models.dev")) {
      if (fail) throw new Error("offline");
      return Response.json(metadata({ "live-image": vision }));
    }
    return Response.json({ data: [{ id: "live-image" }] });
  });
  t.after(() => app.close());
  assert.equal((await app.inject("/ai-settings/opencode-models")).json().models.length, 1);
  fail = true;
  const response = (await app.inject("/ai-settings/opencode-models?refresh=true")).json();
  assert.deepEqual(response.models, []);
  assert.ok(response.warning);
});
