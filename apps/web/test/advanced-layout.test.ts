import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import type { PageStyle, VisualLayoutNode, VisualPageDocument } from "../src/app/api";
import { createVisualBlock, flattenVisualLayout, isCenteredFooterRow, normalizeVisualDocument, renderVisualPreviewHtml, renderVisualStyle, visualDocumentSaveError } from "../src/features/book-builder/visual-page";
import { loadOcrConfig } from "./ocr-config-fixture";

const builderText = readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8");
const builder = ts.createSourceFile("builder.tsx", builderText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const { JSDOM } = createRequire(import.meta.url)("jsdom");

function transport() {
  const requests: { url: string; options: RequestInit }[] = [];
  const source = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '"http://synthetic.invalid"');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, (...args: any[]) => Promise<unknown>> = {};
  const fetch = async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ book: {}, updatedAt: "next" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  new Function("exports", "require", "fetch", code)(exports, () => ({}), fetch);
  return { api: exports, requests };
}

test("create and append serialize explicit multipart false by default, true opt-in and suppress LOCAL/skip", async () => {
  const { api, requests } = transport();
  for (const method of ["createImageBook", "appendImagesToBook"]) {
    for (const options of [undefined, { advancedLayout: true, ocrMode: "TEXTRACT", ocrModel: "selected" }, { advancedLayout: true, ocrMode: "VISION", ocrModel: "selected" }, { advancedLayout: true, ocrMode: "LOCAL" }, { advancedLayout: true, skipOcr: true }]) {
      const form = new FormData();
      form.set("title", "Synthetic");
      form.set("advancedLayout", "true"); // A stale form value must not opt in.
      await api[method]!("token", ...(method === "appendImagesToBook" ? ["book"] : []), form, options);
      const body = requests.at(-1)!.options.body as FormData;
      assert.equal(body.get("advancedLayout"), String(Boolean(options?.advancedLayout && options.ocrMode !== "LOCAL" && !options.skipOcr)));
      assert.equal(body.get("title"), "Synthetic");
      assert.equal(form.get("advancedLayout"), "true", "transport must not mutate the original form");
      if (options?.ocrModel) assert.equal(body.get("ocrModel"), "selected");
    }
  }
});

test("rerun serializes JSON bool and preserves exact expectedUpdatedAt and selected model", async () => {
  const { api, requests } = transport();
  for (const mode of ["TEXTRACT", "VISION", "LOCAL"]) {
    for (const advancedLayout of [undefined, false, true]) {
      await api.rerunOcrPage!("token", "book", 7, { ocrMode: mode, advancedLayout, ocrModel: "selected", expectedUpdatedAt: "2026-01-02T03:04:05.123456" });
      const body = JSON.parse(String(requests.at(-1)!.options.body));
      assert.deepEqual(body, { ocrMode: mode, advancedLayout: advancedLayout === true && mode !== "LOCAL", ocrModel: "selected", expectedUpdatedAt: "2026-01-02T03:04:05.123456" });
    }
  }
  await api.rerunOcrPage!("token", "book", 7);
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.options.body)), { ocrMode: "VISION", advancedLayout: false });
});

test("shared checkbox is false initially, disabled for LOCAL/busy, and explains the same Vision model", () => {
  const Checkbox = loadOcrConfig().AdvancedLayoutCheckbox;
  for (const [mode, value, busy] of [["TEXTRACT", false, false], ["TEXTRACT", true, false], ["LOCAL", true, false], ["VISION", false, false], ["VISION", true, true]] as const) {
    const html = renderToStaticMarkup(React.createElement(Checkbox, { mode, value, disabled: busy, onChange() {}, modelLabel: "selected" }));
    const input = new JSDOM(html).window.document.querySelector("input");
    assert.equal(input.checked, value && mode !== "LOCAL");
    assert.equal(input.disabled, busy || mode === "LOCAL");
    assert.match(html, /Reconstrucción avanzada de página/);
    assert.match(html, /sin garantía.*Tarda más.*mayor coste/);
    assert.match(html, /Al activarla/);
    if (mode === "VISION" && value) assert.match(html, /dos pasadas con el mismo modelo seleccionado: selected/);
    if (mode === "TEXTRACT" && value) assert.match(html, /AWS Textract y el modelo seleccionado: selected/);
    if (!value || mode === "LOCAL") {
      assert.match(html, /OCR estándar, sin segunda fase/);
      assert.doesNotMatch(html, /dos pasadas|AWS Textract y el modelo seleccionado/);
    }
  }
  for (const flow of ["create", "append", "review"]) {
    assert.match(builderText, new RegExp(`const \\[${flow}AdvancedLayout, set${flow[0]!.toUpperCase() + flow.slice(1)}AdvancedLayout\\] = useState\\(false\\)`));
    assert.match(builderText, new RegExp(`normalizeOcrOptions\\(${flow === "review" ? "nextMode" : `${flow}OcrMode`}, ${flow}AdvancedLayout, selectedOcrModel,`));
  }
  assert.doesNotMatch(builderText, /localStorage[^\n]*[Aa]dvanced|[Aa]dvanced[^\n]*localStorage/);
  assert.equal((builderText.match(/<AdvancedLayoutCheckbox /g) ?? []).length, 3);
});

