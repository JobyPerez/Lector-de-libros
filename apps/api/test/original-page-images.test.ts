import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { z } from "zod";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const bookId = randomUUID();
const sourceFileId = randomUUID();

function setup(options: { failUpdate?: boolean; missingPage?: boolean } = {}) {
  let current = Buffer.from("original bytes");
  let snapshot: Buffer | undefined;
  let rotation = 90;
  let snapshots = 0;
  let unlock: (() => void) | undefined;
  let lock = Promise.resolve();
  const statements: string[] = [];

  function connection() {
    let release: (() => void) | undefined;
    let before: { current: Buffer; snapshot: Buffer | undefined; rotation: number } | undefined;
    return {
      async execute(sql: string, binds: Record<string, any> = {}) {
        statements.push(sql);
        if (sql.includes("FROM books WHERE") && sql.includes("FOR UPDATE")) {
          const previous = lock;
          lock = new Promise<void>((resolve) => { unlock = resolve; });
          release = unlock;
          await previous;
          before = { current, snapshot, rotation };
        } else if (sql.includes("INSERT INTO book_files")) {
          assert.ok(before, "snapshot must be inside the page lock transaction");
          assert.ok(statements.at(-2)?.includes("FROM book_pages") && statements.at(-2)?.includes("FOR UPDATE"));
          assert.match(sql, /source\.file_kind = 'PAGE_IMAGE'/);
          assert.match(sql, /original\.file_name = source\.file_id/);
          assert.equal(binds.fileId, sourceFileId);
          if (!snapshot) { snapshot = Buffer.from(current); snapshots++; }
        } else if (sql.includes("UPDATE book_files")) {
          assert.ok(snapshot);
          if (options.failUpdate) throw new Error("update failed");
          current = binds.contentBlob;
        } else if (sql.includes("SET source_image_rotation = 0")) {
          rotation = 0;
        } else if (sql.includes('AS "contentBlob"')) {
          assert.match(sql, /original\.book_id = bp\.book_id/);
          assert.match(sql, /original\.file_kind = 'ORIGINAL_PAGE_IMAGE'/);
          assert.match(sql, /original\.file_name = bp\.source_file_id/);
          assert.match(sql, /COALESCE\(original\.file_id, bp\.source_file_id\)/);
          assert.equal(binds.bookId, bookId);
          return { rows: options.missingPage ? [] : [{ contentBlob: binds.original && snapshot ? snapshot : current, mimeType: "image/png" }] };
        }
        return { rows: [] };
      },
      async commit() { release?.(); release = undefined; },
      async rollback() {
        if (before) ({ current, snapshot, rotation } = before);
        release?.(); release = undefined;
      },
      async close() { release?.(); }
    };
  }

  function handler(method: "get" | "put") {
    const start = routes.indexOf(`  app.${method}("/:bookId/pages/:pageNumber/image",`);
    const end = routes.indexOf("\n  });", start);
    const expression = routes.slice(start, end).split("async (request, reply) => {")[1];
    assert.ok(expression);
    const compiled = ts.transpile(`const handler = async (request, reply) => {${expression}\n};`, { target: ts.ScriptTarget.ES2022 });
    return new Function("z", "pageParamsSchema", "getConnection", "oracledb", "findAccessibleBook", "findBookPage", "ensureImageFiles", "readUploadedFile", "maximumUploadedImageBytes", "randomUUID", "computeChecksum", "recordUserActivity", `${compiled}; return handler;`)(
      z, z.object({ bookId: z.string().uuid(), pageNumber: z.coerce.number().int().min(1) }),
      async () => connection(), { BUFFER: 1 },
      async () => ({ sourceType: "IMAGES", title: "Test" }),
      async () => options.missingPage ? null : ({ sourceFileId, pageId: "page-id" }),
      (files: unknown[]) => files, async (file: { buffer: Buffer }) => file.buffer,
      10000, randomUUID, () => "checksum", async () => undefined
    );
  }

  async function call(method: "get" | "put", original?: string, bytes = "edited bytes", params = { bookId, pageNumber: 1 }) {
    const response = { statusCode: 200, body: undefined as any, headers: {} as Record<string, string>,
      status(code: number) { this.statusCode = code; return this; },
      header(name: string, value: string) { this.headers[name] = value; return this; },
      send(body?: unknown) { this.body = body; return this; }
    };
    await handler(method)({ currentUser: { userId: "viewer" }, params, query: original === undefined ? {} : { original },
      file: async () => ({ buffer: Buffer.from(bytes), filename: "edited.png", mimetype: "image/png" }) }, response);
    return response;
  }
  return { call, state: () => ({ current, snapshot, rotation, snapshots }) };
}

test("image routes retain viewer/editor authorization", () => {
  assert.ok(routes.includes('app.get("/:bookId/pages/:pageNumber/image", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }'));
  assert.ok(routes.includes('app.put("/:bookId/pages/:pageNumber/image", { preHandler: [authenticateRequest, requireBookRole("EDITOR")] }'));
});

test("original fallback returns unrotated bytes; repeated edits preserve first snapshot", async () => {
  const app = setup();
  assert.equal((await app.call("get", "true")).body.toString(), "original bytes");
  await app.call("put");
  await app.call("put", undefined, "second edit");
  assert.equal((await app.call("get", "true")).body.toString(), "original bytes");
  assert.equal((await app.call("get")).body.toString(), "second edit");
  assert.equal((await app.call("get", "false")).body.toString(), "second edit");
  assert.equal(app.state().snapshots, 1);
  assert.equal(app.state().rotation, 0);
});

test("simultaneous edits preserve one snapshot under the same lock", async () => {
  const app = setup();
  await Promise.all([app.call("put", undefined, "first"), app.call("put", undefined, "second")]);
  assert.equal(app.state().snapshot?.toString(), "original bytes");
  assert.equal(app.state().snapshots, 1);
});

test("failed overwrite rolls back snapshot and image together", async () => {
  const app = setup({ failUpdate: true });
  await assert.rejects(app.call("put"), /update failed/);
  assert.equal(app.state().snapshot, undefined);
  assert.equal(app.state().current.toString(), "original bytes");
  assert.equal(app.state().rotation, 90);
});

test("GET validates query and page identity and returns 404 for missing sources", async () => {
  const app = setup();
  await assert.rejects(app.call("get", "invalid"));
  await assert.rejects(app.call("get", "true", "", { bookId: "invalid", pageNumber: 1 }));
  await assert.rejects(app.call("get", "true", "", { bookId, pageNumber: 0 }));
  assert.equal((await setup({ missingPage: true }).call("get", "true")).statusCode, 404);
});
