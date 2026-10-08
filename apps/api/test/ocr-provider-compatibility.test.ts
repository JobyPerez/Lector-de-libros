import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TextractClient } from "@aws-sdk/client-textract";
import sharp from "sharp";
import { load } from "cheerio";
import { runOcrOnImage } from "../src/modules/books/image-ocr.js";
import { extractResponsesApiText } from "../src/config/opencode.js";
import { pageStyleSchema } from "../src/modules/books/page-style.js";

const image = () => sharp({ create: { width: 240, height: 320, channels: 3, background: "white" } }).png().toBuffer();
const options = { opencodeApiKey: "test-secret", ocrMode: "VISION" as const };
const advanced = { ...options, ocrMode: "TEXTRACT" as const, advancedLayout: true,
  awsCredentials: { accessKeyId: "aws-test", secretAccessKey: "aws-secret", region: "eu-west-1" } };
function base(t: TestContext) {
  return t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text." }] }));
}
function delays(t: TestContext) {
  const values: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    values.push(ms); queueMicrotask(callback); return {} as ReturnType<typeof setTimeout>;
  });
  return values;
}

for (const model of ["muse-spark-1.3", "grok-4.7", "gpt-5", "claude-haiku-5-5"]) {
  test(`${model} avoids fields that the mocked provider rejects with HTTP 400`, async (t) => {
    const messages = model.startsWith("claude");
    const calls = t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      assert.equal(url, `https://opencode.ai/zen/v1/${messages ? "messages" : "responses"}`);
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, model);
      if (messages ? Object.hasOwn(body, "temperature") : Object.hasOwn(body, "reasoning") || Object.hasOwn(body, "text")) {
        return Response.json({ error: { type: "invalid_request_error", message: "Unsupported optional parameter" } }, { status: 400 });
      }
      const prompt = messages ? body.messages[0].content[0].text : body.input[0].content[0].text;
      assert.match(prompt, /\bJSON\b/iu);
      assert.ok(messages ? body.system : body.instructions);
      assert.equal(messages ? body.max_tokens : body.max_output_tokens, 8192);
      assert.equal(Object.hasOwn(body, messages ? "max_output_tokens" : "max_tokens"), false);
      assert.equal(messages ? body.messages[0].content[1].source.type : body.input[0].content[1].type, messages ? "base64" : "input_image");
      const text = JSON.stringify({ blocks: [{ type: "paragraph", text: "Visible **content**.", style: { color: "#123456" } }] });
      return Response.json(messages ? { content: [{ type: "text", text }], stop_reason: "end_turn" } : { output_text: text });
    });
    const page = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, model });
    assert.deepEqual(page.paragraphs, ["Visible content."]);
    assert.equal(load(page.htmlContent!)("strong").text(), "content");
    assert.match(page.htmlContent!, /#123456/u);
    assert.equal(calls.mock.callCount(), 1);
  });
}

const failures = [
  { error: { type: "invalid_request_error", message: "temperature: only 1 is allowed test-secret", param: "temperature" }, reason: "unsupported_temperature", param: "temperature", code: "invalid_request_error" },
  { error: { code: "unsupported_parameter", type: "invalid_request_error", message: "reasoning.effort none is not supported test-secret", param: "reasoning.effort" }, reason: "unsupported_reasoning", param: "reasoning.effort", code: "unsupported_parameter" },
  { error: { type: "invalid_request_error", message: "text.format json_object is not supported model-secret", param: "text.format" }, reason: "unsupported_json_format", param: "text.format", code: "invalid_request_error" },
  { error: { code: 400, status: "INVALID_ARGUMENT", message: "maxOutputTokens exceeds maximum test-secret" }, reason: "invalid_token_limit", param: "maxOutputTokens", code: "INVALID_ARGUMENT" },
  { error: { type: "invalid_request_error", message: "Invalid image format test-secret", param: "image" }, reason: "unsupported_image", param: "image", code: "invalid_request_error" },
  { error: { code: "test-secret", type: "invalid_request_error", message: "private model-secret", param: "test-secret" }, reason: undefined, param: undefined, code: "invalid_request_error" },
  { error: { code: 400, status: "INVALID_ARGUMENT" }, reason: undefined, param: undefined, code: "INVALID_ARGUMENT" },
  { error: { type: "invalid_request_error", message: "temperature mentioned in private text; unrelated unsupported model-secret" }, reason: undefined, param: undefined, code: "invalid_request_error" }
];
for (const failure of failures) {
  test(`safe provider diagnosis: ${failure.reason ?? "unknown"}, no parameter retry on 400`, async (t) => {
    const aws = base(t);
    const waits = delays(t);
    const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ error: failure.error }, { status: 400 }));
    for (const advancedLayout of [false, true]) {
      await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", {
        ...(advancedLayout ? advanced : options), model: "muse-spark-1.3"
      }), (error: any) => {
        const diagnostic = advancedLayout ? error.advancedDiagnostics.attempts[0] : error;
        assert.equal(diagnostic.providerCode, failure.code);
        assert.equal(diagnostic.providerReason, failure.reason);
        assert.equal(diagnostic.providerParam, failure.param);
        assert.equal(diagnostic.providerStatus, 400);
        if (failure.reason) assert.ok(error.message.includes(failure.reason));
        assert.doesNotMatch(JSON.stringify(error) + error.message, /test-secret|model-secret|private/u);
        return true;
      });
    }
    assert.equal(calls.mock.callCount(), 2);
    assert.equal(aws.mock.callCount(), 1);
    assert.deepEqual(waits, []);
  });
}

