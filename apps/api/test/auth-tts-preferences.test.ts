import assert from "node:assert/strict";
import test from "node:test";

import { updateProfileSchema } from "../src/modules/auth/auth.routes.js";

const baseProfile = {
  email: "lector@example.com"
};

test("el perfil acepta preferencias TTS independientes para español e italiano", () => {
  const profile = updateProfileSchema.parse({
    ...baseProfile,
    deepgramTtsModel: "aura-2-carina-es",
    deepgramTtsModelIt: "aura-2-livia-it"
  });

  assert.equal(profile.deepgramTtsModel, "aura-2-carina-es");
  assert.equal(profile.deepgramTtsModelIt, "aura-2-livia-it");
});

test("el perfil no permite guardar una voz italiana como preferencia española", () => {
  assert.equal(updateProfileSchema.safeParse({
    ...baseProfile,
    deepgramTtsModel: "aura-2-livia-it"
  }).success, false);
});
