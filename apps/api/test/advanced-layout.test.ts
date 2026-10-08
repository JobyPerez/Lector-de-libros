import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TextractClient, type Block } from "@aws-sdk/client-textract";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { load } from "cheerio";
import { appEnv } from "../src/config/env.js";
import { buildAdvancedVisionPrompt, isRetryableOcrError, runOcrOnImage, type AdvancedOcrAttemptDiagnostic } from "../src/modules/books/image-ocr.js";
import { processSelectionJob, selectionJobResponse } from "../src/modules/books/gallery-ocr-jobs.js";
import { advancedLayoutSchema, createAdvancedLayoutSchema, resolveAdvancedLayoutLimits, validateAdvancedLayout } from "../src/modules/books/advanced-layout.js";
import { visualPageDocumentSchema } from "../src/modules/books/visual-document.js";

const credentials = { accessKeyId: "aws-test", secretAccessKey: "aws-secret", region: "eu-west-1" };
const options = { model: "gpt-5.4-mini", opencodeApiKey: "visual-secret", awsCredentials: credentials };
const leaf = (blockIndex: number) => ({ type: "block" as const, blockIndex });
const column = (...children: unknown[]) => ({ type: "column", children });
const base = { blocks: [{ type: "paragraph", text: "Base OCR hints." }] };
const simple = { blocks: [{ type: "paragraph", text: "Visual text." }], layout: column(leaf(1)) };
const awsBase = { Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: "Base OCR hints." }] };
const image = () => sharp({ create: { width: 240, height: 320, channels: 3, background: "white" } }).png().toBuffer();
const response = (payload: unknown) => Response.json({ output_text: JSON.stringify(payload) });
function mockDelays(t: TestContext): number[] {
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
    delays.push(milliseconds);
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  });
  return delays;
}

test("omitted/false advancedLayout preserves baseline with no extra provider calls", async (t) => {
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const vision = t.mock.method(globalThis, "fetch", async () => response(base));
  const buffer = await image();
  for (const ocrMode of ["TEXTRACT", "VISION"] as const) {
    const beforeAws = aws.mock.callCount();
    const beforeVision = vision.mock.callCount();
    const omitted = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode });
    const disabled = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode, advancedLayout: false });
    assert.deepEqual(omitted, disabled);
    assert.equal(omitted.visualDocument, undefined);
    assert.equal(omitted.paragraphIds, undefined);
    assert.equal(aws.mock.callCount() - beforeAws, ocrMode === "TEXTRACT" ? 2 : 0);
    assert.equal(vision.mock.callCount() - beforeVision, ocrMode === "VISION" ? 2 : 0);
  }
});

test("advanced configuration rejects LOCAL and missing visual key before any OCR calls", async (t) => {
  const previous = appEnv.opencodeGoApiKey;
  appEnv.opencodeGoApiKey = "";
  t.after(() => { appEnv.opencodeGoApiKey = previous; });
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const vision = t.mock.method(globalThis, "fetch", async () => response(simple));
  const local = t.mock.method(Tesseract, "recognize", async () => { throw new Error("must not call"); });
  await assert.rejects(runOcrOnImage(Buffer.alloc(0), "page.png", "image/png", { ...options, ocrMode: "LOCAL", advancedLayout: true }), { statusCode: 400, message: "El layout avanzado requiere OCR con vision y no admite el modo LOCAL." });
  for (const ocrMode of ["TEXTRACT", "VISION", "AUTO"] as const) {
    await assert.rejects(runOcrOnImage(Buffer.alloc(0), "page.png", "image/png", { awsCredentials: credentials, ocrMode, advancedLayout: true }), { code: "MISSING_OPENCODE" });
  }
  assert.equal(aws.mock.callCount() + vision.mock.callCount() + local.mock.callCount(), 0);
});

test("AWS base then visual pass uses selected model, rotated original and text-only hints", async (t) => {
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const buffer = await image();
  const expected = await sharp(buffer).rotate(90).toBuffer();
  const vision = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(aws.mock.callCount(), 1);
    const request = JSON.parse(init.body as string);
    assert.equal(request.model, options.model);
    assert.match(request.instructions, /NESTED|tableCell/u);
    const text = request.input[0].content[0].text;
    assert.match(text, /Base OCR hints\./u);
    assert.doesNotMatch(text, /visual-secret|aws-secret|aws-test|data:/u);
    assert.deepEqual(Buffer.from(request.input[0].content[1].image_url.split(",")[1], "base64"), expected);
    return response(simple);
  });
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", rotation: 90, advancedLayout: true });
  assert.equal(vision.mock.callCount(), 1);
  assert.deepEqual(result.paragraphs, ["Visual text."]);
  assert.deepEqual(result.paragraphIds, result.visualDocument!.blocks.map((block) => block.id));
  visualPageDocumentSchema.parse(result.visualDocument);
});

test("Vision runs two passes and nested zones preserve figure/table relationships and margins", async (t) => {
  const payload = {
    blocks: [
      { type: "paragraph", text: "Running header", role: "header" },
      { type: "heading", text: "History", level: 2 },
      { type: "paragraph", text: "Left content.", style: { color: "#123456" } },
      { type: "image", altText: "Portrait", bbox: { x: 100, y: 200, width: 300, height: 300 } },
      { type: "paragraph", text: "Figure 1. Portrait.", role: "imageCaption" },
      { type: "paragraph", text: "Cell A" }, { type: "paragraph", text: "Cell B" },
      { type: "paragraph", text: "26", role: "pageNumber" }
    ],
    layout: column(leaf(1), leaf(2), { type: "row", weights: [2, 1], children: [
      column(leaf(3), { type: "column", semantic: "table", children: [
        { type: "row", semantic: "tableRow", children: [
          { type: "column", semantic: "tableCell", children: [leaf(6)] },
          { type: "column", semantic: "tableCell", children: [leaf(7)] }
        ] }
      ] }),
      { type: "column", semantic: "figure", style: { padding: 8, backgroundColor: "#abcdef" }, children: [leaf(4), leaf(5)] }
    ] }, leaf(8))
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    assert.equal(request.model, options.model);
    return response(++calls === 1 ? base : payload);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(calls, 2);
  const document = visualPageDocumentSchema.parse(result.visualDocument);
  assert.equal(new Set([...document.blocks.map((block) => block.id), ...result.paragraphIds!]).size, 8);
  assert.deepEqual(result.paragraphs, ["Running header", "History", "Left content.", "Cell A", "Cell B", "Imagen. Portrait", "Figure 1. Portrait.", "26"]);
  const html = load(result.htmlContent!);
  assert.equal(html('[data-layout-semantic="figure"] img').length, 1);
  assert.equal(html('[data-layout-semantic="figure"] [data-element-role="imageCaption"]').text(), "Figure 1. Portrait.");
  assert.deepEqual(html('[data-layout-semantic="tableCell"]').map((_, node) => html(node).text()).get(), ["Cell A", "Cell B"]);
  assert.match(html('[data-layout-semantic="figure"]').attr("style")!, /padding:8px/u);
  assert.equal(result.paragraphMetadata![0]!.readAloud, false);
  assert.equal(result.paragraphMetadata!.at(-1)!.readAloud, false);
  const source = document.blocks.find((block) => block.kind === "image")!.source!;
  const crop = await sharp(Buffer.from(source.split(",")[1]!, "base64")).metadata();
  assert.deepEqual([crop.width, crop.height], [72, 96]);
});

test("invalid, duplicate or missing ordinal references fail advanced phase without AUTO degradation", async (t) => {
  const delays = mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const local = t.mock.method(Tesseract, "recognize", async () => { throw new Error("must not fallback"); });
  let payload: unknown;
  const vision = t.mock.method(globalThis, "fetch", async () => response(payload));
  const buffer = await image();
  for (const layout of [column(leaf(1), leaf(1)), column(leaf(2)), column(), { type: "block", blockIndex: "uuid" }]) {
    payload = { ...simple, layout };
    await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "AUTO", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", retryable: false, statusCode: 502 });
  }
  payload = { blocks: [...simple.blocks, ...simple.blocks], layout: column(leaf(1)) };
  await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "AUTO", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", retryable: false });
  assert.equal(aws.mock.callCount(), 5);
  assert.equal(vision.mock.callCount(), 15);
  assert.deepEqual(delays, Array(10).fill(5000));
  assert.equal(local.mock.callCount(), 0);
});

test("advanced transport errors remain outside AUTO fallback catches", async (t) => {
  const delays = mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => { throw new Error("AWS base unavailable"); });
  const local = t.mock.method(Tesseract, "recognize", async () => { throw new Error("must not fallback"); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? response(base) : new Response("rate limit", { status: 429 }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "AUTO", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", retryable: false, statusCode: 429 });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [15000, 15000]);
  assert.equal(local.mock.callCount(), 0);
});

test("AUTO retains local base fallback, but still performs the required visual phase", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => { throw new Error("AWS unavailable"); });
  const local = t.mock.method(Tesseract, "recognize", async () => ({ data: { text: "Local base hints." } }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (++calls === 1) return new Response("base unavailable", { status: 500 });
    assert.match(JSON.parse(init.body as string).input[0].content[0].text, /Local base hints/u);
    return response(simple);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "AUTO", advancedLayout: true });
  assert.equal(local.mock.callCount(), 1);
  assert.equal(calls, 2);
  assert.deepEqual(result.paragraphs, ["Visual text."]);
});

test("hinted margins and paired footer reordering preserve each provider ordinal", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  t.mock.method(globalThis, "fetch", async () => response({
    blocks: [
      { type: "heading", text: "Author Name", bbox: { x: 420, y: 52, width: 116, height: 17 } },
      { type: "paragraph", text: "Body.", bbox: { x: 100, y: 112, width: 790, height: 750 } },
      { type: "paragraph", text: "26", role: "pageNumber", bbox: { x: 848, y: 936, width: 27, height: 13 } },
      { type: "paragraph", text: "Book Label", role: "footer", bbox: { x: 435, y: 929, width: 86, height: 18 } }
    ], layout: column(leaf(1), leaf(2), { type: "row", children: [leaf(4), leaf(3)] })
  }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true, marginHints: { headers: ["Author Name"] } });
  assert.deepEqual(result.paragraphs, ["Author Name", "Body.", "Book Label", "26"]);
  assert.deepEqual(result.paragraphMetadata!.map((item) => [item.role, item.readAloud]), [["header", false], ["body", true], ["footer", false], ["pageNumber", false]]);
  assert.equal(result.visualDocument!.blocks.find((block) => block.id === result.paragraphIds![3])!.text, "26");
});

