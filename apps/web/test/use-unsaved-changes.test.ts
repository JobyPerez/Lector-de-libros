import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { deferred, loadTestModule, loadUnsavedChanges, withUnsavedDom } from "./unsaved-changes-fixture";

test("pending navigation awaits all async guards, vetoes false and unregisters listeners", async () => {
  await withUnsavedDom(async () => {
    const { confirmPendingNavigation, registerPendingNavigation } = loadUnsavedChanges();
    assert.equal(await confirmPendingNavigation(), true);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let calls = 0;
    const removeFirst = registerPendingNavigation(() => { calls++; return first.promise; });
    const removeSecond = registerPendingNavigation(() => { calls++; return second.promise; });
    const decision = confirmPendingNavigation();
    assert.equal(calls, 2);
    let settled = false;
    void decision.then(() => { settled = true; });
    first.resolve(true);
    await Promise.resolve();
    assert.equal(settled, false);
    second.resolve(false);
    assert.equal(await decision, false);
    removeSecond();
    assert.equal(await confirmPendingNavigation(), true);
    removeFirst();
    assert.equal(await confirmPendingNavigation(), true);
    assert.equal(calls, 3);
  });
});

test("hook uses latest dirty/save options after rerenders and removes navigation/beforeunload listeners", async () => {
  await withUnsavedDom(async ({ root, window, document, button }) => {
    const hooks = loadUnsavedChanges();
    let confirm!: () => Promise<boolean>;
    let latestCalls = 0;
    let update!: React.Dispatch<React.SetStateAction<boolean>>;
    function Form() {
      const [dirty, setDirty] = React.useState(false);
      update = setDirty;
      confirm = hooks.useUnsavedChanges(dirty, { save: dirty ? async () => { latestCalls++; return true; } : () => assert.fail("stale save") });
      return null;
    }
    const router = createMemoryRouter([{ path: "*", element: React.createElement(Form) }]);
    try {
      await act(async () => root.render(React.createElement(RouterProvider, { router })));
      assert.equal(await confirm(), true);
      assert.equal(await hooks.confirmPendingNavigation(), true);
      const beforeUnload = () => { const event = new window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
      assert.equal(beforeUnload(), false);
      await act(async () => update(true));
      assert.equal(beforeUnload(), true);
      const decision = hooks.confirmPendingNavigation();
      button("Salir guardando").click();
      assert.equal(await decision, true);
      assert.equal(latestCalls, 1);
      await act(async () => update(false));
      assert.equal(beforeUnload(), false);
      assert.equal(await confirm(), true);
      await act(async () => update(true));
      await act(async () => root.unmount());
      assert.equal(beforeUnload(), false);
      assert.equal(await hooks.confirmPendingNavigation(), true);
      assert.equal(document.querySelector("dialog"), null);
    } finally { router.dispose(); }
  });
});

test("real router blocks pathname/search/hash, cancels or proceeds, and preserves destination across saving rerenders", async () => {
  for (const destination of ["/next", "/form?next=1", "/form#next"]) {
    for (const outcome of ["back", "discard", "save", "failure", "reject"] as const) {
      await withUnsavedDom(async ({ root, document, button }) => {
        const { useUnsavedChanges } = loadUnsavedChanges();
        const saving = deferred<boolean>();
        let setDirty!: React.Dispatch<React.SetStateAction<boolean>>;
        let saveCalls = 0;
        function Form() {
          const [dirty, updateDirty] = React.useState(true);
          const [busy, setBusy] = React.useState(false);
          setDirty = updateDirty;
          useUnsavedChanges(dirty, { canSave: !busy, save: async () => {
            saveCalls++;
            setBusy(true);
            const result = await saving.promise;
            if (result) updateDirty(false);
            setBusy(false);
            return result;
          } });
          return React.createElement("p", null, busy ? "Saving form" : "Form");
        }
        const router = createMemoryRouter([{ path: "*", element: React.createElement(Form) }], { initialEntries: ["/form"] });
        try {
          await act(async () => root.render(React.createElement(RouterProvider, { router })));
          await act(async () => router.navigate("/form"));
          assert.equal(document.querySelector("dialog"), null, "same URL is not blocked");
          await act(async () => router.navigate(destination));
          assert.equal(router.state.location.pathname, "/form");
          assert.equal(document.querySelectorAll("dialog").length, 1);
          if (outcome === "back" || outcome === "discard") {
            await act(async () => button(outcome === "back" ? "Volver" : "Salir sin guardar").click());
          } else {
            await act(async () => button("Salir guardando").click());
            assert.match(document.body.textContent!, /Saving form/);
            assert.equal(document.querySelectorAll("dialog").length, 1);
            await act(async () => setDirty(false));
            assert.equal(router.state.location.pathname + router.state.location.search + router.state.location.hash, "/form");
            await act(async () => {
              if (outcome === "reject") saving.reject(new Error("failed save"));
              else saving.resolve(outcome === "save");
            });
          }
          const allowed = outcome === "discard" || outcome === "save";
          assert.equal(router.state.location.pathname + router.state.location.search + router.state.location.hash, allowed ? destination : "/form");
          assert.equal(saveCalls, ["save", "failure", "reject"].includes(outcome) ? 1 : 0);
          assert.equal(document.querySelector("dialog"), null);
        } finally { router.dispose(); }
      });
    }
  }
});

test("unmounted hook does not proceed a blocked route after async save finishes", async () => {
  await withUnsavedDom(async ({ root, button }) => {
    const { useUnsavedChanges } = loadUnsavedChanges();
    const save = deferred<boolean>();
    function Form() { useUnsavedChanges(true, { save: () => save.promise }); return null; }
    const router = createMemoryRouter([{ path: "*", element: React.createElement(Form) }], { initialEntries: ["/form"] });
    try {
      await act(async () => root.render(React.createElement(RouterProvider, { router })));
      await act(async () => router.navigate("/next"));
      await act(async () => button("Salir guardando").click());
      await act(async () => root.unmount());
      await act(async () => save.resolve(true));
      assert.equal(router.state.location.pathname, "/form");
    } finally { router.dispose(); }
  });
});

test("ProtectedShell logout waits for async save and clears session only when confirmed", async () => {
  for (const outcome of ["back", "discard", "save", "failure", "reject"] as const) {
    await withUnsavedDom(async ({ root, button, document }) => {
      const hooks = loadUnsavedChanges();
      const save = deferred<boolean>();
      let cleared = 0;
      const state = { accessToken: "token", isHydrated: true, user: { username: "tester", email: "test@example.invalid", role: "EDITOR" }, clearSession: () => { cleared++; } };
      const { ProtectedShell } = loadTestModule("../src/app/router.tsx", {
        "./auth-store": { useAuthStore: (selector: (value: typeof state) => unknown) => selector(state) },
        "./api": {},
        "../hooks/useUnsavedChanges": hooks,
        "virtual:pwa-register": {},
        "../components/RabbitMark": { RabbitMark: () => null },
        ...Object.fromEntries(["auth/LoginPage", "ai-settings/AiSettingsPage", "book-builder/BookBuilderPage", "book-pages/BookPagesGallery", "profile/ProfilePage", "reader/AiRequestsPage", "reader/ReaderPage", "auth/ResetPasswordPage", "search/SearchPage", "shelf/ShelfPage", "users/UsersAdminPage"].map((path) => [`../features/${path}`, {}])),
        "./theme-provider": {}
      }, (source) => source.slice(0, source.indexOf("const router = createBrowserRouter"))
        .replace("import.meta.env.BASE_URL", '"/"')
        .replaceAll("__APP_VERSION__", '"test"').replaceAll("__APP_BRANCH__", '""').replaceAll("__APP_BUILD_TIME__", '"2026-01-01"').replaceAll("__APP_RECENT_COMMITS__", "[]")
        + "\nexport { ProtectedShell };\n");
      function Form() { hooks.useUnsavedChanges(true, { save: () => save.promise }); return React.createElement("p", null, "Unsaved form"); }
      const router = createMemoryRouter([{ element: React.createElement(ProtectedShell), children: [{ path: "/form", element: React.createElement(Form) }] }], { initialEntries: ["/form"] });
      try {
        await act(async () => root.render(React.createElement(RouterProvider, { router })));
        await act(async () => button("Abrir menú de perfil").click());
        await act(async () => button("Cerrar sesión").click());
        assert.equal(cleared, 0);
        assert.equal(document.querySelectorAll("dialog").length, 1);
        if (outcome === "back" || outcome === "discard") {
          await act(async () => button(outcome === "back" ? "Volver" : "Salir sin guardar").click());
        } else {
          await act(async () => button("Salir guardando").click());
          assert.equal(cleared, 0, "session must survive until saving settles");
          await act(async () => {
            if (outcome === "reject") save.reject(new Error("save failed")); else save.resolve(outcome === "save");
          });
        }
        assert.equal(cleared, outcome === "save" || outcome === "discard" ? 1 : 0);
        assert.equal(document.querySelector("dialog"), null);
      } finally { router.dispose(); }
    });
  }
});
