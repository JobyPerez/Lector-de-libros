import assert from "node:assert/strict";
import test from "node:test";
import { TextractClient } from "@aws-sdk/client-textract";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { resolveModelVisionCapability } from "../src/config/ai-models.js";
import { normalizeZenModels } from "../src/modules/ai-settings/ai-settings.routes.js";
import { runOcrOnImage, type AdvancedOcrAttemptDiagnostic } from "../src/modules/books/image-ocr.js";

const options = { opencodeApiKey: "visual-secret", awsCredentials: { accessKeyId: "aws-test", secretAccessKey: "aws-secret", region: "eu-west-1" } };
const image = () => sharp({ create: { width: 240, height: 320, channels: 3, background: "white" } }).png().toBuffer();

test("live OCR catalogue uses explicit capabilities, never static lists or family/flash heuristics", () => {
  const payload = { data: [
    { id: "deepseek-v4-flash", supports_vision: true },
    { id: "glm-5.3-flash", supportsVision: true },
    { id: "gemini-3.5-flash-lite" }, { id: "gpt-5.4-nano" }, { id: "gpt-5.4-mini" },
    { id: "gemini-3-flash" }, { id: "new-image-model", supports_vision: true },
    { id: "generic-flash", description: "vision image multimodal gemini gpt" },
    { id: "gpt-unverified" }, { id: "gemini-unverified" },
    { id: "false-image", supportsVision: false }, { id: "string-image", supports_vision: "true" },
    { id: "free-image-free", supportsVision: true }
  ] };
  assert.deepEqual(normalizeZenModels(payload, "ocr").map((model) => model.id), [
    "deepseek-v4-flash", "glm-5.3-flash", "new-image-model"
  ]);
  assert.deepEqual(normalizeZenModels(payload, "summary").map((model) => model.id), [
    "deepseek-v4-flash", "glm-5.3-flash", "gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini"
  ]);
  assert.equal(resolveModelVisionCapability("deepseek-v4-flash", true), false);
  assert.equal(resolveModelVisionCapability("gemini-3-flash"), true);
  assert.equal(resolveModelVisionCapability("gpt-5.4-mini", false), false);
  assert.equal(resolveModelVisionCapability("future-model", true), true);
  assert.equal(resolveModelVisionCapability("unknown-flash"), undefined);
  assert.deepEqual(normalizeZenModels([{ id: "gemini-3-flash", supports_vision: false },
    { id: "new-image-model", supportsVision: true }], "ocr").map((model) => model.id), ["new-image-model"]);
});

test("known text-only models are rejected before paid base/vision calls when vision is required", async (t) => {
  const aws = t.mock.method(TextractClient.prototype, "send", async () => { throw new Error("must not call"); });
  const vision = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call"); });
  const local = t.mock.method(Tesseract, "recognize", async () => { throw new Error("must not call"); });
  for (const model of ["deepseek-v4-flash", "glm-5.3-flash"]) {
    for (const ocrMode of ["VISION", "TEXTRACT", "AUTO"] as const) {
      for (const advancedLayout of ocrMode === "VISION" ? [false, true] : [true]) {
        await assert.rejects(runOcrOnImage(Buffer.alloc(0), "page.png", "image/png", { ...options, model, ocrMode, advancedLayout }),
          { code: "OCR_MODEL_NOT_VISION", statusCode: 400, retryable: false,
            message: `El modelo ${model} no admite imagenes. Selecciona un modelo con vision para este OCR.` });
      }
    }
  }
  assert.equal(aws.mock.callCount() + vision.mock.callCount() + local.mock.callCount(), 0);
});

test("OCR ranking returns every compatible model without padding; summary remains top five", () => {
  const models = [{ id: "deepseek-v4-flash" }, { id: "glm-5.3-flash" },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `vision-model-${String(index).padStart(2, "0")}`, supports_vision: true }))];
  const ocr = normalizeZenModels(models, "ocr");
  assert.equal(ocr.length, 12);
  assert.ok(ocr.every((model) => model.supportsVision));
  assert.equal(new Set(ocr.map((model) => model.id)).size, 12);
  assert.equal(normalizeZenModels(models, "summary").length, 5);
  assert.equal(normalizeZenModels(models.slice(0, 4), "ocr").length, 2);
});

test("AUTO with text-only selection still uses Textract and skips invalid vision fallback", async (t) => {
  const aws = t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
  const vision = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call"); });
  const local = t.mock.method(Tesseract, "recognize", async () => ({ data: { text: "Local text." } }));
  const buffer = await image();
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, model: "deepseek-v4-flash", ocrMode: "AUTO" });
  assert.deepEqual(result.paragraphs, ["Base text."]);
  aws.mock.restore();
  t.mock.method(TextractClient.prototype, "send", async () => { throw new Error("Textract unavailable"); });
  const fallback = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, model: "glm-5.3-flash", ocrMode: "AUTO" });
  assert.deepEqual(fallback.paragraphs, ["Local text."]);
  assert.equal(vision.mock.callCount(), 0);
  assert.equal(local.mock.callCount(), 1);
});

