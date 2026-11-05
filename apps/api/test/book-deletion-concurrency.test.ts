import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const source = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const start = source.indexOf('  app.delete("/:bookId",');
const end = source.indexOf("\n  });", start);
assert.ok(start > 0 && end > start);
const body = source.slice(start, end).split("async (request, reply) => {")[1];
const compiled = ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 });
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("parallel book deletions use independent transactions and a failure rolls back only its own deletion", async () => {
  const ids = [randomUUID(), randomUUID()];
  const gates = new Map(ids.map((id) => [id, deferred()]));
  const connections: { bookId?: string; commits: number; rollbacks: number; closed: boolean; events: string[] }[] = [];
  const handler = new Function("bookParamsSchema", "getConnection", "findOwnedBook", "recordUserActivity", compiled)(
    z.object({ bookId: z.string().uuid() }),
    async () => {
      const state = { bookId: undefined as string | undefined, commits: 0, rollbacks: 0, closed: false, events: [] as string[] };
      connections.push(state);
      return { execute: async (sql: string, binds: { bookId: string; ownerUserId?: string }) => {
        if (state.bookId) assert.equal(binds.bookId, state.bookId);
        state.bookId = binds.bookId;
        if (sql.includes("FOR UPDATE")) { assert.equal(binds.ownerUserId, "owner"); state.events.push("lock"); }
        if (sql.includes("COUNT(*)")) return { rows: [{ shareCount: 0 }] };
        if (sql.includes("DELETE FROM books")) { state.events.push("delete"); await gates.get(binds.bookId)!.promise; }
        return { rowsAffected: 1, rows: [] };
      }, commit: async () => { state.commits++; }, rollback: async () => { state.rollbacks++; }, close: async () => { state.closed = true; } };
    },
    async (_connection: unknown, id: string, owner: string) => { assert.equal(owner, "owner"); return { bookId: id, title: id }; },
    async () => {}
  );
  const reply = () => ({ statusCode: 200, status(code: number) { this.statusCode = code; return this; }, send() { return this; } });
  const firstReply = reply(), secondReply = reply();
  const first = handler({ params: { bookId: ids[0] }, currentUser: { userId: "owner" }, query: {} }, firstReply);
  const second = handler({ params: { bookId: ids[1] }, currentUser: { userId: "owner" }, query: {} }, secondReply);
  await new Promise<void>((resolve) => setImmediate(resolve));
  gates.get(ids[1]!)!.resolve(); await second;
  assert.equal(secondReply.statusCode, 204);
  assert.equal(connections[1]!.commits, 1); assert.equal(connections[0]!.commits, 0);
  gates.get(ids[0]!)!.reject(new Error("Synthetic database failure"));
  await assert.rejects(first, /Synthetic database failure/);
  assert.equal(connections[0]!.rollbacks, 1); assert.equal(connections[1]!.rollbacks, 0);
  for (const connection of connections) {
    assert.equal(connection.closed, true);
    assert.deepEqual(connection.events, ["lock", "delete"]);
  }
  assert.match(source.slice(start, end), /requireBookRole\("OWNER"\)/);
});

test("deletion FK migration is additive, idempotent and uses online indexes rather than table-wide cascade locks", () => {
  const sql = readFileSync(new URL("../sql/040_book_deletion_indexes.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/ensure_index\('/gu) ?? []).length, 10);
  assert.match(sql, /column_position = 1/);
  assert.match(sql, /i.status = 'VALID'/);
  assert.match(sql, /CREATE INDEX[\s\S]*ONLINE/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+|ALTER\s+TABLE/iu);
});
