import assert from "node:assert/strict";
import test from "node:test";
import { TextractClient } from "@aws-sdk/client-textract";
import sharp from "sharp";
import { runOcrOnImage } from "../src/modules/books/image-ocr.js";

const image = () => sharp({ create: { width: 240, height: 320, channels: 3, background: "white" } }).png().toBuffer();
const options = { opencodeApiKey: "test-key", ocrMode: "VISION" as const };

test("Claude and documented Qwen use Anthropic messages with system, base64 image, JSON text blocks and headers", async (t) => {
  const text = JSON.stringify({ blocks: [{ type: "paragraph", text: "Visible text." }] });
  const calls = t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "https://opencode.ai/zen/v1/messages");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers.Authorization, undefined);
    const body = JSON.parse(init?.body as string);
    assert.ok(body.system);
    assert.ok(body.max_tokens > 0);
    assert.equal(Object.hasOwn(body, "temperature"), false);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    const [prompt, image] = body.messages[0].content;
    assert.match(prompt.text, /valid JSON/);
    assert.equal(image.type, "image");
    assert.equal(image.source.type, "base64");
    assert.match(image.source.media_type, /^image\//);
    assert.ok(Buffer.from(image.source.data, "base64").length > 0);
    return Response.json({ content: [{ type: "thinking", text: "not JSON" },
      { type: "text", text: text.slice(0, 17) }, { type: "text", text: text.slice(17) }], stop_reason: "end_turn" });
  });
  for (const model of ["claude-sonnet-4-6", "claude-fable-5-1", "qwen3.7-plus"]) {
    const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, model });
    assert.deepEqual(result.paragraphs, ["Visible text."]);
  }
  assert.equal(calls.mock.callCount(), 3);
});

test("arbitrary GPT 6, Grok and Muse remain Responses API, not chat completions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "https://opencode.ai/zen/v1/responses");
    const body = JSON.parse(init?.body as string);
    assert.equal(body.input[0].content[1].type, "input_image");
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ blocks: [{ type: "paragraph", text: "Response text." }] }) }] }] });
  });
  for (const model of ["gpt-6-new-model", "grok-4.7", "muse-spark-1.3"]) {
    assert.deepEqual((await runOcrOnImage(await image(), "page.png", "image/png", { ...options, model })).paragraphs, ["Response text."]);
  }
});

test("Claude max_tokens truncation retries with increased budget in the existing advanced diagnostic flow", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
  const budgets: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "https://opencode.ai/zen/v1/messages");
    budgets.push(JSON.parse(init?.body as string).max_tokens);
    return Response.json({ content: [{ type: "text", text: '{"layout":' }], stop_reason: "max_tokens" });
  });
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", {
    ...options, model: "claude-sonnet-4-6", ocrMode: "TEXTRACT", advancedLayout: true,
    awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" }
  }), (error: any) => {
    assert.equal(error.code, "OCR_ADVANCED_FAILED");
    assert.ok(error.advancedDiagnostics.attempts.length > 1);
    assert.ok(error.advancedDiagnostics.attempts.every((a: any) => a.category === "truncation"));
    return true;
  });
  assert.ok(budgets[1]! > budgets[0]!);
});

test("Anthropic HTTP provider errors retain existing category and safe diagnostics", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ type: "error", error: {
    type: "invalid_request_error", message: "private provider message test-key" } }, { status: 400 }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", {
    ...options, model: "claude-sonnet-4-6", ocrMode: "TEXTRACT", advancedLayout: true,
    awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" }
  }), (error: any) => {
    assert.equal(error.code, "OCR_ADVANCED_FAILED");
    assert.equal(error.advancedDiagnostics.attempts[0].category, "provider_error");
    assert.equal(error.advancedDiagnostics.attempts[0].providerStatus, 400);
    assert.equal(error.advancedDiagnostics.attempts[0].providerCode, "invalid_request_error");
    assert.doesNotMatch(JSON.stringify(error), /private provider message|test-key/);
    return true;
  });
});
