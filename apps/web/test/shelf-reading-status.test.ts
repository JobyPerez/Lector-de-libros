import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("shelf offers Guardado, renames Pendiente and defaults new forms to Guardado", () => {
  const source = readFileSync(new URL("../src/features/shelf/ShelfPage.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ShelfPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ["READING_STATUS_CONFIG", "emptyBookEditForm"].includes(declaration.name.getText(ast))));
  const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { statuses, form } = new Function(`${code}; return { statuses: READING_STATUS_CONFIG, form: emptyBookEditForm };`)();
  assert.deepEqual(statuses, [
    { id: "READING", label: "Leyendo" },
    { id: "WANT_TO_READ", label: "Me gustaría leer" },
    { id: "READ", label: "Terminado" },
    { id: "ABANDONED", label: "Abandonado" },
    { id: "SAVED", label: "Guardado" }
  ]);
  assert.equal(form.readingStatus, "SAVED");
});
