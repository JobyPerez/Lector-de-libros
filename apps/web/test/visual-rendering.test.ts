import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderVisualDocument } from "../../api/src/modules/books/visual-document.js";
import type { VisualPageDocument } from "../src/app/api";
import { createVisualBlock, isCenteredFooterRow, renderVisualBlockHtml, renderVisualCompositeHtml, renderVisualPreviewHtml, renderVisualStyle } from "../src/features/book-builder/visual-page";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const { window } = new JSDOM("");

// Execute the production functions without importing ReaderPage's application/runtime dependencies.
function sourceFunctions(path: string, names: string[]) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) functions.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(functions.size, names.length);
  return ts.transpileModule(names.map((name) => functions.get(name)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
  }).outputText;
}

const readerCode = sourceFunctions("../src/features/reader/ReaderPage.tsx", [
  "normalizeRichTextForComparison", "getRichParagraphTextSegments", "extractRichParagraphText", "getSynchronizedRichHtmlContent"
]);
const reader = new Function("DOMParser", "NodeFilter", "Text", "HTMLBRElement", `${readerCode};return { extractRichParagraphText, getSynchronizedRichHtmlContent };`)(
  window.DOMParser, window.NodeFilter, window.Text, window.HTMLBRElement
);

function fixture(): VisualPageDocument {
  const image = { ...createVisualBlock("image"), source: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"></svg>').toString("base64")}`, imageWidth: 42, text: "Caption" };
  const blocks = [{ ...createVisualBlock("text"), text: "**First**\n\n*Second*" },
    { ...createVisualBlock("text"), text: Array.from({ length: 12 }, () => "Tall body").join("\n") }, image];
  const leaf = (index: number) => ({ id: crypto.randomUUID(), type: "block" as const, blockId: blocks[index]!.id });
  return { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "row", weights: [2, 1], children: [
    { id: crypto.randomUUID(), type: "column", weights: [100, 1], gap: 7, children: [leaf(0), leaf(2)] }, leaf(1)
  ] } };
}

function editorHtml(doc: VisualPageDocument) {
  const code = sourceFunctions("../src/features/book-builder/VisualPageEditor.tsx", ["VisualAtom", "CompositePreview", "renderNode"]);
  const bindings = { React, Fragment: React.Fragment, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    doc, renderVisualBlockHtml, renderVisualCompositeHtml, renderVisualStyle, isCenteredFooterRow,
    safeVisualImageSource: () => true, useBookContentImageHtml: (html: string) => html,
    replacePendingBookContentImageReferences: (html: string) => html, PreviewIcon: () => null,
    sourceImage: null, accessToken: null, bookId: "fixture", showInactive: true, dragging: null, selectedId: null,
    multiple: false, selection: [], disabled: false, unitNumber: (id: string) => doc.blocks.findIndex((block) => block.id === id) + 1,
    units: [], select() {}, onAmplify() {}, startDrag() {}, endDrag() {} };
  const renderNode = new Function(...Object.keys(bindings), `${code};return renderNode;`)(...Object.values(bindings));
  return renderToStaticMarkup(renderNode(doc.layout, true));
}

test("actual ReaderPage extraction and synchronization preserve ordinary multiline atoms and whole-page rich layout", () => {
  const doc = fixture();
  doc.blocks.push({ ...createVisualBlock("heading"), text: "**Heading**\r\nSecond line" });
  assert.ok(doc.layout.type !== "block");
  doc.layout.children.push({ id: crypto.randomUUID(), type: "block", blockId: doc.blocks.at(-1)!.id });
  doc.layout.weights!.push(1);
  const rendered = renderVisualDocument(doc);
  const dom = new window.DOMParser().parseFromString(rendered.htmlContent, "text/html");
  const paragraphs = rendered.paragraphs.map((paragraphText, index) => ({ paragraphNumber: index + 1, paragraphText }));
  dom.querySelectorAll("[data-paragraph-number]").forEach((node: HTMLElement) => {
    assert.equal(reader.extractRichParagraphText(node), rendered.paragraphs[Number(node.dataset.paragraphNumber) - 1]);
  });
  const first = dom.querySelector("p")!;
  assert.equal(first.hasAttribute("data-reader-text"), false, "ordinary paragraphs must exercise BR extraction, not cached narration");
  assert.equal(first.querySelectorAll("br").length, 2);
  assert.equal(reader.getSynchronizedRichHtmlContent(rendered.htmlContent, paragraphs), rendered.htmlContent);
  assert.equal(reader.getSynchronizedRichHtmlContent(rendered.htmlContent, [{ ...paragraphs[0], paragraphText: "Actually stale" }, ...paragraphs.slice(1)]), null);
});

