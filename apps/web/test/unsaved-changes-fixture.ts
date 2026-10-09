import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as router from "react-router-dom";
import type * as Confirmation from "../src/components/confirmUnsavedChanges";
import type * as Navigation from "../src/hooks/useUnsavedChanges";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

export function loadTestModule(path: string, mocks: Record<string, unknown> = {}, transform = (source: string) => source) {
  const source = transform(readFileSync(new URL(path, import.meta.url), "utf8"));
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  // Keep transpiled CommonJS modules on the same router contexts as the ESM test renderer.
  new Function("exports", "require", code)(exports, (id: string) => Object.hasOwn(mocks, id) ? mocks[id] : id === "react-router-dom" ? router : require(id));
  return exports;
}

export function loadUnsavedChanges() {
  const confirmation = loadTestModule("../src/components/confirmUnsavedChanges.ts") as typeof Confirmation;
  const navigation = loadTestModule("../src/hooks/useUnsavedChanges.ts", { "../components/confirmUnsavedChanges": confirmation }) as typeof Navigation;
  return { ...confirmation, ...navigation };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function withUnsavedDom(run: (fixture: { document: Document; window: Window & typeof globalThis; root: ReturnType<typeof createRoot>; button: (label: string) => HTMLButtonElement }) => Promise<void>) {
  const dom = new JSDOM("<button id='origin'>Origin</button><div id='root'></div>", { url: "http://synthetic.invalid" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // jsdom lacks native modal dialogs; Escape is represented by the browser's cancel event.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector("[autofocus]")?.focus(); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find((node: HTMLButtonElement) => node.textContent === label || node.getAttribute("aria-label") === label)!;
  try {
    await run({ document: dom.window.document, window: dom.window, root, button });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