test("review UI switches providers, resets LOCAL opt-in and exposes only the selected execution after settings", () => {
  let panel: ts.JsxElement | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(builder) === "className" && attr.initializer?.getText(builder) === '"review-floating-ocr-panel"')) panel = node;
    ts.forEachChild(node, visit);
  }
  visit(builder);
  assert.ok(panel);
  const code = ts.transpileModule(`const panel = ${panel.getText(builder)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const state = { reviewOcrMode: "TEXTRACT", reviewAdvancedLayout: false, isSavingReview: false };
  const calls: unknown[][] = [];
  function render() {
    const bindings = { React, ...loadOcrConfig(), ...state, reviewBookId: "book", isReviewCropMode: false, reviewOcrPanelRef: { current: null },
      reviewOcrModelLabel: "Selected Vision", selectedOcrModel: "selected", selectedOcrModelOption: { pricing: "Synthetic pricing" },
      ocrModelOptions: [{ id: "selected", name: "Selected Vision", pricing: "Synthetic pricing", supportsVision: true, visionStatus: "supported" }], awsTextractCostLabel: "Synthetic cost",
      canRunOcr: () => true, compatibilityMessage: null,
      reviewPromptOverride: "Synthetic prompt", isReviewPromptEditorOpen: false,
      setReviewOcrMode: (mode: string) => { state.reviewOcrMode = mode; },
      setReviewAdvancedLayout: (value: boolean) => { state.reviewAdvancedLayout = value; },
      setOcrModelOverride() {}, setIsReviewPromptEditorOpen() {}, setReviewPromptOverride() {}, defaultVisionOcrEditablePrompt: "",
      handleRerunOcr: (...args: unknown[]) => { calls.push(args); }, PromptIcon: () => null, OcrPromptEditor: () => null };
    const root = new Function(...Object.keys(bindings), `${code}\nreturn panel;`)(...Object.values(bindings));
    const elements: React.ReactElement<Record<string, any>>[] = [];
    function collect(child: React.ReactNode) {
      React.Children.forEach(child, (item) => {
        if (!React.isValidElement<Record<string, any>>(item)) return;
        if (typeof item.type === "function") collect((item.type as (props: unknown) => React.ReactNode)(item.props));
        else { elements.push(item); collect(item.props.children); }
      });
    }
    collect(root);
    return { elements, html: renderToStaticMarkup(root), select: elements.find((item) => item.type === "select")!,
      checkbox: elements.find((item) => item.type === "input" && item.props.type === "checkbox")!,
      actions: elements.filter((item) => item.type === "button" && String(item.props.className).startsWith("review-ocr-option")) };
  }
  let view = render();
  assert.equal(view.checkbox.props.checked, false);
  assert.equal(view.actions.length, 1);
  assert.match(view.html, /OCR estándar, sin segunda fase/);
  for (const mode of ["VISION", "TEXTRACT", "LOCAL", "VISION"]) {
    view.select.props.onChange({ target: { value: mode } });
    view = render();
    assert.equal(view.actions.length, 1);
    view.actions[0]!.props.onClick();
    assert.deepEqual(calls.at(-1), mode === "VISION" ? [mode, "Synthetic prompt"] : [mode]);
    if (mode === "LOCAL") {
      assert.equal(state.reviewAdvancedLayout, false);
      assert.equal(view.checkbox.props.checked, false);
      assert.equal(view.checkbox.props.disabled, true);
      assert.match(view.html, /No disponible con OCR LOCAL/);
    } else {
      view.checkbox.props.onChange({ target: { checked: true } });
      view = render();
      assert.equal(view.checkbox.props.checked, true);
      assert.match(view.html, mode === "VISION" ? /dos pasadas con el mismo modelo seleccionado/ : /AWS Textract y el modelo seleccionado/);
      const model = view.elements.findIndex((item) => item.type === "select" && item.props.value === "selected");
      assert.ok(model > view.elements.indexOf(view.checkbox));
      assert.ok(model < view.elements.indexOf(view.actions[0]!));
    }
  }
  state.isSavingReview = true;
  view = render();
  assert.equal(view.select.props.disabled, true);
  assert.equal(view.checkbox.props.disabled, true);
  assert.ok(view.actions.every((action) => action.props.disabled));
});

test("nested semantic table preserves styles, weights and gaps and rejects unsafe metadata", () => {
  const blocks = [createVisualBlock("text"), createVisualBlock("text")];
  const doc: VisualPageDocument = { version: 1, blocks, layout: { id: "table", type: "column", semantic: "table", style: { backgroundColor: "#ffffff", padding: 4 }, gap: 3, children: [{ id: "row", type: "row", semantic: "tableRow", weights: [1, 2], gap: 6, children: blocks.map((block, index) => ({ id: `cell-${index}`, type: "column", semantic: "tableCell", style: { borderColor: "#123abc", borderWidth: 1 }, children: [{ id: `leaf-${index}`, type: "block", blockId: block.id }] })) }] } };
  assert.deepEqual(normalizeVisualDocument(normalizeVisualDocument(doc)), normalizeVisualDocument(doc));
  const normalized = normalizeVisualDocument(doc);
  assert.deepEqual(normalized.layout.type !== "block" && normalized.layout.style, { backgroundColor: "#ffffff", padding: 4 });
  assert.equal(normalized.layout.type !== "block" && normalized.layout.semantic, "table");
  assert.equal(visualDocumentSaveError(doc), null);
  const html = new JSDOM(renderVisualPreviewHtml(normalizeVisualDocument(doc))).window.document;
  assert.equal(html.querySelector('[data-layout-semantic="table"]').style.padding, "4px");
  assert.match(html.querySelector('[data-layout-semantic="tableRow"]').getAttribute("style"), /gap:6px;grid-template-columns:minmax\(0,1fr\) minmax\(0,2fr\)/);
  assert.equal(html.querySelectorAll('[data-layout-semantic="tableCell"]').length, 2);
  assert.equal(html.querySelector('[data-layout-semantic="tableCell"]').style.borderWidth, "1px");
  for (const style of [{ padding: 49 }, { color: '#ffffff;position:fixed' }, { position: "fixed" }]) {
    const unsafe = { ...doc, layout: { ...doc.layout, style: style as PageStyle } } as VisualPageDocument;
    assert.ok(visualDocumentSaveError(unsafe));
    assert.doesNotMatch(renderVisualPreviewHtml(unsafe), /position:fixed|padding:49/);
  }
  const invalidSemantic = { ...doc, layout: { ...doc.layout, semantic: 'table" onclick="evil' } } as unknown as VisualPageDocument;
  assert.ok(visualDocumentSaveError(invalidSemantic));
  assert.doesNotMatch(renderVisualPreviewHtml(invalidSemantic), /onclick|evil/);
  const legacy = { ...doc, layout: { id: "legacy", type: "column" as const, children: blocks.map((block) => ({ id: block.id, type: "block" as const, blockId: block.id })) } };
  assert.equal(visualDocumentSaveError(legacy), null);
  assert.equal(normalizeVisualDocument(legacy).layout.type, "column");
});

test("mobile collapse selectors exclude semantic tables without changing standard rows", () => {
  const document = new JSDOM('<div data-layout-semantic="table"><div id="table-row" class="reader-reading-row" data-layout-id="row"><div><div id="nested-row" class="reader-reading-row" data-layout-id="nested"></div></div></div></div><div id="standard-row" class="reader-reading-row" data-layout-id="standard"></div>').window.document;
  for (const file of ["reading-document.css", "reading-views.css"]) {
    const css = readFileSync(new URL(`../src/features/reader/${file}`, import.meta.url), "utf8");
    const mobile = css.slice(css.indexOf(file === "reading-document.css" ? "@container" : "@media"));
    const selectors = [...mobile.matchAll(/([^{}]+)\{[^{}]*grid-template-columns: minmax\(0, 1fr\)/g)].map((match) => match[1]!.trim().replace(/\.reader-(?:ocr-)?layout\s+/g, ""));
    assert.ok(selectors.length);
    for (const selector of selectors) {
      assert.equal(document.querySelector("#table-row").matches(selector), false);
      assert.equal(document.querySelector("#nested-row").matches(selector), false);
      assert.equal(document.querySelector("#standard-row").matches(selector), true);
    }
  }
});

test("semantic hierarchy rejects malformed types, direct children and orphan rows/cells without repairing them", () => {
  const block = createVisualBlock("text");
  const leaf: VisualLayoutNode = { id: "leaf", type: "block", blockId: block.id };
  const cell: VisualLayoutNode = { id: "cell", type: "column", semantic: "tableCell", style: { alignment: "right" }, children: [leaf] };
  const row: VisualLayoutNode = { id: "row", type: "row", semantic: "tableRow", children: [cell] };
  const table: VisualLayoutNode = { id: "table", type: "column", semantic: "table", children: [row] };
  const doc: VisualPageDocument = { version: 1, blocks: [block], layout: table };
  assert.equal(visualDocumentSaveError(doc), null);
  const normalized = normalizeVisualDocument(doc);
  assert.equal(visualDocumentSaveError(normalized), null);
  const normalizedCell = flattenVisualLayout(normalized.layout).find((node) => node.id === "cell");
  assert.deepEqual(normalizedCell?.type !== "block" && normalizedCell?.style, { alignment: "right" });
  const invalid: VisualLayoutNode[] = [
    { ...table, type: "row" }, { ...table, children: [cell] }, { ...table, children: [leaf] },
    { ...table, children: [{ ...row, type: "column" }] },
    { ...table, children: [{ ...row, children: [leaf] }] },
    { ...table, children: [{ ...row, children: [{ ...cell, type: "row" }] }] },
    row, cell, { id: "ordinary", type: "column", children: [row] },
    { id: "ordinary", type: "column", children: [cell] },
    { ...table, children: [{ id: "wrapper", type: "column", children: [row] }] },
    { ...table, children: [{ ...row, children: [{ id: "wrapper", type: "column", children: [cell] }] }] },
    { id: "figure", type: "row", semantic: "figure", children: [leaf] }
  ];
  for (const layout of invalid) {
    assert.ok(visualDocumentSaveError({ ...doc, layout }), JSON.stringify(layout));
    assert.ok(visualDocumentSaveError(normalizeVisualDocument({ ...doc, layout })), "normalization must not erase invalid semantics");
  }
  assert.equal(visualDocumentSaveError({ ...doc, layout: { id: "figure", type: "column", semantic: "figure", children: [leaf] } }), null);
  assert.equal(visualDocumentSaveError({ ...doc, layout: { id: "ordinary", type: "row", children: [leaf] } }), null);
});

test("container alignment is preserved and marked for inheritance, while explicit block alignment stays inline", () => {
  const blocks = [createVisualBlock("text"), { ...createVisualBlock("text"), alignment: "right" as const }];
  const doc: VisualPageDocument = { version: 1, blocks, layout: { id: "aligned", type: "column", style: { alignment: "center" }, children: [{ id: "nested", type: "column", children: blocks.map((block) => ({ id: block.id, type: "block", blockId: block.id })) }] } };
  const normalized = normalizeVisualDocument(doc);
  const document = new JSDOM(renderVisualPreviewHtml(normalized)).window.document;
  assert.equal(document.querySelector('[data-text-align="center"]').style.textAlign, "center");
  assert.equal(document.querySelectorAll("p")[0].style.textAlign, "");
  assert.equal(document.querySelectorAll("p")[1].style.textAlign, "right");
  const css = readFileSync(new URL("../src/features/reader/reading-document.css", import.meta.url), "utf8");
  assert.match(css, /\[data-layout-id\]\[data-text-align\] p\[data-paragraph-number\]:not\(\[data-text-align\]\)\s*\{ text-align: inherit; \}/);
  const editorCss = readFileSync(new URL("../src/features/book-builder/visual-page.css", import.meta.url), "utf8");
  assert.match(editorCss, /\.visual-container\[data-text-align\] \.visual-atom-content p,[\s\S]*?\{ text-align: inherit; \}/);
  const editorSource = readFileSync(new URL("../src/features/book-builder/VisualPageEditor.tsx", import.meta.url), "utf8");
  const editor = ts.createSourceFile("editor.tsx", editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let renderer: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "renderNode") renderer = node;
    ts.forEachChild(node, visit);
  }
  visit(editor);
  assert.ok(renderer);
  const code = ts.transpileModule(renderer.getText(editor), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const bindings = { React, Fragment: React.Fragment, doc, renderVisualStyle, isCenteredFooterRow,
    showInactive: true, dragging: null, selectedId: null, disabled: false, endDrag() {}, PreviewIcon: () => null };
  const renderNode = new Function(...Object.keys(bindings), `${code}\nreturn renderNode;`)(...Object.values(bindings));
  const editorLayout: VisualLayoutNode = { id: "aligned", type: "column", style: { alignment: "center" }, children: [{ id: "right", type: "column", style: { alignment: "right" }, children: [] }, { id: "ordinary", type: "column", children: [] }] };
  const editorHtml = new JSDOM(renderToStaticMarkup(renderNode(editorLayout, true))).window.document;
  assert.equal(editorHtml.querySelector('[data-visual-node-id="aligned"]').getAttribute("data-text-align"), "center");
  assert.equal(editorHtml.querySelector('[data-visual-node-id="aligned"]').style.textAlign, "center");
  assert.equal(editorHtml.querySelector('[data-visual-node-id="right"]').getAttribute("data-text-align"), "right");
  assert.equal(editorHtml.querySelector('[data-visual-node-id="ordinary"]').hasAttribute("data-text-align"), false);
  const ordinary = { ...doc, layout: { ...doc.layout, style: undefined } } as VisualPageDocument;
  assert.doesNotMatch(renderVisualPreviewHtml(ordinary), /data-text-align=/);
});