test("API, standalone and actual interactive atom share image sizing without wrapper overrides", () => {
  const doc = fixture();
  for (const html of [renderVisualDocument(doc).htmlContent, renderVisualPreviewHtml(doc), editorHtml(doc)]) {
    const dom = new JSDOM(html).window.document;
    const image = dom.querySelector("img")!;
    const figure = image.closest("figure")!;
    assert.equal(figure.style.getPropertyValue("--reader-image-width"), "42%");
    assert.equal(figure.style.getPropertyValue("--visual-image-width"), "42%");
    assert.equal(image.style.width, "var(--reader-image-width,var(--visual-image-width,auto))");
    assert.equal(dom.querySelector(".visual-atom-content")?.style.getPropertyValue("--visual-image-width") ?? "", "");
  }
  const interactive = new JSDOM(editorHtml(doc)).window.document;
  const column = interactive.querySelector(".visual-container-column .visual-container-children");
  assert.ok(column);
  for (const child of column.querySelectorAll(":scope > .visual-layout-child")) assert.equal(child.style.flexGrow, "0");
  const row = interactive.querySelector(".visual-container-row .visual-container-children > .visual-layout-child");
  assert.equal(row.style.flexGrow, "2");
  const natural = new JSDOM(renderVisualPreviewHtml(doc)).window.document.querySelector('[data-visual-container="column"]');
  assert.equal(natural.style.gridTemplateRows, "");
  assert.equal(natural.style.gridAutoRows, "max-content");
});

test("composite scale overrides container and leaf scales consistently across API and preview", () => {
  const blocks = [createVisualBlock("text"), createVisualBlock("text")].map((block) => ({ ...block, fontScale: 1.2, style: { fontScale: 1.3 } }));
  const doc: VisualPageDocument = { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "column",
    style: { fontScale: 1.5 }, content: { kind: "text", separator: "paragraph", includeInToc: false, fontScale: 2 },
    children: blocks.map((block) => ({ id: crypto.randomUUID(), type: "block", blockId: block.id })) } };
  const api = new JSDOM(renderVisualDocument(doc).htmlContent).window.document;
  const preview = new JSDOM(renderVisualPreviewHtml(doc)).window.document;
  assert.equal(api.querySelector(".reader-content-compound").style.fontSize, "");
  assert.equal(api.querySelector(".reader-content-compound > div").style.fontSize, "2em");
  assert.equal(preview.querySelector("[data-visual-composite-id]").style.fontSize, "2em");
  for (const dom of [api, preview]) for (const paragraph of dom.querySelectorAll("p")) assert.equal(paragraph.style.fontSize, "");
});

// Opt in with VISUAL_LAYOUT_BROWSER=1; uses only synthetic inline assets, no app server or providers.
test("browser fixture keeps weighted columns natural and image widths equal on desktop and mobile", { skip: process.env.VISUAL_LAYOUT_BROWSER !== "1" }, async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route: any) => route.abort());
    const css = readFileSync(new URL("../src/features/reader/reading-document.css", import.meta.url), "utf8");
    const editorCss = readFileSync(new URL("../src/features/book-builder/visual-page.css", import.meta.url), "utf8");
    const doc = fixture();
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const html of [renderVisualDocument(doc).htmlContent, renderVisualPreviewHtml(doc)]) {
        await page.setContent(`<style>${css}body{margin:0;font:16px/1.5 serif}figure,p{margin:0}</style><article class="reader-layout" style="width:100%">${html}</article>`);
        await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        const sizes = await page.evaluate(() => {
          const image = document.querySelector("img")!;
          const column = document.querySelector('.reader-reading-column,[data-visual-container="column"]')!;
          const children = Array.from(column.children);
          return { image: image.getBoundingClientRect().width, figure: image.closest("figure")!.getBoundingClientRect().width,
            first: children[0]!.getBoundingClientRect().height, second: children[1]!.getBoundingClientRect().height,
            column: column.getBoundingClientRect().height, gap: parseFloat(getComputedStyle(column).gap) };
        });
        assert.ok(Math.abs(sizes.image / sizes.figure - .42) < .005);
        assert.ok(sizes.first < 100, "a short text must not grow to 100fr of the image height");
        assert.ok(sizes.column >= sizes.first + sizes.second + sizes.gap - 1);
      }
      await page.setContent(`<style>${editorCss}body{margin:0;font:16px/1.5 serif}</style><div class="visual-page-editor">${editorHtml(doc)}</div>`);
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      const interactive = await page.evaluate(() => {
        const image = document.querySelector("img")!;
        const column = document.querySelector(".visual-container-column .visual-container-children")!;
        const children = Array.from(column.querySelectorAll(":scope > .visual-layout-child"));
        return { ratio: image.getBoundingClientRect().width / image.closest("figure")!.getBoundingClientRect().width,
          children: children.map((child) => ({ grow: getComputedStyle(child).flexGrow,
            height: child.getBoundingClientRect().height, leaf: child.firstElementChild!.getBoundingClientRect().height })) };
      });
      assert.ok(Math.abs(interactive.ratio - .42) < .005);
      for (const child of interactive.children) {
        assert.equal(child.grow, "0");
        assert.ok(Math.abs(child.height - child.leaf) < 1, "interactive columns must not inflate leaf heights");
      }
    }
  } finally { await browser.close(); }
});
