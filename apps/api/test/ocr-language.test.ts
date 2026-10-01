import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { AI_MODELS, DEFAULT_OCR_MODEL_ID, OCR_MODEL_IDS, ocrModelIdSchema, SUMMARY_AI_MODEL_IDS, summaryAiModelIdSchema } from "../src/config/ai-models.js";
import { getOpenCodeGeminiEndpoint, getOpenCodeGeminiRequestHeaders, isGeminiModel } from "../src/config/opencode.js";
import { appEnv } from "../src/config/env.js";
import { buildVisionOcrPrompt, extractResponsesApiText, getTesseractLanguages, runOcrOnImage } from "../src/modules/books/image-ocr.js";
import { isPdfHeadingLikeText, isPdfPageNumberLine } from "../src/modules/books/pdf-import.js";

test("configura Tesseract segun el idioma OCR", () => {
  assert.equal(getTesseractLanguages("es"), "spa+eng");
  assert.equal(getTesseractLanguages("it"), "ita+eng");
});

test("genera prompts Vision en espanol e italiano", () => {
  const spanishPrompt = buildVisionOcrPrompt("es");
  const italianPrompt = buildVisionOcrPrompt("it");

  assert.match(spanishPrompt.system, /página de libro en español/u);
  assert.match(spanishPrompt.user, /Sin instrucciones adicionales/u);
  assert.match(italianPrompt.system, /pagina di libro in italiano/u);
  assert.match(italianPrompt.user, /Nessuna istruzione aggiuntiva/u);
  assert.equal(buildVisionOcrPrompt("it", "  Mantieni le note.  ").user, "Mantieni le note.");
});

test("incluye gemini-3.5-flash-lite en modelos de OCR y resumen", () => {
  assert.deepEqual(OCR_MODEL_IDS, ["gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini"]);
  assert.ok(SUMMARY_AI_MODEL_IDS.includes("gemini-3.5-flash-lite"));
  assert.equal(ocrModelIdSchema.parse("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(summaryAiModelIdSchema.parse("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(DEFAULT_OCR_MODEL_ID, "gemini-3.5-flash-lite");
  for (const modelId of OCR_MODEL_IDS) {
    assert.equal(ocrModelIdSchema.parse(modelId), modelId);
    const model = AI_MODELS.find((candidate) => candidate.id === modelId);
    assert.equal(model?.supportsVision, true);
    assert.match(model?.pricing ?? "", /Zen: \$/u);
  }
  for (const modelId of ["gpt-5.4-nano", "gpt-5.4-mini"]) {
    assert.equal(summaryAiModelIdSchema.safeParse(modelId).success, false);
  }
  for (const modelId of ["mimo-v2.5-free", "x-preview-f-free", "muse-spark-1.2-contributor-free"]) {
    assert.equal(ocrModelIdSchema.safeParse(modelId).success, false);
  }
});

test("configura adecuadamente utilidades del endpoint Gemini", () => {
  assert.equal(isGeminiModel("gemini-3.5-flash-lite"), true);
  assert.equal(isGeminiModel("gpt-5.4-nano"), false);
  assert.equal(getOpenCodeGeminiEndpoint("gemini-3.5-flash-lite"), "https://opencode.ai/zen/v1/models/gemini-3.5-flash-lite:generateContent");
  const headers = getOpenCodeGeminiRequestHeaders("test-key");
  assert.equal(headers["x-goog-api-key"], "test-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(headers["x-opencode-session"].startsWith("ses_"));
});

test("extrae texto de una respuesta Responses de OpenCode", () => {
  assert.equal(extractResponsesApiText({ output_text: " resultado directo " }), "resultado directo");
  assert.equal(extractResponsesApiText({
    output: [{
      content: [
        { text: "primera", type: "output_text" },
        { text: "segunda", type: "output_text" }
      ],
      type: "message"
    }]
  }), "primera\nsegunda");
});

test("envia imagenes OCR a Zen con el protocolo de cada modelo", async (t) => {
  const previousKey = appEnv.opencodeGoApiKey;
  appEnv.opencodeGoApiKey = "test-key";
  t.after(() => { appEnv.opencodeGoApiKey = previousKey; });
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  const text = JSON.stringify({ paragraphs: ["Texto reconocido."], rawText: "Texto reconocido." });

  for (const model of OCR_MODEL_IDS) {
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (model === "gemini-3.5-flash-lite") {
        assert.equal(url, getOpenCodeGeminiEndpoint(model));
        assert.equal(body.contents[0].parts[1].inlineData.data, image.toString("base64"));
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
      }

      assert.equal(url, "https://opencode.ai/zen/v1/responses");
      assert.equal(body.model, model);
      assert.match(body.input[0].content[0].text, /\bjson\b/iu);
      assert.equal(body.input[0].content[1].type, "input_image");
      assert.equal(body.input[0].content[1].image_url, `data:image/png;base64,${image.toString("base64")}`);
      assert.equal(body.text.format.type, "json_object");
      assert.equal(body.reasoning.effort, "none");
      assert.equal(body.max_output_tokens, 8192);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    });

    try {
      for (const options of [
        { language: "es" as const },
        { language: "es" as const, promptOverride: "Conserva las notas." },
        { language: "it" as const, promptOverride: "Mantieni le note." }
      ]) {
        const result = await runOcrOnImage(image, "page.png", "image/png", { ...options, model, ocrMode: "VISION" });
        assert.equal(result.rawText, "Texto reconocido.");
      }
      assert.equal(fetchMock.mock.callCount(), 3);
    } finally {
      fetchMock.mock.restore();
    }
  }
});

test("reconoce encabezados italianos y letras Unicode", () => {
  for (const heading of [
    "Capitolo 1",
    "Sezione seconda",
    "Prologo",
    "Epilogo",
    "Prefazione",
    "Introduzione",
    "ÉTUDES"
  ]) {
    assert.equal(isPdfHeadingLikeText(heading), true, heading);
  }

  assert.equal(isPdfHeadingLikeText("Questa è una frase completa."), false);
});

test("reconoce Pagina como numeracion italiana", () => {
  assert.equal(isPdfPageNumberLine("Pagina 42"), true);
  assert.equal(isPdfPageNumberLine("PAGINA 7"), true);
  assert.equal(isPdfPageNumberLine("Pagina seguente"), false);
});
