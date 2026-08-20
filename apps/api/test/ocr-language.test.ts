import assert from "node:assert/strict";
import test from "node:test";

import { buildVisionOcrPrompt, getTesseractLanguages } from "../src/modules/books/image-ocr.js";
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
