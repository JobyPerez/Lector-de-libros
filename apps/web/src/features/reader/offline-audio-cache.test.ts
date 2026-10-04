import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import type { ChapterAudioOfflinePlan } from "../../app/api";
import { invalidateOfflineBookAudioIfChanged, isOfflineAudioRevisionError, loadOfflineAudioBlockContaining, loadOfflineChapterAudioExport, normalizeContentRevision, saveChapterAudioBlock } from "./offline-audio-cache";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

const plan: ChapterAudioOfflinePlan = {
  blocks: [{ cachedCharacters: 0, missingCharacters: 10, paragraphCount: 1, startSequenceNumber: 2, totalCharacters: 10 }],
  cachedCharacters: 0, chapterId: "chapter", endSequenceNumber: 9, estimatedCostUsd: 0,
  missingCharacters: 10, startSequenceNumber: 2, title: "Chapter", totalCharacters: 10, voiceModel: "voice"
};

const block = {
  blob: new Blob(["new audio"]), paragraphCount: 1, startSequenceNumber: 2, nextSequenceNumber: null,
  paragraphs: [{ sequenceNumber: 2, pageNumber: 1, paragraphNumber: 2, paragraphId: "p-2", textLength: 9 }]
};

async function revisionRecords() {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lector-reader-audio-offline", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const request = database.transaction("revisions").objectStore("revisions").getAll();
    return await new Promise<Array<{ bookId: string; contentRevision: string }>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}

function staleRevision(error: unknown) {
  assert.ok(isOfflineAudioRevisionError(error));
  assert.equal(error.code, "OFFLINE_AUDIO_STALE_REVISION");
  return true;
}

test("shipped millisecond revisions and microsecond revisions compare by the same instant", async () => {
  const oldFormat = "2026-10-02T12:00:00.334Z";
  const newFormat = "2026-10-02T12:00:00.334000Z";
  assert.equal(normalizeContentRevision(oldFormat), newFormat);
  await invalidateOfflineBookAudioIfChanged("book", oldFormat);
  await saveChapterAudioBlock("book", plan, block, oldFormat);
  const exported = await loadOfflineChapterAudioExport("book", "chapter", "voice");
  await invalidateOfflineBookAudioIfChanged("book", newFormat);
  assert.deepEqual(await loadOfflineChapterAudioExport("book", "chapter", "voice"), exported);
  await invalidateOfflineBookAudioIfChanged("book", "2026-10-02T12:00:00.334001Z");
  await assert.rejects(invalidateOfflineBookAudioIfChanged("book", oldFormat), staleRevision);
});

test("offline blocks retain sparse actual paragraphs and optional cursor, never claim excluded gaps", async () => {
  const plan: ChapterAudioOfflinePlan = {
    blocks: [{ cachedCharacters: 0, missingCharacters: 10, paragraphCount: 2, startSequenceNumber: 2, totalCharacters: 10 }],
    cachedCharacters: 0, chapterId: "chapter", endSequenceNumber: 9, estimatedCostUsd: 0,
    missingCharacters: 10, startSequenceNumber: 2, title: "Chapter", totalCharacters: 10, voiceModel: "voice"
  };
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  const paragraphs = [2, 9].map((sequenceNumber) => ({ sequenceNumber, pageNumber: 1, paragraphNumber: sequenceNumber, paragraphId: `p-${sequenceNumber}`, textLength: 5 }));
  for (const cursor of [undefined, 17, null]) {
    await saveChapterAudioBlock("book", plan, { blob: new Blob(["audio"]), paragraphCount: 2, paragraphs, startSequenceNumber: 2, nextSequenceNumber: cursor }, "revision-1");
    const loaded = await loadOfflineAudioBlockContaining("book", "voice", 9);
    assert.deepEqual(loaded?.paragraphs, paragraphs);
    assert.equal(loaded?.nextSequenceNumber, cursor);
    assert.equal(await loadOfflineAudioBlockContaining("book", "voice", 3), null);
    assert.equal((await loadOfflineChapterAudioExport("book", "chapter", "voice"))?.blocks[0]?.nextSequenceNumber, cursor);
  }
  await invalidateOfflineBookAudioIfChanged("book", "revision-2");
  await assert.rejects(saveChapterAudioBlock("book", plan, { blob: new Blob(), paragraphCount: 2, paragraphs, startSequenceNumber: 2 }, "revision-1"));
  assert.equal(await loadOfflineAudioBlockContaining("book", "voice", 2), null);
});