for (const [received, text] of [["undefined", undefined], ["null", null], ["object", { secret: "model-secret" }], ["array", ["model-secret"]], ["number", 42]] as const) {
  test(`Gemini advanced ${received} text gets an exact safe repair hint and preserves corrected content/styles`, async (t) => {
    const aws = base(t);
    const waits = delays(t);
    const hint = `schema: layout.children.#1.text: invalid_type expected string, received ${received}; text must be a nonempty string, never object/array/null or missing.`;
    let attempt = 0;
    const calls = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      attempt++;
      const body = JSON.parse(init?.body as string);
      const prompt = body.contents[0].parts[0].text;
      assert.ok(prompt.includes('{"type":"heading","text":"A **bold** title","level":2}'));
      assert.ok(prompt.includes('{"type":"paragraph","text":"One running paragraph with *italic* markdown."}'));
      if (attempt > 1) {
        assert.ok(prompt.includes(`Previous attempt was rejected (${hint}). Return corrected JSON for the same image and hints.`));
        assert.doesNotMatch(prompt, /model-secret|test-secret/u);
      }
      const layout = { type: "column", children: attempt === 1
        ? [{ type: "paragraph", text }]
        : [{ type: "heading", text: "Title", level: 2, style: { color: "#123456" } },
          { type: "paragraph", text: "Corrected **bold** and *italic* content.", style: { backgroundColor: "#F4F1E8", padding: 8 } }] };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ layout }) }] } }] });
    });
    const page = await runOcrOnImage(await image(), "page.png", "image/png", { ...advanced, model: "gemini-3-flash" });
    assert.equal(calls.mock.callCount(), 2);
    assert.equal(aws.mock.callCount(), 1);
    assert.deepEqual(waits, [5000]);
    assert.deepEqual(page.paragraphs, ["Title", "Corrected bold and italic content."]);
    const $ = load(page.htmlContent!);
    assert.equal($("strong").text(), "bold");
    assert.equal($("em").text(), "italic");
    assert.match(page.htmlContent!, /#123456/u);
    assert.equal($("p").attr("style"), "background-color:#f4f1e8;padding:8px;");
  });
}

test("Gemini repeated invalid text remains strict and terminates at three safe diagnostics", async (t) => {
  base(t); delays(t);
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ finishReason: "STOP", content: {
    parts: [{ text: JSON.stringify({ layout: { type: "paragraph", text: { secret: "model-secret" } } }) }]
  } }] }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...advanced, model: "gemini-3-flash" }), (error: any) => {
    assert.equal(error.code, "OCR_ADVANCED_FAILED");
    assert.equal(error.advancedDiagnostics.attempts.length, 3);
    for (const attempt of error.advancedDiagnostics.attempts) assert.equal(attempt.detail,
      "schema: layout.text: invalid_type expected string, received object; text must be a nonempty string, never object/array/null or missing.");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /model-secret|test-secret/u);
    return true;
  });
  assert.equal(calls.mock.callCount(), 3);
});

test("Gemini rate limit, truncation and invalid text share three requests without repeating base OCR", async (t) => {
  const aws = base(t);
  const waits = delays(t);
  const budgets: number[] = [];
  const calls = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    budgets.push(JSON.parse(init?.body as string).generationConfig.maxOutputTokens);
    if (budgets.length === 1) return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "test-secret" } },
      { status: 429, headers: { "retry-after": "7" } });
    return Response.json({ candidates: [{ finishReason: budgets.length === 2 ? "MAX_TOKENS" : "STOP", content: {
      parts: [{ text: budgets.length === 2 ? '{"layout":' : JSON.stringify({ layout: { type: "paragraph", text: null } }) }]
    } }] });
  });
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...advanced, model: "gemini-3-flash" }), (error: any) => {
    assert.equal(error.code, "OCR_ADVANCED_FAILED");
    assert.deepEqual(error.advancedDiagnostics.attempts.map((attempt: any) => attempt.category), ["provider_error", "truncation", "schema"]);
    assert.equal(error.advancedDiagnostics.attempts[0].providerCode, "RESOURCE_EXHAUSTED");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /test-secret/u);
    return true;
  });
  assert.equal(calls.mock.callCount(), 3);
  assert.equal(aws.mock.callCount(), 1);
  assert.deepEqual(budgets, [8192, 8192, 16384]);
  assert.deepEqual(waits, [7000]);
});