test("advanced schema rejects more than 500 blocks without projection", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  t.mock.method(globalThis, "fetch", async () => response({ blocks: Array.from({ length: 501 }, () => simple.blocks[0]), layout: column(leaf(1)) }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", retryable: false });
});

test("omitted image crops and empty rendered text cannot corrupt ordinal identity", async (t) => {
  const delays = mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let block: unknown;
  const vision = t.mock.method(globalThis, "fetch", async () => response({ blocks: [block], layout: column(leaf(1)) }));
  for (block of [
    { type: "image", bbox: { x: 999, y: 999, width: 1, height: 1 } },
    { type: "paragraph", text: ":::block empty" }
  ]) {
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(isRetryableOcrError(error), false);
      assert.equal((error as Error & { code: string }).code, "OCR_ADVANCED_FAILED");
      assert.match(error.message, /segunda fase.*No se repetira.*OCR base/u);
      assert.doesNotMatch(error.message, /empty|data:|visual-secret|aws-secret/u);
      return true;
    });
  }
  assert.equal(aws.mock.callCount(), 2);
  assert.equal(vision.mock.callCount(), 6);
  assert.deepEqual(delays, [5000, 5000, 5000, 5000]);
});

test("schema enforces node/depth budgets, semantic container types and safe styles before traversal", () => {
  for (const layout of [
    { type: "column", children: Array.from({ length: 1000 }, () => leaf(1)) },
    { type: "column", children: [leaf(1)], style: { position: "absolute" } }
  ]) assert.equal(advancedLayoutSchema.safeParse(layout).success, false);
  let deep: unknown = leaf(1);
  for (let index = 0; index < 8; index++) deep = column(deep);
  assert.equal(advancedLayoutSchema.safeParse(deep).success, false);
  const cyclic = { type: "column", children: [] as unknown[] };
  cyclic.children.push(cyclic);
  assert.equal(advancedLayoutSchema.safeParse(cyclic).success, false);
  for (const semantic of ["table", "tableRow", "tableCell", "figure"]) {
    const invalid = advancedLayoutSchema.parse({ type: semantic === "tableRow" ? "column" : "row", semantic, children: [leaf(1)] });
    assert.throws(() => validateAdvancedLayout(invalid, 1), /semantic/u);
  }
});

test("advanced requests share truncation and image optimization retries", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    calls++;
    assert.match(request.instructions, /Second visual pass/u);
    if (calls === 1) return new Response("image_too_large", { status: 400 });
    assert.match(request.input[0].content[1].image_url, /^data:image\/jpeg;/u);
    if (calls === 2) return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"blocks":[' });
    assert.equal(request.max_output_tokens, 16384);
    return response(simple);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(calls, 3);
  assert.deepEqual(result.paragraphs, ["Visual text."]);
});

test("phase 2 retries respect provider delays and retain the AWS base across three attempts", async (t) => {
  const delays = mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(aws.mock.callCount(), 1);
    assert.match(JSON.parse(init.body as string).input[0].content[0].text, /Base OCR hints/u);
    calls++;
    if (calls === 1) return new Response("rate limit visual-secret", { status: 429, headers: { "retry-after": "7" } });
    if (calls === 2) return Response.json({ error: { code: "router.unavailable", message: "aws-secret" } }, { status: 503, headers: { "retry-after": "11" } });
    return response(simple);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(calls, 3);
  assert.equal(aws.mock.callCount(), 1);
  assert.deepEqual(delays, [7000, 11000]);
  assert.deepEqual(result.paragraphs, ["Visual text."]);
});

test("Vision base is not repeated when advanced conversion fails and the next attempt succeeds", async (t) => {
  const delays = mockDelays(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return response(base);
    if (calls === 2) return response({ blocks: [{ type: "paragraph", text: ":::block secret" }], layout: column(leaf(1)) });
    return response(simple);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(result.paragraphs, ["Visual text."]);
});

test("terminal non-retryable advanced failures stop immediately and do not leak provider content", async (t) => {
  const delays = mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const vision = t.mock.method(globalThis, "fetch", async () => new Response("sensitive data:image/png;base64,secret visual-secret aws-secret", { status: 400 }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(isRetryableOcrError(error), false);
    assert.equal((error as Error & { retryable: boolean }).retryable, false);
    assert.equal((error as Error & { code: string }).code, "OCR_ADVANCED_FAILED");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive|secret|data:image/u);
    return true;
  });
  assert.equal(aws.mock.callCount(), 1);
  assert.equal(vision.mock.callCount(), 1);
  assert.deepEqual(delays, []);
});

test("truncation, optimization and transient retries share a total phase 2 budget of three requests", async (t) => {
  const delays = mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return new Response("image_too_large", { status: 400 });
    if (calls === 2) return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"blocks":[' });
    return new Response("rate limit", { status: 429, headers: { "retry-after": "9" } });
  });
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", statusCode: 429, retryable: false });
  assert.equal(calls, 3);
  assert.equal(aws.mock.callCount(), 1);
  assert.deepEqual(delays, []);
});

