import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import type { ChapterAudioOfflinePlan } from "../src/app/api";
import {
  getOfflineChapterAudioStatus,
  invalidateOfflineBookAudioIfChanged,
  loadOfflineAudioBlockContaining,
  loadOfflineChapterAudioExport,
  saveChapterAudioBlock
} from "../src/features/reader/offline-audio-cache";

const { IDBFactory, IDBCursor } = createRequire(import.meta.url)("fake-indexeddb");
const databaseName = "lector-reader-audio-offline";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

function open(version = 2) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("manifests", { keyPath: "key" });
      request.result.createObjectStore("blocks", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function records(store: string) {
  const database = await open();
  try {
    const request = database.transaction(store).objectStore(store).getAll();
    return await new Promise<any[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function save(bookId = "book", chapterId = "chapter", voiceModel = "voice", expectedRevision?: string, startSequenceNumber = 1) {
  const plan: ChapterAudioOfflinePlan = {
    blocks: [{ cachedCharacters: 0, missingCharacters: 10, paragraphCount: 1, startSequenceNumber: 1, totalCharacters: 10 }],
    cachedCharacters: 0,
    chapterId,
    endSequenceNumber: 1,
    estimatedCostUsd: 0,
    missingCharacters: 10,
    startSequenceNumber: 1,
    title: "Chapter",
    totalCharacters: 10,
    voiceModel
  };
  await saveChapterAudioBlock(bookId, plan, {
    blob: new Blob(["audio"]),
    paragraphCount: 1,
    paragraphs: [{ pageNumber: 1, paragraphId: `paragraph-${startSequenceNumber}`, paragraphNumber: startSequenceNumber, sequenceNumber: startSequenceNumber, textLength: 10 }],
    startSequenceNumber
  }, expectedRevision);
}

test("a stale download cannot repopulate audio after another connection invalidates its revision", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  await save("book", "chapter", "voice", "revision-1");
  await invalidateOfflineBookAudioIfChanged("book", "revision-2");

  await assert.rejects(save("book", "chapter", "voice", "revision-1"), /revisión.*cambió/);
  assert.deepEqual(await records("manifests"), []);
  assert.deepEqual(await records("blocks"), []);
  assert.deepEqual(await records("revisions"), [{ bookId: "book", contentRevision: "revision-2" }]);
  assert.equal(await loadOfflineAudioBlockContaining("book", "voice", 1), null);

  await save("book", "chapter", "voice", "revision-2", 2);
  await assert.rejects(save("book", "chapter", "voice", "revision-1"), /revisión.*cambió/);
  assert.deepEqual((await records("manifests"))[0].blockKeys, ["book|chapter|voice|2|1"]);
  assert.deepEqual((await records("blocks")).map((block) => block.startSequenceNumber), [2]);
});

test("concurrent saves preserve every manifest block key", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  await Promise.all([1, 2, 3].map((sequence) => save("book", "chapter", "voice", "revision-1", sequence)));

  const manifests = await records("manifests");
  assert.equal(manifests.length, 1);
  assert.deepEqual(manifests[0].blockKeys.slice().sort(), [1, 2, 3].map((sequence) => `book|chapter|voice|${sequence}|1`));
  assert.equal((await getOfflineChapterAudioStatus("book", "chapter", "voice"))?.blockCount, 3);
  assert.deepEqual((await loadOfflineChapterAudioExport("book", "chapter", "voice"))?.blocks.map((block) => block.startSequenceNumber), [1, 2, 3]);
});

test("v1 migration clears only the first observed book, including orphaned blocks", async () => {
  const database = await open(1);
  const transaction = database.transaction(["manifests", "blocks"], "readwrite");
  for (const bookId of ["book", "other"]) {
    transaction.objectStore("manifests").put({ key: `${bookId}|legacy`, bookId });
    transaction.objectStore("blocks").put({ key: `${bookId}|orphan`, bookId });
  }
  await done(transaction);
  database.close();

  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  assert.deepEqual(await records("manifests"), [{ key: "other|legacy", bookId: "other" }]);
  assert.deepEqual(await records("blocks"), [{ key: "other|orphan", bookId: "other" }]);
  assert.deepEqual(await records("revisions"), [{ bookId: "book", contentRevision: "revision-1" }]);
});

test("same revision preserves audio; a changed revision clears all chapters and voices only for that book", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  await save();
  await save("book", "second-chapter", "second-voice");
  await save("other");
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  assert.equal((await records("blocks")).length, 3);
  assert.equal((await getOfflineChapterAudioStatus("book", "chapter", "voice"))?.isComplete, true);
  assert.ok(await loadOfflineAudioBlockContaining("book", "voice", 1));
  assert.equal((await loadOfflineChapterAudioExport("book", "chapter", "voice"))?.blocks.length, 1);

  await invalidateOfflineBookAudioIfChanged("book", "revision-2");
  assert.equal(await getOfflineChapterAudioStatus("book", "chapter", "voice"), null);
  assert.equal(await loadOfflineAudioBlockContaining("book", "voice", 1), null);
  assert.equal(await loadOfflineChapterAudioExport("book", "chapter", "voice"), null);
  assert.deepEqual((await records("blocks")).map((block) => block.bookId), ["other"]);
  assert.deepEqual((await records("manifests")).map((manifest) => manifest.bookId), ["other"]);
  assert.deepEqual(await records("revisions"), [{ bookId: "book", contentRevision: "revision-2" }]);
});

test("a book with no audio records its revision and concurrent observations preserve new audio", async () => {
  await Promise.all([
    invalidateOfflineBookAudioIfChanged("book", "revision-1"),
    invalidateOfflineBookAudioIfChanged("book", "revision-1")
  ]);
  await save();
  await Promise.all([
    invalidateOfflineBookAudioIfChanged("book", "revision-1"),
    invalidateOfflineBookAudioIfChanged("other", "other-revision")
  ]);
  assert.ok(await loadOfflineAudioBlockContaining("book", "voice", 1));
  assert.equal((await records("revisions")).length, 2);
});

test("an aborted invalidation rolls back deletions and revision together", async () => {
  await invalidateOfflineBookAudioIfChanged("book", "revision-1");
  await save();
  const originalDelete = IDBCursor.prototype.delete;
  IDBCursor.prototype.delete = function () {
    const request = originalDelete.call(this);
    request.onsuccess = () => this.source.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(invalidateOfflineBookAudioIfChanged("book", "revision-2"));
  } finally {
    IDBCursor.prototype.delete = originalDelete;
  }
  assert.ok(await loadOfflineAudioBlockContaining("book", "voice", 1));
  assert.equal((await records("manifests")).length, 1);
  assert.equal((await records("blocks")).length, 1);
  assert.deepEqual(await records("revisions"), [{ bookId: "book", contentRevision: "revision-1" }]);
});