test("Responses final text excludes reasoning, analysis, tools and refusal braces while retaining untyped fixtures", () => {
  const final = '{"layout":{"type":"paragraph","text":"Final {quoted} text"}}';
  assert.equal(extractResponsesApiText({ output: [
    { type: "reasoning", content: [{ type: "output_text", text: '{"analysis":"private reasoning"}' }] },
    { type: "function_call", content: [{ text: "{private tool}" }] },
    { type: "message", content: [{ type: "reasoning_text", text: "{private analysis}" },
      { type: "analysis", text: "{private analysis}" }, { type: "refusal", text: "{private refusal}" }, { type: "output_text", text: final }] }
  ] }), final);
  assert.equal(extractResponsesApiText({ output: [{ content: [{ text: "legacy" }] }] }), "legacy");
  assert.equal(extractResponsesApiText({ output: [{ content: [{ type: "output_text", text: "legacy message" }] },
    { type: "message", content: [{ text: "legacy block" }] }] }), "legacy message\nlegacy block");
  assert.equal(extractResponsesApiText({ output: [{ type: "reasoning", content: [{ text: "{private}" }] }] }), "");
});

for (const indexed of [false, true]) {
  test(`advanced ${indexed ? "indexed" : "inline"} ignores only unsupported style keys, preserving nested frames, text and references`, async (t) => {
    const buffer = await image();
    const aws = t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [
      { Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base text.", Geometry: { BoundingBox: { Left: .1, Top: .2, Width: .6, Height: .1 } } },
      { Id: "figure", BlockType: "LAYOUT_FIGURE", Geometry: { BoundingBox: { Left: .5, Top: .5, Width: .3, Height: .3 } } }
    ] }));
    const waits = delays(t);
    const allowed = { color: "#123abc", backgroundColor: "#fffefd", borderColor: "#abcdef", borderWidth: 2,
      padding: 12, fontScale: 1.5, fontFamily: "serif", alignment: "center" };
    const decoration = { fontSize: "999px", borderRadius: "50%", position: "fixed", backgroundImage: 'url(javascript:alert("style-secret"))',
      cssText: '"><script>style-secret</script>', onload: "style-secret", constructor: { text: "style-secret" } };
    const style = { ...allowed, ...decoration };
    assert.equal(pageStyleSchema.safeParse(style).success, false); // Canonical policy stays strict.
    const blocks = [
      { type: "heading", text: "Title **unchanged**", level: 2, bbox: { x: 100, y: 50, width: 600, height: 100 }, style },
      { type: "paragraph", text: "Base *text*.", sourceTextIndex: 1, bbox: { x: 900, y: 900, width: 50, height: 50 }, style },
      { type: "image", sourceImageIndex: 1, altText: "Original illustration", style }
    ];
    const payload = { ...(indexed ? { blocks } : {}), layout: { type: "column", style, children: [
      { type: "column", style, children: indexed ? blocks.map((_, index) => ({ type: "block", blockIndex: index + 1 })) : blocks }
    ] } };
    const snapshot = structuredClone(payload);
    const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ finishReason: "STOP", content: {
      parts: [{ text: JSON.stringify(payload) }]
    } }] }));
    const page = await runOcrOnImage(buffer, "page.png", "image/png", { ...advanced, model: "gemini-3-flash" });
    assert.equal(calls.mock.callCount(), 1);
    assert.equal(aws.mock.callCount(), 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(payload, snapshot);
    const doc = page.visualDocument!;
    assert.deepEqual(doc.layout.style, allowed);
    assert.deepEqual((doc.layout as any).children[0].style, allowed);
    assert.deepEqual(doc.blocks.map((block) => block.style), blocks.map(() => allowed));
    assert.deepEqual(doc.blocks.slice(0, 2).map((block) => block.text), ["Title **unchanged**", "Base *text*."]);
    assert.deepEqual(doc.blocks[0]!.geometry?.bbox, { left: .1, top: .05, width: .6, height: .1 });
    assert.deepEqual(doc.blocks[1]!.geometry?.bbox, { left: .1, top: .2, width: .6, height: .1 });
    assert.equal(doc.blocks[2]!.altText, "Original illustration");
    assert.deepEqual(doc.blocks[2]!.geometry?.bbox, { left: .5, top: .5, width: .3, height: .3 });
    const crop = await sharp(buffer).extract({ left: 120, top: 160, width: 72, height: 96 }).png().toBuffer();
    assert.equal(doc.blocks[2]!.source, `data:image/png;base64,${crop.toString("base64")}`);
    assert.match(page.htmlContent!, /border-color:#abcdef;border-width:2px;border-style:solid/u);
    assert.match(page.htmlContent!, /background-color:#fffefd/u);
    assert.doesNotMatch(JSON.stringify(doc) + page.htmlContent!, /style-secret|<script|javascript:|999px|position:|borderRadius|backgroundImage/u);
  });
}