test("semantic ownership rejects stray rows/cells, mixed table children and nested tables", () => {
  const cell = { type: "column", semantic: "tableCell", children: [leaf(1)] };
  const row = { type: "row", semantic: "tableRow", children: [cell] };
  const table = { type: "column", semantic: "table", children: [row] };
  const layouts = [
    cell, row, column(row), column(cell),
    { ...table, children: [leaf(1)] },
    { ...table, children: [column(row)] },
    { ...table, children: [{ ...row, children: [leaf(1)] }] },
    { ...table, children: [{ ...row, children: [column(cell)] }] },
    { ...table, children: [{ ...row, children: [{ ...cell, children: [table] }] }] },
    { type: "column", semantic: "figure", children: [leaf(1)] }
  ];
  for (const layout of layouts) {
    assert.throws(() => validateAdvancedLayout(advancedLayoutSchema.parse(layout), 1, [{ type: "paragraph" }]), /table|figure/u);
  }
  validateAdvancedLayout(advancedLayoutSchema.parse(table), 1, [{ type: "paragraph" }]);
  validateAdvancedLayout(advancedLayoutSchema.parse({ type: "column", semantic: "figure", children: [column(leaf(1))] }), 1, [{ type: "image" }]);
});

test("invalid semantics from the provider never reach document conversion", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const vision = t.mock.method(globalThis, "fetch", async () => response({ ...simple, layout: { type: "row", semantic: "tableRow", children: [leaf(1)] } }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", statusCode: 502, retryable: false });
  assert.equal(vision.mock.callCount(), 3);
});

test("reserved block/depth limits affect only phase 2 prompt and response validation", async (t) => {
  const delays = mockDelays(t);
  const limits = { maxBlocks: 1, maxDepth: 2 };
  const buffer = await image();
  let calls = 0;
  let payload: unknown = simple;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const prompt = JSON.parse(init.body as string).instructions;
    if (++calls === 1) {
      assert.doesNotMatch(prompt, /Maximum 1 blocks|depth 2/u);
      return response({ blocks: [...base.blocks, ...base.blocks] });
    }
    assert.match(prompt, /Maximum 1 blocks, 1000 nodes, depth 2/u);
    return response(payload);
  });
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true, advancedLayoutLimits: limits });
  assert.deepEqual(result.paragraphs, ["Visual text."]);
  assert.equal(calls, 2);
  for (payload of [
    { blocks: [...simple.blocks, ...simple.blocks], layout: column(leaf(1), leaf(2)) },
    { ...simple, layout: column(column(leaf(1))) }
  ]) {
    calls = 0;
    await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true, advancedLayoutLimits: limits }), { code: "OCR_ADVANCED_FAILED", statusCode: 502, retryable: false });
    assert.equal(calls, 4);
  }
  assert.deepEqual(delays, [5000, 5000, 5000, 5000]);
  assert.equal(createAdvancedLayoutSchema(limits).safeParse(column(column(leaf(1)))).success, false);
  assert.equal(advancedLayoutSchema.safeParse(column(column(leaf(1)))).success, true);
});

test("invalid or exhausted reserved budgets reject before base OCR and are ignored when disabled", async (t) => {
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const vision = t.mock.method(globalThis, "fetch", async () => response(simple));
  for (const limits of [
    { maxBlocks: 0, maxDepth: 7 }, { maxBlocks: 501, maxDepth: 7 },
    { maxBlocks: 1, maxDepth: 9 }, { maxBlocks: 1, maxDepth: 0 }, { maxBlocks: 1.5, maxDepth: 2 }
  ]) {
    await assert.rejects(runOcrOnImage(Buffer.alloc(0), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true, advancedLayoutLimits: limits }), { statusCode: 400 });
  }
  assert.equal(aws.mock.callCount() + vision.mock.callCount(), 0);
  assert.deepEqual(resolveAdvancedLayoutLimits(), { maxBlocks: 500, maxDepth: 8 });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayoutLimits: { maxBlocks: 0, maxDepth: 0 } });
  assert.deepEqual(result.paragraphs, ["Base OCR hints."]);
  assert.equal(aws.mock.callCount(), 1);
});

test("advanced visual pass omits margin-row mechanics while base OCR keeps them", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const hints = { headers: ["Cabecera repetida"] };
  const instructions: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    instructions.push(body.instructions ?? body.contents?.[0]?.parts?.[0]?.text ?? body.messages?.[0]?.content);
    return response(instructions.length === 1 ? base : simple);
  });
  // Base Vision OCR keeps margin mechanics.
  await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", marginHints: hints });
  assert.match(instructions[0]!, /mismo readingRowId/u);
  assert.match(instructions[0]!, /Known repeated margin hints/u);
  // Advanced second pass drops them in favor of the nested-tree contract.
  await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true, marginHints: hints });
  assert.match(instructions[1]!, /Second visual pass/u);
  assert.match(instructions[1]!, /exactly the key \{layout\}/u);
  assert.doesNotMatch(instructions[1]!, /Known repeated margin hints|mismo readingRowId|readingBlockId distintos|readingRowId opcional|claves rawText, párrafos|claves rawText, paragraphs/u);
});

test("dedicated advanced prompt demands inline layout without base keys or row mechanics", () => {
  for (const language of ["es", "it"] as const) {
    const system = buildAdvancedVisionPrompt(language, { maxBlocks: 486, maxDepth: 7 });
    assert.match(system, /Second visual pass/u);
    assert.match(system, /exactly the key \{layout\}/u);
    assert.match(system, /Maximum 486 blocks, 1000 nodes, depth 7/u);
    assert.doesNotMatch(system, /rawText|paragraphs|mismo readingRowId|readingRowId opcional|readingBlockId distintos|Known repeated margin/u);
  }
});

test("terminal advanced failure reports the underlying cause and attempt count", async (t) => {
  const delays = mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  t.mock.method(globalThis, "fetch", async () => response({ blocks: [], rawText: "" }));
  await assert.rejects(
    runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }),
    { code: "OCR_ADVANCED_FAILED", statusCode: 502, retryable: false, message: /tras 3 intentos \(causa: OCR_INVALID_RESPONSE\)/u }
  );
  assert.deepEqual(delays, [5000, 5000]);
});

test("pageNumber-shaped blocks coerce to pageNumber paragraphs without narration", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  t.mock.method(globalThis, "fetch", async () => response({
    blocks: [{ type: "pageNumber", text: "48" }, { type: "paragraph", text: "Body." }],
    layout: column(leaf(1), leaf(2))
  }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.deepEqual(result.paragraphs, ["48", "Body."]);
  assert.deepEqual(result.paragraphMetadata![0], { role: "pageNumber", readAloud: false, active: true, includeInToc: false, imageWidth: null, geometry: null });
});

test("validation failures retry with guided repair feedback and never leak model text", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const bodies: string[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body);
    // First attempt omits the only leaf from the layout; second attempt is valid.
    return response(++calls === 1
      ? { blocks: [{ type: "paragraph", text: "LEAKED-MODEL-TEXT" }], layout: column() }
      : simple);
  });
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.deepEqual(result.paragraphs, ["Visual text."]);
  assert.equal(calls, 2);
  assert.match(bodies[1]!, /Previous attempt was rejected \(schema: layout\.children: too_small; root: custom Every blockIndex must appear exactly once\.\)/u);
  assert.doesNotMatch(bodies[1]!, /LEAKED-MODEL-TEXT/u);
});

