import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultBookAiRequestPrompt, getDefaultSectionAiRequestPrompt, getDefaultSectionSummaryPrompt } from "../src/modules/books/section-summary.js";

test("genera prompts predeterminados en el idioma del libro", () => {
  assert.match(getDefaultBookAiRequestPrompt("it"), /in italiano/u);
  assert.match(getDefaultSectionAiRequestPrompt("it"), /in italiano/u);
  assert.match(getDefaultSectionSummaryPrompt("it"), /in italiano/u);
  assert.match(getDefaultBookAiRequestPrompt("es"), /en español/u);
});