test("advanced style filtering rejects known invalid values and structural extras for leaves and containers in both contracts", async (t) => {
  base(t); delays(t);
  let payload: unknown;
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ output_text: JSON.stringify(payload) }));
  const buffer = await image();
  const invalid = [{ color: "red" }, { backgroundColor: "url(javascript:style-secret)" }, { borderColor: "#fff" },
    { borderWidth: "2px" }, { borderWidth: 9 }, { padding: -1 }, { padding: "8px" }, { fontScale: 3.1 },
    { fontFamily: "Arial" }, { alignment: "justify" }];
  for (const indexed of [false, true]) {
    for (const container of [false, true]) {
      for (const extra of [...invalid.map((style) => ({ style: { ...style, fontSize: "999px" } })),
        { style: null }, { style: [] }, { style: "color:red" }, { "structure-secret": true }]) {
        const block = { type: "paragraph", text: "Text remains unchanged.", ...(container ? {} : extra) };
        payload = { ...(indexed ? { blocks: [block] } : {}), layout: { type: "column", ...(container ? extra : {}),
          children: indexed ? [{ type: "block", blockIndex: 1 }] : [block] } };
        const before = calls.mock.callCount();
        await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...advanced, model: "muse-spark-1.3" }), (error: any) => {
          assert.equal(error.code, "OCR_ADVANCED_FAILED");
          assert.ok(error.advancedDiagnostics.attempts.every((attempt: any) => attempt.category === "schema"));
          assert.doesNotMatch(JSON.stringify(error) + error.message, /structure-secret|style-secret|999px/u);
          return true;
        });
        assert.equal(calls.mock.callCount() - before, 3);
      }
    }
  }
});

test("Responses OCR takes final message JSON, balances escaped quoted braces, and ignores trailing explanatory braces", async (t) => {
  const text = 'Literal {braces}, "quotes", \\backslash and newline\nremain intact.';
  const payload = { layout: { type: "paragraph", text } };
  base(t);
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ output: [
    { type: "reasoning", content: [{ type: "output_text", text: '{"analysis":"reasoning-secret"}' }] },
    { type: "message", content: [{ type: "output_text", text: `Result:\n${JSON.stringify(payload)}\nExplanation {ignored-secret} and another }.` }] }
  ] }));
  const page = await runOcrOnImage(await image(), "page.png", "image/png", { ...advanced, model: "muse-spark-1.3" });
  assert.equal(calls.mock.callCount(), 1);
  // The existing Markdown serializer doubles literal backslashes, not JSON parsing.
  assert.equal(page.visualDocument!.blocks[0]!.text, text.replaceAll("\\", "\\\\"));
  assert.equal(load(page.htmlContent!)("p").text(), text.replaceAll("\n", ""));
  assert.doesNotMatch(JSON.stringify(page), /reasoning-secret|ignored-secret/u);
});

test("incomplete JSON is not fabricated; invalid JSON gets a compact escaping hint without new budget changes", async (t) => {
  base(t);
  const waits = delays(t);
  const prompts: string[] = [];
  const budgets: number[] = [];
  const calls = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    prompts.push(body.input[0].content[0].text);
    budgets.push(body.max_output_tokens);
    return Response.json({ output_text: '{"layout":{"type":"paragraph","text":"json-secret"}' });
  });
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...advanced, model: "muse-spark-1.3" }), (error: any) => {
    assert.equal(error.code, "OCR_ADVANCED_FAILED");
    for (const attempt of error.advancedDiagnostics.attempts) assert.equal(attempt.detail,
      "invalid_json: Return compact valid JSON only, with no explanation or markdown fences; escape newlines and quotation marks inside strings.");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /json-secret/u);
    return true;
  });
  assert.equal(calls.mock.callCount(), 3);
  assert.deepEqual(budgets, [8192, 8192, 8192]);
  assert.deepEqual(waits, [5000, 5000]);
  assert.ok(prompts[1]!.includes("Previous attempt was rejected (invalid_json: Return compact valid JSON only, with no explanation or markdown fences; escape newlines and quotation marks inside strings.)"));
  assert.doesNotMatch(prompts.slice(1).join(""), /json-secret/u);
});