test("terminal diagnostics retain recursive truncation, repair validation and gallery page.error", async (t) => {
  mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const budgets: number[] = [];
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    budgets.push(body.max_output_tokens);
    prompts.push(body.input[0].content[0].text);
    if (budgets.length === 1) return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"layout": "PRIVATE-OCR-TEXT' });
    if (budgets.length === 2) return Response.json({ output_text: "PRIVATE-OCR-TEXT visual-secret aws-secret" });
    return response({ layout: column({ type: "paragraph", text: "PRIVATE-OCR-TEXT", sourceTextIndex: 999 }) });
  });
  const buffer = await image();
  let terminal: Error & { advancedDiagnostics: { model: string; attempts: AdvancedOcrAttemptDiagnostic[] } };
  await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    terminal = error as typeof terminal;
    assert.equal((error as Error & { code: string }).code, "OCR_ADVANCED_FAILED");
    assert.equal(terminal.advancedDiagnostics.model, options.model);
    assert.deepEqual(terminal.advancedDiagnostics.attempts.map((item) => item.category), ["truncation", "invalid_json", "schema"]);
    assert.deepEqual(terminal.advancedDiagnostics.attempts.map((item) => item.attempt), [1, 2, 3]);
    assert.deepEqual(terminal.advancedDiagnostics.attempts.map((item) => item.maxTokens), [8192, 16384, 16384]);
    assert.match(error.message, /blocks\.#1\.sourceTextIndex: custom Unknown sourceTextIndex\./u);
    assert.match(error.message, /#1 tokens=8192 truncation.*#2 tokens=16384 invalid_json.*#3 tokens=16384 schema/u);
    assert.ok(error.message.length <= 2000);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message + JSON.stringify(error) + error.stack, /PRIVATE-OCR-TEXT|visual-secret|aws-secret|data:/u);
    return true;
  });
  assert.equal(aws.mock.callCount(), 1);
  assert.deepEqual(budgets, [8192, 16384, 16384]);
  assert.match(prompts[1]!, /Previous attempt was rejected \(truncation: incomplete JSON\)/u);
  assert.ok(prompts[2]!.includes("Previous attempt was rejected (invalid_json: Return compact valid JSON only, with no explanation or markdown fences; escape newlines and quotation marks inside strings.)"));
  assert.doesNotMatch(prompts.slice(1).join(""), /PRIVATE-OCR-TEXT|visual-secret|aws-secret/u);

  // Exercise the real worker persistence path with an in-memory connection, no database.
  const job = { jobId: "job", bookId: "book", status: "RUNNING", attemptCount: 1, lastError: null,
    payloadJson: JSON.stringify({ kind: "GALLERY_OCR_SELECTION", userId: "user", options: {},
      pages: [{ pageId: "page22", expectedUpdatedAt: "v1", status: "PENDING" }] }) };
  const connection = { execute: async (sql: string, binds: any) => {
    if (sql.startsWith("SELECT")) return { rows: [job] };
    if (binds.payload) job.payloadJson = binds.payload.val;
    return { rowsAffected: 1 };
  } };
  await processSelectionJob(connection as any, job, async () => { throw terminal; });
  assert.equal(selectionJobResponse(job).pages[0]!.error, terminal!.message);
  assert.match(selectionJobResponse(job).pages[0]!.error!, /Unknown sourceTextIndex\./u);
});

test("advanced diagnostics distinguish empty JSON, schema keys and safe conversion without response text", async (t) => {
  mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const cases = [
    { category: "empty_response", payload: () => Response.json({ output_text: "  " }), detail: /empty_response/u },
    { category: "empty_response", payload: () => Response.json({ output_text: "```json\n \n```" }), detail: /empty_response/u },
    { category: "invalid_json", payload: () => Response.json({ output_text: "PRIVATE-OCR-TEXT visual-secret" }), detail: /invalid_json/u },
    { category: "schema", payload: () => response({ layout: column({ type: "paragraph", text: "PRIVATE-OCR-TEXT", "PRIVATE-KEY-aws-secret": true }) }), detail: /layout\.children\.#1: unrecognized_keys/u },
    { category: "schema", payload: () => response({ layout: column({ type: "PRIVATE-OCR-TEXT", text: "PRIVATE-OCR-TEXT" }) }), detail: /invalid_union_discriminator expected heading\|paragraph\|image/u },
    { category: "conversion", payload: () => response({ layout: column({ type: "paragraph", text: ":::block PRIVATE-OCR-TEXT" }) }), detail: /Advanced OCR omitted a crop or text block\./u },
    { category: "conversion", payload: () => response({ layout: { type: "row", children: [
      { type: "paragraph", text: "PRIVATE-OCR-TEXT", bbox: { x: 100, y: 100, width: 500, height: 100 } },
      { type: "paragraph", text: "PRIVATE-OCR-TEXT", bbox: { x: 400, y: 100, width: 500, height: 100 } }
    ] } }), detail: /Invalid advanced row geometry: children overlap horizontally/u }
  ];
  const buffer = await image();
  for (const item of cases) {
    const prompts: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      prompts.push(JSON.parse(String(init.body)).input[0].content[0].text);
      return item.payload();
    });
    const beforeAws = aws.mock.callCount();
    await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const diagnostics = (error as Error & { advancedDiagnostics: { attempts: AdvancedOcrAttemptDiagnostic[] } }).advancedDiagnostics;
      assert.deepEqual(diagnostics.attempts.map((attempt) => attempt.category), Array(3).fill(item.category));
      assert.match(error.message, item.detail);
      assert.ok(error.message.length <= 2000);
      assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /PRIVATE-OCR-TEXT|PRIVATE-KEY|visual-secret|aws-secret|data:/u);
      return true;
    });
    assert.equal(aws.mock.callCount() - beforeAws, 1);
    assert.equal(fetchMock.mock.callCount(), 3);
    assert.match(prompts[2]!, item.detail);
    assert.doesNotMatch(prompts.slice(1).join(""), /PRIVATE-OCR-TEXT|PRIVATE-KEY|visual-secret|aws-secret/u);
    fetchMock.mock.restore();
  }
});

test("truncation token ceiling survives optimized-image retries and exhaustion", async (t) => {
  mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  const budgets: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    budgets.push(body.max_output_tokens);
    if (budgets.length === 2) return new Response("image_too_large PRIVATE-OCR-TEXT", { status: 400 });
    return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "PRIVATE-OCR-TEXT" });
  });
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const diagnostics = (error as Error & { advancedDiagnostics: { attempts: AdvancedOcrAttemptDiagnostic[] } }).advancedDiagnostics;
    assert.deepEqual(diagnostics.attempts.map((attempt) => attempt.category), ["truncation", "provider_error", "truncation"]);
    assert.deepEqual(diagnostics.attempts.map((attempt) => attempt.optimized), [false, false, true]);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE-OCR-TEXT/u);
    return true;
  });
  assert.equal(aws.mock.callCount(), 1);
  assert.deepEqual(budgets, [8192, 16384, 16384]);
});

const catalogueFigureBox = { x: 65, y: 95, width: 417, height: 211 };
const catalogueText = [
  { type: "heading", role: "heading", text: "Prehistory", bbox: { x: 60, y: 35, width: 850, height: 35 } },
  { type: "paragraph", role: "imageCaption", text: "Figure 1. The complete printed caption, including its final sentence.", bbox: { x: 65, y: 315, width: 417, height: 55 } },
  { type: "paragraph", role: "body", text: "Venus figures represent the human body. Preserve this entire description.", bbox: { x: 550, y: 400, width: 380, height: 150 } },
  { type: "paragraph", role: "body", text: "Lower left sidebar: independent archaeological vocabulary and definitions.", bbox: { x: 65, y: 600, width: 300, height: 250 } },
  { type: "paragraph", role: "body", text: "Main body explains the evidence and retains the final paragraph.", bbox: { x: 550, y: 600, width: 380, height: 250 } }
];
const catalogueBase = { blocks: [catalogueText[0], { type: "image", bbox: catalogueFigureBox }, ...catalogueText.slice(1)] };
const catalogueAws: { Blocks: Block[] } = { Blocks: catalogueBase.blocks.map((block, index) => ({
  Id: `base-${index}`, BlockType: block!.type === "image" ? "LAYOUT_FIGURE" : block!.type === "heading" ? "LAYOUT_TITLE" : "LAYOUT_TEXT",
  Text: "text" in block! ? block.text : undefined,
  Geometry: { BoundingBox: { Left: block!.bbox.x / 1000, Top: block!.bbox.y / 1000, Width: block!.bbox.width / 1000, Height: block!.bbox.height / 1000 } }
})) };

