import type { ChapterAudioOfflinePlan, ReaderAudioBlockParagraph } from "../../app/api";

type OfflineAudioManifest = {
  blockKeys: string[];
  bookId: string;
  chapterId: string;
  createdAt: string;
  endSequenceNumber: number;
  title: string;
  totalBlockCount: number;
  updatedAt: string;
  voiceModel: string;
};

type OfflineAudioBlock = {
  nextSequenceNumber?: number | null | undefined;
  blob: Blob;
  bookId: string;
  chapterId: string;
  key: string;
  paragraphCount: number;
  paragraphs: ReaderAudioBlockParagraph[];
  startSequenceNumber: number;
  voiceModel: string;
};

export type OfflineAudioBlockPlayback = Pick<OfflineAudioBlock, "blob" | "paragraphCount" | "paragraphs" | "startSequenceNumber" | "nextSequenceNumber">;
export type OfflineChapterAudioExportBlock = OfflineAudioBlockPlayback;
export type OfflineChapterAudioExport = {
  blocks: OfflineChapterAudioExportBlock[];
  manifest: OfflineAudioManifest & { key: string };
};

const DATABASE_NAME = "lector-reader-audio-offline";
const DATABASE_VERSION = 2;
const MANIFEST_STORE = "manifests";
const BLOCK_STORE = "blocks";
const REVISION_STORE = "revisions";

export class OfflineAudioRevisionError extends Error {
  readonly code = "OFFLINE_AUDIO_STALE_REVISION";

  constructor() {
    super("La revisión del libro cambió o no está disponible. Recarga el lector antes de continuar.");
    this.name = "OfflineAudioRevisionError";
  }
}

export function isOfflineAudioRevisionError(error: unknown): error is OfflineAudioRevisionError {
  return error instanceof Error && "code" in error && error.code === "OFFLINE_AUDIO_STALE_REVISION";
}

function createManifestKey(bookId: string, chapterId: string, voiceModel: string) {
  return `${bookId}|${chapterId}|${voiceModel}`;
}

function createBlockKey(bookId: string, chapterId: string, voiceModel: string, startSequenceNumber: number, paragraphCount: number) {
  return `${createManifestKey(bookId, chapterId, voiceModel)}|${startSequenceNumber}|${paragraphCount}`;
}

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Este navegador no permite guardar audio offline."));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(BLOCK_STORE)) {
        database.createObjectStore(BLOCK_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(REVISION_STORE)) {
        database.createObjectStore(REVISION_STORE, { keyPath: "bookId" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el almacenamiento offline."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo completar la operación offline."));
    transaction.onabort = () => reject(transaction.error ?? new Error("La operación offline fue cancelada."));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el almacenamiento offline."));
    request.onsuccess = () => resolve(request.result);
  });
}

