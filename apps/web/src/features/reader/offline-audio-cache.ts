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
  blob: Blob;
  bookId: string;
  chapterId: string;
  key: string;
  paragraphCount: number;
  paragraphs: ReaderAudioBlockParagraph[];
  startSequenceNumber: number;
  voiceModel: string;
};

export type OfflineAudioBlockPlayback = Pick<OfflineAudioBlock, "blob" | "paragraphCount" | "paragraphs" | "startSequenceNumber">;
export type OfflineChapterAudioExportBlock = Pick<OfflineAudioBlock, "blob" | "paragraphCount" | "paragraphs" | "startSequenceNumber">;
export type OfflineChapterAudioExport = {
  blocks: OfflineChapterAudioExportBlock[];
  manifest: OfflineAudioManifest & { key: string };
};

const DATABASE_NAME = "lector-reader-audio-offline";
const DATABASE_VERSION = 1;
const MANIFEST_STORE = "manifests";
const BLOCK_STORE = "blocks";

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

export async function saveChapterAudioBlock(
  bookId: string,
  plan: ChapterAudioOfflinePlan,
  block: { blob: Blob; paragraphCount: number; paragraphs: ReaderAudioBlockParagraph[]; startSequenceNumber: number }
) {
  const database = await openDatabase();
  try {
    const now = new Date().toISOString();
    const manifestKey = createManifestKey(bookId, plan.chapterId, plan.voiceModel);
    const blockKey = createBlockKey(bookId, plan.chapterId, plan.voiceModel, block.startSequenceNumber, block.paragraphCount);
    const existingManifest = await requestResult<OfflineAudioManifest & { key: string } | undefined>(
      database.transaction([MANIFEST_STORE], "readonly").objectStore(MANIFEST_STORE).get(manifestKey)
    );
    const blockKeys = new Set(existingManifest?.blockKeys ?? []);
    blockKeys.add(blockKey);

    const transaction = database.transaction([MANIFEST_STORE, BLOCK_STORE], "readwrite");
    const manifestStore = transaction.objectStore(MANIFEST_STORE);

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
      startSequenceNumber: block.startSequenceNumber,
      voiceModel: plan.voiceModel
    });
    await transactionDone(transaction);
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