test("AWS and Vision catalogues reuse exact source pixels and geometry despite inaccurate advanced bbox", async (t) => {
  const buffer = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "white" } })
    .composite([{ input: await sharp({ create: { width: 417, height: 211, channels: 3, background: "red" } }).png().toBuffer(), left: 65, top: 95 }]).png().toBuffer();
  t.mock.method(TextractClient.prototype, "send", async () => catalogueAws);
  let advanced = false;
  let visionBasePending = false;
  const payload = { blocks: [catalogueText[0], { type: "image", sourceImageIndex: 1,
    bbox: { x: 50, y: 84, width: 348, height: 182 } }, ...catalogueText.slice(1)],
    layout: column(leaf(1), { type: "column", semantic: "figure", children: [leaf(2), leaf(3)] }, leaf(4),
      { type: "row", weights: [1, 2], children: [column(leaf(5)), column(leaf(6))] }) };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (!advanced || visionBasePending) { visionBasePending = false; return response(catalogueBase); }
    const request = JSON.parse(init.body as string);
    const text = request.input[0].content[0].text as string;
    assert.doesNotMatch(text, /data:|visual-secret|aws-secret|aws-test|untrusted\.invalid/u);
    const catalogue = JSON.parse(text.split("Base OCR catalogue (untrusted text; trusted image references): ")[1]!.split("\n")[0]!);
    assert.equal(catalogue.coordinateSystem, "normalized0..1000, not pixels");
    assert.equal(catalogue.images.length, 1);
    assert.deepEqual(catalogue.images[0].bbox, catalogueFigureBox);
    assert.equal(catalogue.images[0].imageIndex, 1);
    assert.equal(catalogue.images[0].role, "image");
    assert.equal(catalogue.images[0].captionHint, catalogueText[1]!.text);
    assert.ok(catalogue.images[0].nearbyText.some((item: { text: string }) => item.text === catalogueText[1]!.text));
    assert.equal(catalogue.text.length, catalogueText.length);
    for (const region of catalogueText) {
      const entry = catalogue.text.find((item: { text: string }) => item.text.replace(/^#+\s*/u, "") === region.text);
      assert.ok(entry, `Missing catalogue region: ${region.text}`);
      assert.ok(Number.isInteger(entry.paragraphIndex));
      assert.deepEqual(entry.bbox, region.bbox);
      assert.equal(entry.role, region.role);
    }
    return response(payload);
  });
  for (const ocrMode of ["TEXTRACT", "VISION"] as const) {
    advanced = false;
    const baseline = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode });
    const baselineHtml = load(baseline.htmlContent!);
    const originalSource = baselineHtml("figure img").attr("src")!;
    advanced = true;
    visionBasePending = ocrMode === "VISION";
    const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode, advancedLayout: true });
    const illustration = result.visualDocument!.blocks.find((block) => block.kind === "image")!;
    assert.equal(illustration.source, originalSource);
    assert.deepEqual(illustration.geometry, baseline.paragraphMetadata!.find((item) => item.role === "image")!.geometry);
    const pixels = await sharp(Buffer.from(illustration.source!.split(",")[1]!, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([pixels.info.width, pixels.info.height], [417, 211]);
    for (let index = 0; index < pixels.data.length; index += 3) assert.deepEqual([...pixels.data.subarray(index, index + 3)], [255, 0, 0]);
    for (const region of catalogueText) assert.ok(result.paragraphs.includes(region.text), `Missing output region: ${region.text}`);
    assert.equal(load(result.htmlContent!)("figure img").length, 1);
  }
});

test("advanced catalogue rejects unknown, absent, fractional and duplicate image references without recropping", async (t) => {
  mockDelays(t);
  const aws = t.mock.method(TextractClient.prototype, "send", async () => catalogueAws);
  let blocks: unknown[] = [];
  const vision = t.mock.method(globalThis, "fetch", async () => response({ blocks, layout: column(...blocks.map((_, index) => leaf(index + 1))) }));
  const box = { type: "image", bbox: catalogueFigureBox };
  for (blocks of [
    [{ ...box, sourceImageIndex: 2 }], [box], [{ ...box, sourceImageIndex: 1.5 }],
    [{ ...box, sourceImageIndex: 0 }], [{ ...box, sourceImageIndex: 501 }],
    [{ ...box, sourceImageIndex: 1 }, { ...box, sourceImageIndex: 1 }],
    [{ type: "image", source: "https://untrusted.invalid/image.png" }]
  ]) {
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED", statusCode: 502 });
  }
  assert.equal(aws.mock.callCount(), 7);
  assert.equal(vision.mock.callCount(), 21);
});

test("source index allows omitted bbox only in advanced mode; empty catalogues require bbox", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => catalogueAws);
  let payload: unknown = { blocks: [{ type: "image", sourceImageIndex: 1 }], layout: column(leaf(1)) };
  t.mock.method(globalThis, "fetch", async () => response(payload));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(result.visualDocument!.blocks[0]!.kind, "image");
  payload = { blocks: [{ type: "image", sourceImageIndex: 1 }] };
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION" }), { code: "OCR_INVALID_RESPONSE" });
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  for (payload of [
    { blocks: [{ type: "image" }], layout: column(leaf(1)) },
    { blocks: [{ type: "image", sourceImageIndex: 1, bbox: catalogueFigureBox }], layout: column(leaf(1)) }
  ]) await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED" });
});

