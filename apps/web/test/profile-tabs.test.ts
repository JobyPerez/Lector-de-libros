import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/profile/ProfilePage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ProfilePage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ts.transpileModule(
  ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join("\n")
    .replaceAll("export function", "function")
    .replaceAll("export type", "type"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
  }
).outputText;

function createHarness(hash = "") {
  const storeState = {
    accessToken: "token-123",
    refreshToken: "refresh-123",
    user: {
      userId: "u-1",
      username: "lector",
      email: "lector@example.com",
      displayName: "Ana Lectora",
      role: "ADMIN",
      aiCredentials: {
        hasAwsCredentials: true,
        usingSharedOpencode: true,
        sharedOpencodeBy: "admin",
        hasGeminiApiKey: false,
        hasDeepgramApiKey: true
      }
    }
  };

  return new Function(
    "React",
    "useEffect",
    "useRef",
    "useState",
    "useQuery",
    "Link",
    "Navigate",
    "useLocation",
    "changeCurrentUserPassword",
    "fetchCurrentUser",
    "updateCurrentUserProfile",
    "useAuthStore",
    "AVAILABLE_MODES",
    "AVAILABLE_PALETTES",
    "useTheme",
    "PasswordInput",
    `${code}; return { ProfilePage, resolveProfileTabFromHash };`
  )(
    React,
    React.useEffect,
    React.useRef,
    React.useState,
    () => ({ data: { user: storeState.user }, isLoading: false, refetch: async () => ({}) }),
    ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) =>
      React.createElement("a", { href: to, className }, children),
    ({ to }: { to: string }) => React.createElement("div", { "data-navigate": to }),
    () => ({ hash }),
    async () => ({ message: "ok" }),
    async () => ({ user: storeState.user }),
    async () => ({ user: storeState.user }),
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    [{ id: "light", label: "Claro", description: "Luz", icon: "☀️" }],
    [{ id: "default", name: "Bosque", subtitle: "Clásico", description: "Cálido", previewColors: ["#111", "#222"] }],
    () => ({
      mode: "light",
      palette: "default",
      effectiveMode: "light",
      saveStatus: "idle",
      setMode: async () => {},
      setPalette: async () => {}
    }),
    (props: Record<string, unknown>) => React.createElement("input", { ...props, type: "password" })
  );
}

test("resolveProfileTabFromHash mapea correctamente los hashes de URL a las pestañas del perfil", () => {
  const { resolveProfileTabFromHash } = createHarness();
  assert.equal(resolveProfileTabFromHash(""), "appearance");
  assert.equal(resolveProfileTabFromHash("#appearance"), "appearance");
  assert.equal(resolveProfileTabFromHash("#account"), "account");
  assert.equal(resolveProfileTabFromHash("#datos"), "account");
  assert.equal(resolveProfileTabFromHash("#password"), "password");
  assert.equal(resolveProfileTabFromHash("#seguridad"), "password");
  assert.equal(resolveProfileTabFromHash("#ai"), "ai");
  assert.equal(resolveProfileTabFromHash("#ia"), "ai");
  assert.equal(resolveProfileTabFromHash("#desconocido"), "appearance");
});

test("ProfilePage muestra las 4 pestañas horizontales y renderiza únicamente el panel activo según el hash", () => {
  for (const [hash, expectedPanelId, expectedHeading] of [
    ["", "profile-tabpanel-appearance", "Apariencia y tema"],
    ["#account", "profile-tabpanel-account", "Información de la cuenta"],
    ["#password", "profile-tabpanel-password", "Cambiar contraseña"],
    ["#ai", "profile-tabpanel-ai", "Claves y modelos"]
  ] as const) {
    const { ProfilePage } = createHarness(hash);
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(ProfilePage)));
    try {
      const document = dom.window.document;
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim());
      assert.deepEqual(tabs, ["Apariencia", "Datos personales", "Seguridad", "Inteligencia artificial"]);

      const panels = [...document.querySelectorAll('[role="tabpanel"]')];
      assert.equal(panels.length, 1, `solo debe renderizarse un panel activo para hash "${hash}"`);
      assert.equal(panels[0]?.id, expectedPanelId);
      assert.equal(panels[0]?.querySelector("h3")?.textContent, expectedHeading);
    } finally {
      dom.window.close();
    }
  }
});
