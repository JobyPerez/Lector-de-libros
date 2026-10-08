import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { resolveModelVisionCapability } from "../src/config/ai-models.js";
import { fetchModelMetadata, getCachedOpenCodeVisionCapability } from "../src/config/opencode-model-metadata.js";
import { runOcrOnImage } from "../src/modules/books/image-ocr.js";

test("verified exact OpenCode image metadata overrides obsolete static OCR rejection without adding availability", async (t) => {
  const vision = { modalities: { input: ["text", "image"], output: ["text"] } };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requests.push(String(url));
    if (String(url).includes("models.dev")) return Response.json({ opencode: { models: {
      "glm-5.3-flash": vision,
      "gpt-text-only": { modalities: { input: ["text"], output: ["text"] } }
    } }, other: { models: { "unknown-flash": vision } } });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: "paragraph", text: "Verified image model." }] }) } }] });
  });
  assert.equal(resolveModelVisionCapability("glm-5.3-flash"), false);
  await fetchModelMetadata(true);
  assert.equal(resolveModelVisionCapability("glm-5.3-flash"), true);
  assert.equal(resolveModelVisionCapability("glm-5.3-flash", false), false);
  assert.equal(getCachedOpenCodeVisionCapability("unknown-flash"), undefined);
  assert.equal(resolveModelVisionCapability("gpt-text-only"), false);
  const image = await sharp({ create: { width: 240, height: 320, channels: 3, background: "white" } }).png().toBuffer();
  const result = await runOcrOnImage(image, "page.png", "image/png", { model: "glm-5.3-flash", opencodeApiKey: "test-key", ocrMode: "VISION" });
  assert.deepEqual(result.paragraphs, ["Verified image model."]);
  assert.equal(requests.length, 2);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(fetchModelMetadata(true), /offline/);
  assert.equal(getCachedOpenCodeVisionCapability("glm-5.3-flash"), undefined);
});