test("dedicated prompt specifies trusted images, normalized geometry and full regional coverage", () => {
  const prompt = buildAdvancedVisionPrompt("es", resolveAdvancedLayoutLimits());
  for (const contract of [/sourceImageIndex/u, /1-based image-only/u, /ONLY when the base image catalogue is empty/u,
    /NOT pixels/u, /bbox on every text block/u, /Every substantial base text region/u, /FULL text/u,
    /illustration descriptions/u, /each sidebar/u, /rasterized inside a selected map/u, /do not emit map labels/u,
    /weights ONLY for horizontal rows/u, /Document headings are not repeated headers/u, /full captions/u]) assert.match(prompt, contract);
  for (const contract of [/printed colors/u, /background fills/u, /borders\/frames/u, /inset padding/u,
    /borderWidth \(frame width, 0-8 px\)/u, /padding \(0-48 px\)/u, /Do not invent decorations/u,
    /No arbitrary CSS/u, /numbered section titles/u, /"style":\{"backgroundColor":"#F4F1E8"/u,
    /"color":"#304050"/u]) assert.match(prompt, contract);
  assert.doesNotMatch(prompt, /Venus|DOC [0-9]|lower-left sidebar/u);
});

const fidelityVenus = "Venus de El Pendo representa la figura femenina. Posee una antiguedad de diecisiete mil anos. Pertenece al arte mobiliar realizado sobre objetos pequenos y manejables, principalmente esculturas y grabados del Paleolitico.";
const fidelityEvolution = "El ser humano es el resultado de una larga evolucion desde los hominidos hace millones de anos hasta el Homo sapiens sapiens, surgido en el Paleolitico superior, que incluye a todos los humanos modernos.";
const fidelitySidebar = "Escultura de bulto redondo: tipo escultorico en el que se puede observar la figura desde todos sus puntos de vista. Vocabulario independiente para comprender el arte prehistorico.";
const fidelityCells = ["PINTURA CANTABRICA. Paleolitico superior. Animales aislados realistas y policromos en el interior de cuevas de Altamira y Tito Bustillo.",
  "PINTURA LEVANTINA. Neolitico. Figuras esquematicas de animales y personas monocromas en abrigos rocosos de la Arana y Cogull."];
const fidelityBase = { blocks: [
  { type: "heading", text: "DOC 8 El arte prehistorico", role: "heading", bbox: { x: 60, y: 35, width: 850, height: 35 } },
  { type: "image", bbox: { x: 20, y: 50, width: 30, height: 30 } },
  { type: "image", bbox: catalogueFigureBox },
  { type: "image", bbox: { x: 487, y: 95, width: 419, height: 211 } },
  { type: "paragraph", text: catalogueText[1]!.text, role: "imageCaption", bbox: { x: 65, y: 315, width: 417, height: 20 } },
  { type: "paragraph", text: "Pintura levantina. Escena de caza en la cueva de la Vieja, Alpera (Albacete).", role: "imageCaption", bbox: { x: 487, y: 315, width: 419, height: 20 } },
  { type: "paragraph", text: fidelityCells.join(" "), role: "body", bbox: { x: 65, y: 340, width: 841, height: 110 } },
  { type: "image", bbox: { x: 65, y: 480, width: 140, height: 300 } },
  { type: "paragraph", text: fidelityVenus, role: "body", bbox: { x: 215, y: 480, width: 110, height: 300 } },
  { type: "heading", text: "DOC 9 La evolucion humana", role: "heading", bbox: { x: 350, y: 465, width: 550, height: 20 } },
  { type: "image", bbox: { x: 350, y: 500, width: 350, height: 110 } },
  { type: "paragraph", text: fidelityEvolution, role: "body", bbox: { x: 730, y: 500, width: 180, height: 110 } },
  { type: "heading", text: "DOC 10 El arte rupestre", role: "heading", bbox: { x: 350, y: 650, width: 550, height: 20 } },
  { type: "image", bbox: { x: 350, y: 680, width: 568, height: 260 } },
  { type: "image", bbox: { x: 65, y: 820, width: 200, height: 27 } },
  { type: "paragraph", text: fidelitySidebar, role: "body", bbox: { x: 65, y: 865, width: 230, height: 50 } },
  { type: "paragraph", text: "38", role: "pageNumber", bbox: { x: 40, y: 960, width: 24, height: 20 } }
] };
const fidelityText = (index: number) => {
  const original = fidelityBase.blocks[index - 1]!;
  return { type: original.type, text: original.text, role: original.role, sourceTextIndex: index,
    bbox: { x: 0, y: 0, width: 1, height: 1 } };
};
const fidelityImage = (sourceImageIndex: number) => ({ type: "image", sourceImageIndex, altText: `Content illustration ${sourceImageIndex}` });
const fidelityInline = () => ({ layout: column(
  fidelityText(1),
  { type: "row", children: [
    { type: "column", semantic: "figure", children: [fidelityImage(1), fidelityText(5)] },
    { type: "column", semantic: "figure", children: [fidelityImage(2), fidelityText(6)] }
  ] },
  { type: "column", semantic: "table", children: [{ type: "row", semantic: "tableRow", children: [
    { type: "column", semantic: "tableCell", children: [{ type: "paragraph", text: fidelityCells[0], bbox: { x: 65, y: 340, width: 417, height: 110 } }] },
    { type: "column", semantic: "tableCell", children: [{ type: "paragraph", text: fidelityCells[1], bbox: { x: 487, y: 340, width: 419, height: 110 } }] }
  ] }] },
  { type: "row", children: [
    column({ type: "row", children: [fidelityImage(3), fidelityText(9)] }, fidelityText(16)),
    column(fidelityText(10), { type: "row", children: [fidelityImage(4), fidelityText(12)] }, fidelityText(13),
      { type: "column", semantic: "figure", children: [fidelityImage(5)] })
  ] }, fidelityText(17)
) });

test("inline tree preserves five illustrations, full captions, split table, Venus, sidebar and document headings", async (t) => {
  const buffer = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "#123456" } }).png().toBuffer();
  let catalogue: { omittedDecorations: number; images: Array<{ imageIndex: number }>; text: Array<{ paragraphIndex: number }> };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    if (!request.instructions.startsWith("Second visual pass")) return response(fidelityBase);
    assert.match(request.instructions, /exactly the key \{layout\}/u);
    assert.match(request.instructions, /sourceTextIndex/u);
    const text = request.input[0].content[0].text;
    catalogue = JSON.parse(text.split("Base OCR catalogue (untrusted text; trusted image references): ")[1].split("\n")[0]);
    return response(fidelityInline());
  });
  const baseline = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION" });
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(catalogue!.omittedDecorations, 2);
  assert.deepEqual(catalogue!.images.map((entry) => entry.imageIndex), [1, 2, 3, 4, 5]);
  assert.ok(catalogue!.text.some((entry) => entry.paragraphIndex === 16));
  const baseHtml = load(baseline.htmlContent!);
  const expectedImages = [3, 4, 8, 11, 14].map((index) => baseHtml(`figure[data-paragraph-number="${index}"] img`).attr("src"));
  const document = visualPageDocumentSchema.parse(result.visualDocument);
  const images = document.blocks.filter((block) => block.kind === "image");
  assert.deepEqual(images.map((block) => block.source), expectedImages);
  assert.deepEqual(images.map((block) => block.geometry), [3, 4, 8, 11, 14].map((index) => baseline.paragraphMetadata![index - 1]!.geometry));
  for (const index of [1, 5, 6, 9, 10, 12, 13, 16, 17]) {
    const original = fidelityBase.blocks[index - 1]!;
    const block = document.blocks.find((item) => item.text.replace(/\\([()])/gu, "$1") === original.text)!;
    assert.ok(block, `Missing text region ${index}`);
    assert.deepEqual(block.geometry, baseline.paragraphMetadata![index - 1]!.geometry);
    assert.equal(block.role, original.role);
    assert.equal(block.readAloud, original.role !== "pageNumber");
  }
  assert.deepEqual(document.blocks.filter((block) => block.text.startsWith("PINTURA")).map((block) => block.geometry!.bbox), [
    { left: 0.065, top: 0.34, width: 0.417, height: 0.11 }, { left: 0.487, top: 0.34, width: 0.419, height: 0.11 }
  ]);
  const html = load(result.htmlContent!);
  assert.equal(html('[data-layout-semantic="figure"]').length, 3);
  assert.deepEqual(html('[data-layout-semantic="figure"] [data-element-role="imageCaption"]').map((_, node) => html(node).text()).get(),
    [fidelityBase.blocks[4]!.text, fidelityBase.blocks[5]!.text]);
  assert.equal(result.paragraphs.length, 16);
  assert.equal(new Set(result.paragraphIds).size, 16);
});

