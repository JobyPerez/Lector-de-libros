import assert from "node:assert/strict";
import test from "node:test";

import { externalizeContentImages, hydrateContentImages } from "../src/modules/books/content-images.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("externaliza y deduplica una imagen en todos los strings de una pagina", () => {
  const dataUri = `data:image/png;base64,${onePixelPng}`;
  const result = externalizeContentImages([
    `<img src="${dataUri}">`,
    `![pixel](${dataUri})`,
    dataUri,
    `antes ${dataUri} despues`
  ]);

  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0]?.assetId ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(result.assets[0]?.mimeType, "image/png");
  assert.equal(result.assets[0]?.buffer.toString("base64"), onePixelPng);
  assert.equal(result.assets[0]?.checksum.length, 64);
  for (const content of result.contents) {
    assert.ok(content.includes(result.assets[0]?.reference ?? "missing"));
    assert.ok(!content.includes("data:image"));
  }
});

test("diferencia contenido o MIME y reemplaza todas las apariciones", () => {
  const first = `data:image/png;base64,${Buffer.from("first").toString("base64")}`;
  const second = `data:image/webp;base64,${Buffer.from("second").toString("base64")}`;
  const result = externalizeContentImages([`${first}|${second}|${first}`]);

  assert.equal(result.assets.length, 2);
  assert.equal(result.contents[0]?.split(result.assets[0]?.reference ?? "missing").length, 3);
});

test("ignora MIME no permitidos, base64 invalido y referencias existentes", () => {
  const existing = "lector-content-image:123e4567-e89b-42d3-a456-426614174000";
  const contents = [
    "data:image/bmp;base64,Qk0AAAAA",
    "data:image/png;base64,not-valid=",
    existing
  ];

  assert.deepEqual(externalizeContentImages(contents), { assets: [], contents });
});

test("hidrata referencias conocidas y conserva las desconocidas", () => {
  const result = externalizeContentImages([`data:image/png;base64,${onePixelPng}`]);
  const asset = result.assets[0];
  assert.ok(asset);
  const unknown = "lector-content-image:123e4567-e89b-42d3-a456-426614174000";
  const hydrated = hydrateContentImages(`${asset.reference}|${unknown}`, new Map([
    [asset.assetId, { buffer: asset.buffer, mimeType: asset.mimeType }]
  ]));

  assert.equal(hydrated, `data:image/png;base64,${onePixelPng}|${unknown}`);
});