export function normalizeContentRevision(revision: string): string {
  const match = revision.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z` : revision;
}

// Await before reading or downloading audio for the observed content revision.
export async function invalidateOfflineBookAudioIfChanged(bookId: string, contentRevision: string): Promise<void> {
  if (!contentRevision.trim()) throw new OfflineAudioRevisionError();
  contentRevision = normalizeContentRevision(contentRevision);
  const database = await openDatabase();
  try {
    const transaction = database.transaction([MANIFEST_STORE, BLOCK_STORE, REVISION_STORE], "readwrite");
    const completion = transactionDone(transaction);
    let staleRevision = false;
    const revisions = transaction.objectStore(REVISION_STORE);
    const revisionRequest = revisions.get(bookId) as IDBRequest<{ bookId: string; contentRevision: string } | undefined>;
    revisionRequest.onsuccess = () => {
      // ISO6Z revisions are lexically ordered. Compare under the same write lock
      // as saves so an older tab cannot delete newer audio or downgrade its revision.
      const storedRevision = revisionRequest.result && normalizeContentRevision(revisionRequest.result.contentRevision);
      if (storedRevision && contentRevision < storedRevision) {
        staleRevision = true;
        transaction.abort();
        return;
      }
      if (storedRevision === contentRevision) {
        if (revisionRequest.result!.contentRevision !== contentRevision) revisions.put({ bookId, contentRevision });
        return;
      }

      // A missing stored revision also invalidates legacy audio. Scan blocks independently
      // so orphaned downloads cannot survive a content change.
      for (const storeName of [MANIFEST_STORE, BLOCK_STORE]) {
        const cursorRequest = transaction.objectStore(storeName).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          if (cursor.value.bookId === bookId) {
            cursor.delete();
          }
          cursor.continue();
        };
      }
      revisions.put({ bookId, contentRevision });
    };
    try {
      await completion;
    } catch (error) {
      if (staleRevision) throw new OfflineAudioRevisionError();
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function saveChapterAudioBlock(
  bookId: string,
  plan: ChapterAudioOfflinePlan,
  block: OfflineAudioBlockPlayback,
  expectedRevision?: string
) {
  const database = await openDatabase();
  try {
    const now = new Date().toISOString();
    const manifestKey = createManifestKey(bookId, plan.chapterId, plan.voiceModel);
    const blockKey = createBlockKey(bookId, plan.chapterId, plan.voiceModel, block.startSequenceNumber, block.paragraphCount);
    const transaction = database.transaction([MANIFEST_STORE, BLOCK_STORE, REVISION_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const manifestStore = transaction.objectStore(MANIFEST_STORE);
    let revisionChanged = false;
    const revisionRequest = transaction.objectStore(REVISION_STORE).get(bookId) as IDBRequest<{ contentRevision: string } | undefined>;
    revisionRequest.onsuccess = () => {
      if (expectedRevision !== undefined && (!revisionRequest.result || normalizeContentRevision(revisionRequest.result.contentRevision) !== normalizeContentRevision(expectedRevision))) {
        revisionChanged = true;
        transaction.abort();
        return;
      }

      // Read and merge under the same write lock as invalidation and other saves.
      const manifestRequest = manifestStore.get(manifestKey) as IDBRequest<OfflineAudioManifest & { key: string } | undefined>;
      manifestRequest.onsuccess = () => {
        const existingManifest = manifestRequest.result;
        const blockKeys = new Set(existingManifest?.blockKeys ?? []);
        blockKeys.add(blockKey);
        manifestStore.put({
          blockKeys: Array.from(blockKeys),
          bookId,
          chapterId: plan.chapterId,
          createdAt: existingManifest?.createdAt ?? now,
          endSequenceNumber: plan.endSequenceNumber,
          key: manifestKey,
          title: plan.title,
          totalBlockCount: plan.blocks.length,
          updatedAt: now,
          voiceModel: plan.voiceModel
        });
        transaction.objectStore(BLOCK_STORE).put({
          blob: block.blob,
          bookId,
          chapterId: plan.chapterId,
          key: blockKey,
          paragraphCount: block.paragraphCount,
          paragraphs: block.paragraphs,
          nextSequenceNumber: block.nextSequenceNumber,
          startSequenceNumber: block.startSequenceNumber,
          voiceModel: plan.voiceModel
        });
      };
    };
    try {
      await completion;
    } catch (error) {
      if (revisionChanged) {
        throw new OfflineAudioRevisionError();
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function loadOfflineAudioBlockContaining(bookId: string, voiceModel: string, sequenceNumber: number) {
  const database = await openDatabase();
  try {
    const manifests = await requestResult<Array<OfflineAudioManifest & { key: string }>>(
      database.transaction([MANIFEST_STORE], "readonly").objectStore(MANIFEST_STORE).getAll()
    );
    for (const manifest of manifests) {
      if (manifest.bookId !== bookId || manifest.voiceModel !== voiceModel) {
        continue;
      }

      for (const blockKey of manifest.blockKeys) {
        const block = await requestResult<OfflineAudioBlock | undefined>(
          database.transaction([BLOCK_STORE], "readonly").objectStore(BLOCK_STORE).get(blockKey)
        );
        if (!block) {
          continue;
        }

        const containsSequence = block.paragraphs.some((paragraph) => paragraph.sequenceNumber === sequenceNumber);
        if (containsSequence) {
          return {
            blob: block.blob,
            paragraphCount: block.paragraphCount,
            paragraphs: block.paragraphs,
            nextSequenceNumber: block.nextSequenceNumber,
            startSequenceNumber: block.startSequenceNumber
          } satisfies OfflineAudioBlockPlayback;
        }
      }
    }

    return null;
  } finally {
    database.close();
  }
}

export async function getOfflineChapterAudioStatus(bookId: string, chapterId: string, voiceModel: string) {
  const database = await openDatabase();
  try {
    const manifestKey = createManifestKey(bookId, chapterId, voiceModel);
    const transaction = database.transaction([MANIFEST_STORE], "readonly");
    const manifest = await requestResult<OfflineAudioManifest & { key: string } | undefined>(transaction.objectStore(MANIFEST_STORE).get(manifestKey));
    return manifest ? { blockCount: manifest.blockKeys.length, isComplete: manifest.blockKeys.length >= manifest.totalBlockCount, totalBlockCount: manifest.totalBlockCount, updatedAt: manifest.updatedAt } : null;
  } finally {
    database.close();
  }
}

export async function loadOfflineChapterAudioExport(bookId: string, chapterId: string, voiceModel: string): Promise<OfflineChapterAudioExport | null> {
  const database = await openDatabase();
  try {
    const manifestKey = createManifestKey(bookId, chapterId, voiceModel);
    const manifest = await requestResult<OfflineAudioManifest & { key: string } | undefined>(
      database.transaction([MANIFEST_STORE], "readonly").objectStore(MANIFEST_STORE).get(manifestKey)
    );
    if (!manifest) {
      return null;
    }

    const blocks: OfflineChapterAudioExportBlock[] = [];
    for (const blockKey of manifest.blockKeys) {
      const block = await requestResult<OfflineAudioBlock | undefined>(
        database.transaction([BLOCK_STORE], "readonly").objectStore(BLOCK_STORE).get(blockKey)
      );
      if (!block) {
        continue;
      }

      blocks.push({
        blob: block.blob,
        paragraphCount: block.paragraphCount,
        paragraphs: block.paragraphs,
        nextSequenceNumber: block.nextSequenceNumber,
        startSequenceNumber: block.startSequenceNumber
      });
    }

    blocks.sort((left, right) => left.startSequenceNumber - right.startSequenceNumber);

    return {
      blocks,
      manifest
    };
  } finally {
    database.close();
  }
}