for (const [older, newer] of [
  ["revision-1", "revision-2"],
  ["2026-10-02T12:00:00.000001Z", "2026-10-02T12:00:00.000002Z"]
]) {
  test(`older observation and stale save preserve newer cache (${newer})`, async () => {
    await invalidateOfflineBookAudioIfChanged("book", newer!);
    await saveChapterAudioBlock("book", plan, block, newer);
    const exported = await loadOfflineChapterAudioExport("book", "chapter", "voice");
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", older!), staleRevision);
    assert.deepEqual(await revisionRecords(), [{ bookId: "book", contentRevision: newer }]);
    assert.deepEqual(await loadOfflineChapterAudioExport("book", "chapter", "voice"), exported);
    assert.equal(await (await loadOfflineAudioBlockContaining("book", "voice", 2))?.blob.text(), "new audio");
    await assert.rejects(saveChapterAudioBlock("book", plan, { ...block, blob: new Blob(["old audio"]) }, older), staleRevision);
    assert.deepEqual(await loadOfflineChapterAudioExport("book", "chapter", "voice"), exported);
  });
}

test("same revision, including an older but still current revision, preserves all cached data", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  await saveChapterAudioBlock("book", plan, block, "revision-1");
  const exported = await loadOfflineChapterAudioExport("book", "chapter", "voice");
  await Promise.all(Array.from({ length: 3 }, () => invalidateOfflineBookAudioIfChanged("book", "revision-1")));
  assert.deepEqual(await loadOfflineChapterAudioExport("book", "chapter", "voice"), exported);
  assert.deepEqual(await revisionRecords(), [{ bookId: "book", contentRevision: "revision-1" }]);
});

for (const oldFirst of [true, false]) {
  test(`concurrent fresh and old observations cannot downgrade the cache (oldFirst=${oldFirst})`, async () => {
    const r1 = "2026-10-02T12:00:00.000001Z";
    const r2 = "2026-10-02T12:00:00.000002Z";
    const r3 = "2026-10-02T12:00:00.000003Z";
    await invalidateOfflineBookAudioIfChanged("book", r2);
    await saveChapterAudioBlock("book", plan, block, r2);
    const observeOld = () => assert.rejects(invalidateOfflineBookAudioIfChanged("book", r1), staleRevision);
    const observeFresh = async () => {
      await invalidateOfflineBookAudioIfChanged("book", r3);
      await saveChapterAudioBlock("book", plan, { ...block, blob: new Blob(["fresh audio"]) }, r3);
    };
    await Promise.all(oldFirst ? [observeOld(), observeFresh()] : [observeFresh(), observeOld()]);
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", r2), staleRevision);
    await assert.rejects(saveChapterAudioBlock("book", plan, block, r2), staleRevision);
    assert.deepEqual(await revisionRecords(), [{ bookId: "book", contentRevision: r3 }]);
    assert.equal(await (await loadOfflineAudioBlockContaining("book", "voice", 2))?.blob.text(), "fresh audio");
  });
}

test("unknown or empty revisions reject without writing or opening storage", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-2");
  await saveChapterAudioBlock("book", plan, block, "revision-2");
  const exported = await loadOfflineChapterAudioExport("book", "chapter", "voice");
  for (const revision of ["", "   "]) {
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", revision), staleRevision);
  }
  assert.deepEqual(await revisionRecords(), [{ bookId: "book", contentRevision: "revision-2" }]);
  assert.deepEqual(await loadOfflineChapterAudioExport("book", "chapter", "voice"), exported);
  const database = globalThis.indexedDB;
  Reflect.deleteProperty(globalThis, "indexedDB");
  try {
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", ""), staleRevision);
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", "revision-2"), (error: unknown) => {
      assert.equal(isOfflineAudioRevisionError(error), false);
      return true;
    });
  } finally { globalThis.indexedDB = database; }
});
