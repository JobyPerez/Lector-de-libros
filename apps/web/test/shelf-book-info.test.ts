import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("book information opens as a modal, returns to its cover and restores focus and scrolling", async () => {
  const dom = new JSDOM("<button id='trigger'>Información</button><div id='cover'></div><div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true }) });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const source = readFileSync(new URL("../src/features/shelf/BookInfoDialog.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("BookInfoDialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node));
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(ast).replace("export function", "function"), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const Dialog = new Function("React", "useLayoutEffect", "useRef", "useState", "createPortal", `${code}; return BookInfoDialog;`)(React, useLayoutEffect, useRef, useState, createPortal);
  const trigger = dom.window.document.getElementById("trigger")!;
  const origin = dom.window.document.getElementById("cover")!;
  origin.getBoundingClientRect = () => ({ left: 100, top: 200, width: 120, height: 180 } as DOMRect);
  const root = createRoot(dom.window.document.getElementById("root")!);
  let closed = 0;
  const render = async () => {
    trigger.focus();
    await act(async () => root.render(React.createElement(Dialog, {
      title: "Libro de prueba", origin, cover: React.createElement("span", null, "Portada"),
      onClose: () => { closed++; root.render(null); }
    }, React.createElement("p", null, "Información completa"))));
  };
  try {
    for (const method of ["button", "escape", "outside"]) {
      await render();
      const dialog = dom.window.document.querySelector("dialog")!;
      assert.equal(dialog.open, true);
      assert.equal(dialog.getAttribute("aria-label"), "Información de Libro de prueba");
      assert.equal(dom.window.document.body.style.overflow, "hidden");
      assert.equal(dom.window.document.querySelector(".shelf-book-info-flight")?.getAttribute("style")?.includes("--book-offset-x: 160px"), true);
      await act(async () => {
        if (method === "button") dialog.querySelector("button")!.click();
        else if (method === "escape") dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
        else dialog.click();
      });
      assert.equal(dialog.dataset.closing, "true");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      assert.equal(dom.window.document.querySelector("dialog"), null);
      assert.equal(dom.window.document.body.style.overflow, "");
      assert.equal(dom.window.document.activeElement, trigger);
    }
    assert.equal(closed, 3);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
