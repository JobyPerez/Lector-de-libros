import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, loadUnsavedChanges, withUnsavedDom } from "./unsaved-changes-fixture";

test("confirmation has exactly Volver, Salir sin guardar, Salir guardando; back/discard restore focus without saving", async () => {
  await withUnsavedDom(async ({ document, button }) => {
    const { confirmUnsavedChanges } = loadUnsavedChanges();
    for (const [label, allowed] of [["Volver", false], ["Salir sin guardar", true]] as const) {
      const origin = document.getElementById("origin")!;
      origin.focus();
      const decision = confirmUnsavedChanges({ save: () => assert.fail("must not save"), message: "Custom message" });
      const dialog = document.querySelector("dialog")!;
      assert.deepEqual([...dialog.querySelectorAll("button")].map((node) => node.textContent), ["Volver", "Salir sin guardar", "Salir guardando"]);
      assert.equal(dialog.getAttribute("aria-label"), "Cambios sin guardar");
      assert.equal(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent, "Custom message");
      assert.equal(document.activeElement, button("Volver"));
      button(label).click();
      assert.equal(await decision, allowed);
      assert.equal(document.querySelector("dialog"), null);
      assert.equal(document.activeElement, origin);
    }
  });
});

test("async saving resolves true only on success, blocks all actions and Escape, and calls save once", async () => {
  await withUnsavedDom(async ({ document, window, button }) => {
    const { confirmUnsavedChanges } = loadUnsavedChanges();
    for (const outcome of ["success", "failure", "reject", "throw"] as const) {
      const save = deferred<boolean>();
      let calls = 0;
      const decision = confirmUnsavedChanges({ save: () => {
        calls++;
        if (outcome === "throw") throw new Error("save threw");
        return save.promise;
      } });
      const dialog = document.querySelector("dialog")!;
      const buttons = [...dialog.querySelectorAll("button")];
      button("Salir guardando").click();
      if (outcome !== "throw") {
        assert.ok(buttons.every((node) => node.disabled));
        assert.equal(dialog.getAttribute("aria-busy"), "true");
        assert.equal(buttons[2]!.textContent, "Guardando...");
        for (const node of buttons) node.click();
        const cancel = new window.Event("cancel", { cancelable: true });
        dialog.dispatchEvent(cancel);
        assert.equal(cancel.defaultPrevented, true);
        let settled = false;
        void decision.then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(document.querySelector("dialog"), dialog);
        if (outcome === "reject") save.reject(new Error("async save failed"));
        else save.resolve(outcome === "success");
      }
      assert.equal(await decision, outcome === "success");
      assert.equal(calls, 1);
      assert.equal(document.querySelector("dialog"), null);
    }
  });
});

test("Escape cancels; concurrent confirmations return false rather than sharing permission", async () => {
  await withUnsavedDom(async ({ document, window, button }) => {
    const { confirmUnsavedChanges } = loadUnsavedChanges();
    const first = confirmUnsavedChanges({ save: () => assert.fail("must not save") });
    const concurrent = confirmUnsavedChanges({ save: () => assert.fail("must not save") });
    assert.equal(await concurrent, false);
    assert.equal(document.querySelectorAll("dialog").length, 1);
    const cancel = new window.Event("cancel", { cancelable: true });
    document.querySelector("dialog")!.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(await first, false);
    assert.equal(document.querySelector("dialog"), null);
    const allowed = confirmUnsavedChanges({ save: () => assert.fail("must not save") });
    assert.equal(await confirmUnsavedChanges({ save: () => true }), false);
    button("Salir sin guardar").click();
    assert.equal(await allowed, true, "only the original request receives permission to leave");
  });
});

test("unavailable saving disables only save and explains why; modal unavailable fails closed and releases the lock", async () => {
  await withUnsavedDom(async ({ document, window, button }) => {
    const { confirmUnsavedChanges } = loadUnsavedChanges();
    for (const unavailableReason of [undefined, "Server conflict"]) {
      const decision = confirmUnsavedChanges({ canSave: false, unavailableReason, save: () => assert.fail("unavailable save") });
      assert.equal(button("Salir guardando").disabled, true);
      assert.equal(button("Volver").disabled, false);
      assert.equal(button("Salir sin guardar").disabled, false);
      assert.equal(document.querySelector(".helper-text")!.textContent, unavailableReason ?? "No se pueden guardar los cambios en este momento.");
      button("Salir guardando").click();
      button("Salir sin guardar").click();
      assert.equal(await decision, true);
    }
    const prototype = (window as any).HTMLDialogElement.prototype;
    const showModal = prototype.showModal;
    prototype.showModal = () => { throw new Error("modal unavailable"); };
    assert.equal(await confirmUnsavedChanges({ save: () => true }), false);
    assert.equal(document.querySelector("dialog"), null);
    prototype.showModal = showModal;
    const next = confirmUnsavedChanges({ save: () => true });
    button("Salir guardando").click();
    assert.equal(await next, true);
  });
});