test("inline responses reject missing illustrations and substantial body even when references and tree are valid", async (t) => {
  mockDelays(t);
  const substantial = { blocks: [fidelityBase.blocks[8], fidelityBase.blocks[11], fidelityBase.blocks[15],
    { type: "image", bbox: catalogueFigureBox }, { type: "image", bbox: { x: 550, y: 100, width: 300, height: 200 } }] };
  let payload: unknown;
  let basePending = true;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (basePending) { basePending = false; return response(substantial); }
    requests.push(String(init.body));
    return response(payload);
  });
  const completeText = [fidelityText(9), fidelityText(12), fidelityText(16)].map(({ sourceTextIndex, ...block }) => block);
  for (payload of [
    { layout: column(...completeText, fidelityImage(1)) },
    { layout: column({ type: "paragraph", text: fidelityEvolution }, { type: "paragraph", text: fidelitySidebar }, fidelityImage(1), fidelityImage(2)) },
    { layout: column({ type: "paragraph", text: fidelityVenus }, { type: "paragraph", text: fidelitySidebar }, fidelityImage(1), fidelityImage(2)) },
    { layout: column({ type: "paragraph", text: fidelityVenus }, { type: "paragraph", text: fidelityEvolution }, fidelityImage(1), fidelityImage(2)) },
    { layout: column({ type: "paragraph", text: "El arte prehistorico incluye una figura femenina." },
      { type: "paragraph", text: fidelityEvolution }, { type: "paragraph", text: fidelitySidebar },
      { ...fidelityImage(1), altText: fidelityVenus }, fidelityImage(2)) }
  ]) {
    basePending = true;
    requests.length = 0;
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED" });
    assert.equal(requests.length, 3);
    assert.match(requests[1]!, /Missing meaningful sourceImageIndex 2|Missing substantial body coverage for paragraphIndex [123]/u);
    const repair = JSON.parse(requests[1]!).input[0].content[0].text.split("Previous attempt was rejected")[1];
    assert.doesNotMatch(repair, /Venus|hominidos|Escultura/u);
  }
});

test("coverage accepts corrected accents and text split across leaves without copying base text", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => response(++calls === 1
    ? { blocks: [{ type: "paragraph", text: fidelityVenus, bbox: catalogueFigureBox }] }
    : { layout: column({ type: "paragraph", text: fidelityVenus.slice(0, 83).replace("antiguedad", "antigüedad"), sourceTextIndex: 1 },
      { type: "paragraph", text: fidelityVenus.slice(83), bbox: { x: 60, y: 400, width: 300, height: 100 } }) }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(calls, 2);
  assert.match(result.paragraphs[0]!, /antigüedad/u);
  assert.deepEqual(result.paragraphMetadata![0]!.geometry!.bbox, { left: 0.065, top: 0.095, width: 0.417, height: 0.211 });
});

test("inline text references reject unknown, fractional and image-only paragraph indices", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => catalogueAws);
  let sourceTextIndex: number;
  t.mock.method(globalThis, "fetch", async () => response({ layout: column(fidelityImage(1), { type: "paragraph", text: "Caption.", sourceTextIndex }) }));
  for (sourceTextIndex of [0, 1.5, 2, 99]) {
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED" });
  }
});

test("inline prepass rejects excessive depth, nodes, leaves and unsafe child fields before conversion", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let payload: unknown;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { requests.push(String(init.body)); return response(payload); });
  let deep: unknown = { type: "paragraph", text: "Text." };
  for (let index = 0; index < 8; index++) deep = column(deep);
  for (payload of [
    { layout: deep },
    { layout: column(...Array.from({ length: 501 }, () => ({ type: "paragraph", text: "Text." }))) },
    { layout: column(...Array.from({ length: 500 }, () => column({ type: "paragraph", text: "Text." }))) },
    { layout: column({ type: "paragraph", text: "Text.", children: [] }) },
    { layout: column({ type: "image", bbox: catalogueFigureBox, source: "https://untrusted.invalid" }) },
    { layout: { type: "column", text: "Container content.", children: [{ type: "paragraph", text: "Text." }] } },
    { layout: { type: "column", children: [{ type: "paragraph", text: "Text.", style: { color: "url(https://untrusted.invalid)" } }] } },
    { layout: column({ type: "block", blockIndex: 1 }) },
    { layout: { type: "figure", semantic: "table", children: [{ type: "paragraph", text: "Text." }] } },
    { layout: column({ type: "paragraph", text: "Text." }), secret: "unsafe" }
  ]) {
    requests.length = 0;
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED" });
    assert.equal(requests.length, 3);
    assert.doesNotMatch(requests[1]!, /untrusted\.invalid|Container content|unsafe/u);
  }
  assert.match(requests[0]!, /exactly the key/u);
});

test("inline figure shorthand and pageNumber normalize without invented leaves or lost text", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => catalogueAws);
  t.mock.method(globalThis, "fetch", async () => response({ layout: column(
    { type: "figure", children: [fidelityImage(1), { type: "paragraph", role: "imageCaption", text: "Full caption." }] },
    { type: "pageNumber", text: "38" }
  ) }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(result.paragraphs.length, 3);
  assert.equal(load(result.htmlContent!)('[data-layout-semantic="figure"] img').length, 1);
  assert.equal(result.paragraphMetadata!.at(-1)!.role, "pageNumber");
  assert.equal(result.paragraphMetadata!.at(-1)!.readAloud, false);
});

test("inline budgets respect reserved limits and repair feedback lists expected leaf types", async (t) => {
  mockDelays(t);
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let payload: unknown;
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return response(payload); });
  for (payload of [
    { layout: column({ type: "paragraph", text: "One." }, { type: "paragraph", text: "Two." }) },
    { layout: column(column({ type: "paragraph", text: "Too deep." })) },
    { layout: column({ type: "text", text: "LEAKED-MODEL-TEXT" }) }
  ]) {
    bodies.length = 0;
    await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true,
      advancedLayoutLimits: { maxBlocks: 1, maxDepth: 2 } }), { code: "OCR_ADVANCED_FAILED" });
    assert.equal(bodies.length, 3);
  }
  assert.match(bodies[1]!, /expected heading\|paragraph\|image/u);
  assert.doesNotMatch(bodies[1]!, /LEAKED-MODEL-TEXT/u);
});

test("inline prepass accepts exactly 500 leaves, 1000 nodes and canonical depth eight", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let payload: unknown = { layout: column({ type: "paragraph", text: "First." },
    ...Array.from({ length: 499 }, (_, index) => column({ type: "paragraph", text: `Paragraph ${index + 2}.` }))) };
  t.mock.method(globalThis, "fetch", async () => response(payload));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(result.visualDocument!.blocks.length, 500);
  assert.equal(new Set(result.paragraphIds).size, 500);
  let deep: unknown = { type: "paragraph", text: "Deep leaf." };
  for (let index = 0; index < 7; index++) deep = column(deep);
  payload = { layout: deep };
  const deepResult = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.deepEqual(deepResult.paragraphs, ["Deep leaf."]);
});

test("substantial coverage requires at least 55 percent of unique keywords, not repetition or image altText", async (t) => {
  mockDelays(t);
  const body = "Archaeology prehistoric sculpture feminine statuettes limestone engraving portable symbolic representation.";
  const words = body.replace(/\.$/u, "").split(" ");
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [{ Id: "body", BlockType: "LAYOUT_TEXT", Text: body }] }));
  let text = words.slice(0, 5).join(" ").repeat(10);
  t.mock.method(globalThis, "fetch", async () => response({ layout: column({ type: "paragraph", text }) }));
  await assert.rejects(runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true }), { code: "OCR_ADVANCED_FAILED" });
  text = words.slice(0, 6).join(" ");
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.deepEqual(result.paragraphs, [text]);
});

test("inline fallback crops use the unchanged baseline crop only when no content images are catalogued", async (t) => {
  t.mock.method(TextractClient.prototype, "send", async () => awsBase);
  let advanced = false;
  t.mock.method(globalThis, "fetch", async () => response(advanced
    ? { layout: column({ type: "image", bbox: catalogueFigureBox, altText: "Illustration" }) }
    : { blocks: [{ type: "image", bbox: catalogueFigureBox, altText: "Illustration" }] }));
  const buffer = await image();
  const baseline = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION" });
  advanced = true;
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "TEXTRACT", advancedLayout: true });
  assert.equal(result.visualDocument!.blocks[0]!.source, load(baseline.htmlContent!)("figure img").attr("src"));
  assert.deepEqual(result.visualDocument!.blocks[0]!.geometry, baseline.paragraphMetadata![0]!.geometry);
});

