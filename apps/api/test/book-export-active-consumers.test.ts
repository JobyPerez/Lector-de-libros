import assert from "node:assert/strict";
import test from "node:test";

import AdmZip from "adm-zip";
import sharp from "sharp";

import { buildEpubExport, buildPdfExport } from "../src/modules/books/book-export.js";

const book = { authorName: null, languageCode: "es" as const, synopsis: null, title: "Active content" };

test("EPUB and text PDF exclude inactive nested content and images, retaining visible muted content", async () => {
  const image = await sharp({ create: { width: 200, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const source = `data:image/png;base64,${image.toString("base64")}`;
  const options = {
    book, coverAsset: null, outline: [],
    pages: [{
      pageNumber: 1, pageLabel: null, paragraphs: [],
      htmlContent: `<div class="epub-page-body">
        <div class="visual-row"><h6 data-read-aloud="false">Visible heading</h6>
          <div><p data-is-active="true" data-read-aloud="false">Visible muted text <span data-is-active='false'>Secret inline</span></p></div>
          <div data-is-active='false'><h1>Secret heading</h1><p>Secret paragraph</p><img src="${source}" /></div>
          <p DATA-IS-ACTIVE=" FALSE ">Secret uppercase</p>
          <section data-active="false"><p>Secret renderer text</p><img src="${source}" /></section>
          <blockquote><span data-is-active="0">Secret quote</span>Visible quote</blockquote>
          <ul><li>Visible list <span data-is-active="false">Secret list</span></li></ul>
          <figure data-is-active="true" data-read-aloud="false" data-image-width="25"><img src="${source}" /></figure>
        </div>
      </div>`
    }]
  };
  const originalHtml = options.pages[0]!.htmlContent;
  const epub = new AdmZip(await buildEpubExport(options));
  const html = epub.readAsText("OEBPS/page-0001.xhtml");
  assert.doesNotMatch(html, /Secret/);
  assert.match(html, /Visible muted text/);
  assert.match(html, /Visible heading/);
  assert.match(html, /data-image-width="25"/);
  assert.equal((html.match(/<img /g) ?? []).length, 1);

  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport(options)), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 1);
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.doesNotMatch(text, /Secret/);
    for (const visible of ["Visible muted text", "Visible heading", "Visible quote", "Visible list"]) assert.ok(text.includes(visible));
    const operators = await page.getOperatorList();
    assert.equal(operators.fnArray.filter((operator) => operator === OPS.paintImageXObject).length, 1);
  } finally {
    await pdf.destroy();
  }
  assert.equal(options.pages[0]!.htmlContent, originalHtml);
});

test("export fallback filters optional active without collapsing paragraph numbering", async () => {
  const options = {
    book, coverAsset: null, outline: [],
    pages: [{
      pageNumber: 1, pageLabel: null, htmlContent: null,
      paragraphs: [
        { paragraphText: "Secret disabled", active: false },
        { paragraphText: "Visible legacy" },
        { paragraphText: "Secret numeric", active: 0 },
        { paragraphText: "Visible active", active: true },
        { paragraphText: "Visible projected", active: true, paragraphNumber: 12 }
      ]
    }]
  };
  const epub = new AdmZip(await buildEpubExport(options));
  const html = epub.readAsText("OEBPS/page-0001.xhtml");
  assert.doesNotMatch(html, /Secret/);
  assert.match(html, /data-paragraph-number="2"[^>]*>Visible legacy/);
  assert.match(html, /data-paragraph-number="4"[^>]*>Visible active/);
  assert.match(html, /data-paragraph-number="12"[^>]*>Visible projected/);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport(options)), useSystemFonts: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.doesNotMatch(text, /Secret/);
    assert.match(text, /Visible legacy/);
    assert.match(text, /Visible active/);
  } finally {
    await pdf.destroy();
  }
});

test("PDF image percentages change width proportionally without changing text or legacy sizing", async () => {
  const image = await sharp({ create: { width: 400, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
  const source = `data:image/png;base64,${image.toString("base64")}`;
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const options = {
    book, coverAsset: null, outline: [],
    pages: [
      `<figure><img src="${source}" /></figure>`,
      `<figure data-image-width="50"><img src="${source}" /></figure>`,
      `<div class="row"><div><img data-image-width="25%" src="${source}" /></div></div>`,
      `<figure data-image-width="invalid"><img src="${source}" /></figure>`
    ].map((htmlContent, index) => ({ htmlContent, pageLabel: null, pageNumber: index + 1, paragraphs: [] }))
  };
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport(options)), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 4);
    for (const [index, percentage] of [1, 0.5, 0.25, 1].entries()) {
      const page = await pdf.getPage(index + 1);
      const operators = await page.getOperatorList();
      const paintIndex = operators.fnArray.indexOf(OPS.paintImageXObject);
      let transformIndex = paintIndex - 1;
      while (transformIndex >= 0 && operators.fnArray[transformIndex] !== OPS.transform) transformIndex -= 1;
      assert.ok(transformIndex >= 0);
      const width = operators.argsArray[transformIndex][0] as number;
      assert.ok(Math.abs(width - (page.getViewport({ scale: 1 }).width - 100) * percentage) < 0.01);
    }
  } finally {
    await pdf.destroy();
  }
});
