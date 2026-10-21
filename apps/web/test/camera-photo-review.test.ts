import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("BookBuilderPage.tsx", readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function handler(name: string, bindings: Record<string, unknown>) {
  let declaration: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, name);
  const js = ts.transpileModule(`${declaration.getText(source)}\nreturn ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

for (const target of ["create", "append"] as const) {
  const label = target === "create" ? "Create" : "Append";
  test(`${target}: capture waits for review; accepting batches only confirmed photos and closing excludes the pending one`, () => {
    const previous = new File(["previous"], "previous.jpg", { type: "image/jpeg" });
    const state = { pending: null as File | null, accepted: [previous], capturing: false };
    const imported: File[][] = [];
    const video = { videoWidth: 1200, videoHeight: 1600 };
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["new photo"], { type: "image/jpeg" }))
    };
    const bindings = () => ({
      pendingCameraPhoto: state.pending,
      cameraCapturedFiles: state.accepted,
      isMultipleCameraCapture: true,
      [`is${label}CameraCapturing`]: state.capturing,
      [`${target}CameraVideoRef`]: { current: video },
      [`${target}CameraCanvasRef`]: { current: canvas },
      [`setIs${label}CameraCapturing`]: (value: boolean) => { state.capturing = value; },
      [`set${label}Error`]: (value: unknown) => { assert.equal(value, null); },
      setPendingCameraPhoto: (value: File | null) => { state.pending = value; },
      setCameraCapturedFiles: (value: File[] | ((files: File[]) => File[])) => {
        state.accepted = typeof value === "function" ? value(state.accepted) : value;
      },
      [`${target}Files`]: (files: File[]) => imported.push(files),
      [`setIs${label}CameraStarting`]: () => {},
      [`setIs${label}CameraModalOpen`]: () => {},
      [`stop${label}CameraStream`]: () => {},
      File
    });

    handler(`handleCapture${label}CameraFrame`, bindings())();
    assert.ok(state.pending);
    assert.equal(state.pending.type, "image/jpeg");
    assert.deepEqual(state.accepted, [previous]);
    assert.deepEqual(imported, []);
    assert.equal(state.capturing, false);
    const confirmed = state.pending;
    handler("confirmCameraPhoto", bindings())(target);
    assert.equal(state.pending, null);
    assert.deepEqual(state.accepted, [previous, confirmed]);
    assert.deepEqual(imported, []);

    handler(`handleCapture${label}CameraFrame`, bindings())();
    assert.ok(state.pending);
    handler(`close${label}CameraModal`, bindings())();
    assert.deepEqual(imported, [[previous, confirmed]]);
    assert.equal(state.pending, null);
    assert.deepEqual(state.accepted, []);
  });

  test(`${target}: single-photo acceptance imports only the reviewed photo and closes`, () => {
    const file = new File(["photo"], "photo.jpg");
    const imported: File[][] = [];
    let closed = 0;
    handler("confirmCameraPhoto", {
      pendingCameraPhoto: file,
      isMultipleCameraCapture: false,
      [`${target}Files`]: (files: File[]) => imported.push(files),
      [`close${label}CameraModal`]: () => { closed++; }
    })(target);
    assert.deepEqual(imported, [[file]]);
    assert.equal(closed, 1);
  });
}
