import assert from "node:assert/strict";
import test from "node:test";

import { OCR_MODEL_IDS, ocrModelIdSchema, SUMMARY_AI_MODEL_IDS, summaryAiModelIdSchema } from "../src/config/ai-models.js";
import { getOpenCodeGeminiEndpoint, getOpenCodeGeminiRequestHeaders, isGeminiModel } from "../src/config/opencode.js";
import { buildVisionOcrPrompt, extractResponsesApiText, getTesseractLanguages } from "../src/modules/books/image-ocr.js";
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
  assert.deepEqual(OCR_MODEL_IDS, ["mimo-v2.5-free", "x-preview-f-free", "muse-spark-1.2-contributor-free", "gemini-3.5-flash-lite"]);
  assert.ok(SUMMARY_AI_MODEL_IDS.includes("gemini-3.5-flash-lite"));
  assert.equal(ocrModelIdSchema.parse("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(summaryAiModelIdSchema.parse("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(ocrModelIdSchema.parse("x-preview-f-free"), "x-preview-f-free");
  assert.equal(ocrModelIdSchema.parse("muse-spark-1.2-contributor-free"), "muse-spark-1.2-contributor-free");
  assert.equal(summaryAiModelIdSchema.safeParse("x-preview-f-free").success, false);
});

test("configura adecuadamente utilidades del endpoint Gemini", () => {
  assert.equal(isGeminiModel("gemini-3.5-flash-lite"), true);
  assert.equal(isGeminiModel("mimo-v2.5-free"), false);
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