test("missing text references infer full captions and corrected bodies but never widen split table cells", async (t) => {
  const payload = fidelityInline();
  const correctedVenus = fidelityVenus.replace("antiguedad", "antigüedad").replace("femenina", "humana");
  const stripReferences = (node: Record<string, any>) => {
    delete node.sourceTextIndex;
    if (node.text === fidelityVenus) node.text = correctedVenus;
    if (node.text === fidelityBase.blocks[5]!.text) node.bbox = { x: 353, y: 293, width: 507, height: 16 };
    node.children?.forEach(stripReferences);
  };
  stripReferences(payload.layout);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    if (++calls === 1) return response(fidelityBase);
    assert.match(request.input[0].content[0].text, /Required content image indices.*\[1,2,3,4,5\]/u);
    return response(payload);
  });
  const buffer = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(calls, 2);
  const document = result.visualDocument!;
  for (const index of [1, 5, 6, 9, 10, 12, 13, 16, 17]) {
    const original = fidelityBase.blocks[index - 1]!;
    const text = index === 9 ? correctedVenus : original.text;
    const block = document.blocks.find((item) => item.text.replace(/\\([()])/gu, "$1") === text)!;
    assert.ok(block, `Missing region ${index}`);
    assert.deepEqual(block.geometry!.bbox, { left: original.bbox.x / 1000, top: original.bbox.y / 1000,
      width: original.bbox.width / 1000, height: original.bbox.height / 1000 });
  }
  assert.deepEqual(document.blocks.filter((block) => block.text.startsWith("PINTURA")).map((block) => block.geometry!.bbox), [
    { left: 0.065, top: 0.34, width: 0.417, height: 0.11 }, { left: 0.487, top: 0.34, width: 0.419, height: 0.11 }
  ]);
  assert.equal(document.blocks.filter((block) => block.kind === "image").length, 5);
});

test("short captions infer exact accent, markdown and punctuation folded matches", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => response(++calls === 1
    ? { blocks: [{ type: "paragraph", role: "imageCaption", text: "Figura 1: Venus.", bbox: catalogueFigureBox }] }
    : { layout: column({ type: "paragraph", role: "imageCaption", text: "**Fígura** 1 - *Venus*!", bbox: { x: 500, y: 500, width: 100, height: 100 } }) }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.deepEqual(result.paragraphMetadata![0]!.geometry!.bbox, { left: 0.065, top: 0.095, width: 0.417, height: 0.211 });
  assert.match(result.paragraphs[0]!, /Fígura/u);
});

test("text inference prefers a unique exact region and leaves duplicate exact or fuzzy matches unresolved", async (t) => {
  const original = "Ancient archaeological sculpture portrays feminine symbolic traditions carved limestone portable artifacts.";
  const firstBox = { x: 80, y: 100, width: 200, height: 100 };
  const secondBox = { x: 450, y: 100, width: 200, height: 100 };
  const providerBox = { x: 50, y: 500, width: 100, height: 30 };
  let secondText = original.replace("feminine", "human");
  let text = original;
  let basePending = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (basePending) {
      basePending = false;
      return response({ blocks: [{ type: "paragraph", text: original, bbox: firstBox }, { type: "paragraph", text: secondText, bbox: secondBox }] });
    }
    return response({ layout: column({ type: "paragraph", text, bbox: providerBox }) });
  });
  const run = () => runOcrOnImage(imageBuffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  const imageBuffer = await image();
  const exact = await run();
  assert.deepEqual(exact.paragraphMetadata![0]!.geometry!.bbox, { left: 0.08, top: 0.1, width: 0.2, height: 0.1 });
  secondText = original.replace(/ /gu, " / ");
  basePending = true;
  const ambiguousExact = await run();
  assert.deepEqual(ambiguousExact.paragraphMetadata![0]!.geometry!.bbox, { left: 0.05, top: 0.5, width: 0.1, height: 0.03 });
  text = original.replace("portrays", "depicts");
  basePending = true;
  const ambiguousFuzzy = await run();
  assert.deepEqual(ambiguousFuzzy.paragraphMetadata![0]!.geometry!.bbox, { left: 0.05, top: 0.5, width: 0.1, height: 0.03 });
});

test("explicit text reference wins over automatic matching a different region", async (t) => {
  let calls = 0;
  const text = "Ancient archaeological sculpture portrays feminine symbolic traditions carved limestone portable artifacts.";
  t.mock.method(globalThis, "fetch", async () => response(++calls === 1
    ? { blocks: [{ type: "paragraph", text, bbox: catalogueFigureBox },
      { type: "paragraph", text: text.replace("feminine", "human"), bbox: { x: 500, y: 500, width: 200, height: 100 } }] }
    : { layout: column({ type: "paragraph", text, sourceTextIndex: 2, bbox: catalogueFigureBox }) }));
  const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.deepEqual(result.paragraphMetadata![0]!.geometry!.bbox, { left: 0.5, top: 0.5, width: 0.2, height: 0.1 });
});

test("fuzzy text inference enforces multiset similarity, complete-region length and significant-token minimum", async (t) => {
  const original = "Archaeology prehistoric sculpture feminine statuettes limestone engraving portable symbolic representation.";
  const tokens = original.replace(/\.$/u, "").split(" ");
  const providerBox = { x: 500, y: 500, width: 100, height: 30 };
  let text = "";
  let baseText = original;
  let basePending = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (basePending) { basePending = false; return response({ blocks: [{ type: "paragraph", text: baseText, bbox: catalogueFigureBox }] }); }
    return response({ layout: column({ type: "paragraph", text, bbox: providerBox }) });
  });
  for (text of [tokens.slice(0, 6).join(" "), [...tokens.slice(0, 8), "different", "words"].join(" "),
    [...tokens.slice(0, 8), tokens[0], tokens[0]].join(" ")]) {
    basePending = true;
    const result = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
    assert.deepEqual(result.paragraphMetadata![0]!.geometry!.bbox, { left: 0.5, top: 0.5, width: 0.1, height: 0.03 });
  }
  baseText = "Stone art is in a cave and it is old at dawn.";
  text = "Stone art is in a cave and it is old at dusk.";
  basePending = true;
  const short = await runOcrOnImage(await image(), "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.deepEqual(short.paragraphMetadata![0]!.geometry!.bbox, { left: 0.5, top: 0.5, width: 0.1, height: 0.03 });
});

test("trusted text inference repairs a root row mixing separate table and lower body bands", async (t) => {
  mockDelays(t);
  const original = fidelityInline().layout as { type: string; children: any[] };
  const payload = { layout: column(original.children[0], original.children[1],
    { type: "row", children: [original.children[2], original.children[3]] }, original.children[4]) };
  const stripReferences = (node: Record<string, any>) => { delete node.sourceTextIndex; node.children?.forEach(stripReferences); };
  stripReferences(payload.layout);
  let calls = 0;
  const repairRequests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (++calls === 1) return response(fidelityBase);
    repairRequests.push(String(init.body));
    return response(payload);
  });
  const buffer = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
  const result = await runOcrOnImage(buffer, "page.png", "image/png", { ...options, ocrMode: "VISION", advancedLayout: true });
  assert.equal(calls, 2);
  assert.equal(repairRequests.length, 1);
  const layout = result.visualDocument!.layout;
  assert.ok(layout.type !== "block");
  assert.equal(layout.children[2]!.type, "column");
  assert.equal(result.visualDocument!.blocks.filter((block) => block.kind === "image").length, 5);
});
