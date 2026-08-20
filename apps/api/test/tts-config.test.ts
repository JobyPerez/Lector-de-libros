import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { TTS_LANGUAGE_CATALOG } from "../src/config/env.js";
import { registerTtsRoutes, resolveTtsVoiceModel } from "../src/modules/tts/tts.routes.js";

const preferences = {
  deepgramTtsModel: "aura-2-nestor-es",
  deepgramTtsModelIt: "aura-2-livia-it"
};

test("el catálogo TTS incluye español e italiano con Livia como voz italiana predeterminada", () => {
  const italian = TTS_LANGUAGE_CATALOG.find((language) => language.languageCode === "it");

  assert.equal(italian?.locale, "it-IT");
  assert.equal(italian?.defaultVoiceModel, "aura-2-livia-it");
  assert.ok(italian?.voices.some((voice) => voice.model === "aura-2-cesare-it"));
  assert.ok(TTS_LANGUAGE_CATALOG.every((language) => (
    language.voices.every((voice) => voice.languageCode === language.languageCode && Boolean(voice.label) && Boolean(voice.locale))
  )));
});

test("la voz se resuelve con la preferencia correspondiente al idioma del libro", () => {
  assert.deepEqual(resolveTtsVoiceModel("es-ES", undefined, preferences), {
    languageCode: "es",
    voiceModel: "aura-2-nestor-es"
  });
  assert.deepEqual(resolveTtsVoiceModel("IT_it", undefined, preferences), {
    languageCode: "it",
    voiceModel: "aura-2-livia-it"
  });
});

test("una voz de otro idioma se rechaza antes de sintetizar", () => {
  assert.throws(
    () => resolveTtsVoiceModel("it", "aura-2-nestor-es", preferences),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 422
  );
});

test("GET /tts/config publica idiomas, voces y valores predeterminados", async () => {
  const app = Fastify();
  await app.register(registerTtsRoutes);

  const response = await app.inject({ method: "GET", url: "/tts/config" });
  const payload = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.defaults.it, "aura-2-livia-it");
  assert.equal(payload.languages.length, 2);

  await app.close();
});
