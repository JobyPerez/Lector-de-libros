import assert from "node:assert/strict";
import test from "node:test";

import { buildOutlineFromTitles } from "../src/modules/books/book-outline.js";

test("TOC honors explicit T1-T6 inclusion, legacy T1-T3 defaults and inactivity independently of narration", () => {
  const paragraphs = [
    { level: 1, includeInToc: null, active: 1, readAloud: 0 },
    { level: 2, includeInToc: 0, active: 1, readAloud: 1 },
    { level: 3, includeInToc: undefined, active: undefined, readAloud: 0 },
    { level: 4, includeInToc: null, active: 1, readAloud: 1 },
    { level: 5, includeInToc: 1, active: 1, readAloud: 0 },
    { level: 6, includeInToc: true, active: true, readAloud: 0 },
    { level: 1, includeInToc: 1, active: 0, readAloud: 1 },
    { level: 6, includeInToc: 1, active: false, readAloud: 0 },
    { level: 3, includeInToc: false, active: true, readAloud: 1 }
  ].map((p, index) => ({ ...p, paragraphId: `stable-${index + 1}`, paragraphNumber: index + 1, sequenceNumber: (index + 1) * 3, pageNumber: 2 }));
  const pages = [{
    pageNumber: 2,
    htmlContent: paragraphs.map((p) => `<h${p.level} data-paragraph-number="${p.paragraphNumber}">Title ${p.paragraphNumber}</h${p.level}>`).join("")
  }];
  const original = structuredClone(paragraphs);
  const outline = buildOutlineFromTitles(pages, paragraphs);
  assert.deepEqual(outline.map((entry) => [entry.chapterId, entry.level, entry.sequenceNumber]), [
    ["stable-1", 1, 3], ["stable-3", 3, 9], ["stable-5", 5, 15], ["stable-6", 6, 18]
  ]);
  assert.deepEqual(paragraphs, original);
});