test("saved Gemini and nonstatic dynamic models still reach vision providers", async (t) => {
  const vision = t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const text = JSON.stringify({ blocks: [{ type: "paragraph", text: "Visual text." }] });
    return String(url).includes(":generateContent")
      ? Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] })
      : Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
  });
  for (const model of ["gemini-3-flash", "gemini-3.5-flash-lite", "dynamic-image-model"]) {
    const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, model, ocrMode: "VISION" });
    assert.deepEqual(result.paragraphs, ["Visual text."]);
  }
  assert.equal(vision.mock.callCount(), 3);
});

test("terminal provider diagnostics retain safe nonstatic model, code and HTTP status without secrets", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
  let providerCode = "invalid_request_error";
  const vision = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: providerCode,
    message: "PRIVATE-OCR-TEXT visual-secret aws-secret Bearer sk-private-token" } }, { status: 400 }));
  const buffer = await image();
  for (const model of ["gemini-3-flash", "future/image-model.v2", "bad\nPRIVATE-OCR-TEXT", "sk-private-token", "a".repeat(97)]) {
    for (providerCode of ["invalid_request_error", "PRIVATE-OCR-TEXT"]) {
      await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, model, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
        assert.ok(error instanceof Error);
        const terminal = error as Error & { code: string; statusCode: number; advancedDiagnostics: { model: string; attempts: AdvancedOcrAttemptDiagnostic[] } };
        assert.equal(terminal.code, "OCR_ADVANCED_FAILED");
        assert.equal(terminal.statusCode, 400);
        assert.equal(terminal.advancedDiagnostics.model, model.startsWith("bad") || model.startsWith("sk-") || model.length > 96 ? "invalid_model_id" : model);
        const attempt = terminal.advancedDiagnostics.attempts[0]!;
        assert.equal(attempt.category, "provider_error");
        assert.equal(attempt.code, "OCR_PROVIDER_ERROR");
        assert.equal(attempt.statusCode, 400);
        assert.equal(attempt.providerStatus, 400);
        assert.equal(attempt.providerCode, providerCode === "invalid_request_error" ? providerCode : undefined);
        assert.match(error.message, /causa: OCR_PROVIDER_ERROR/u);
        assert.doesNotMatch(error.message + JSON.stringify(error) + error.stack, /UNKNOWN|unknown_model|PRIVATE-OCR-TEXT|visual-secret|aws-secret|Bearer|sk-private-token/u);
        assert.equal(error.cause, undefined);
        assert.ok(error.message.length <= 2000);
        return true;
      });
    }
  }
  assert.equal(vision.mock.callCount(), 10);
});

test("embedded and transient provider errors keep bounded codes/status without raw messages", async (t) => {
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  });
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
  const cases = [
    { status: 200, providerCode: "model_not_found", code: "OCR_PROVIDER_ERROR", attempts: 1, statusCode: 502 },
    { status: 429, providerCode: "rate_limit_exceeded", code: "OCR_RATE_LIMIT", attempts: 3, statusCode: 429 },
    { status: 503, providerCode: "router.unavailable", code: "OCR_PROVIDER_UNAVAILABLE", attempts: 3, statusCode: 503 }
  ];
  for (const item of cases) {
    const vision = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: item.providerCode,
      message: "PRIVATE-OCR-TEXT visual-secret aws-secret" } }, { status: item.status }));
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, model: "gemini-3-flash", ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const terminal = error as Error & { statusCode: number; advancedDiagnostics: { attempts: AdvancedOcrAttemptDiagnostic[] } };
      assert.equal(terminal.statusCode, item.statusCode);
      assert.equal(terminal.advancedDiagnostics.attempts.length, item.attempts);
      for (const attempt of terminal.advancedDiagnostics.attempts) {
        assert.equal(attempt.code, item.code);
        assert.equal(attempt.statusCode, item.statusCode);
        assert.equal(attempt.providerCode, item.providerCode);
        assert.equal(attempt.providerStatus, item.status === 200 ? undefined : item.status);
      }
      assert.doesNotMatch(error.message + JSON.stringify(error) + error.stack, /UNKNOWN|unknown_model|PRIVATE-OCR-TEXT|visual-secret|aws-secret/u);
      return true;
    });
    assert.equal(vision.mock.callCount(), item.attempts);
    vision.mock.restore();
  }
});
