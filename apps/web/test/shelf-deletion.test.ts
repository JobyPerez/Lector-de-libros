import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import ts from "typescript";

const text = readFileSync(new URL("../src/features/shelf/ShelfPage.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ShelfPage.tsx", text, ts.ScriptTarget.Latest, true);
const names = ["startBookRemoval", "finishBookRemoval", "removeBookFromShelf", "handleDeleteBook"];
const declarations: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(declarations.length, names.length);
const compiled = ts.transpile(`${declarations.join("\n")}\nreturn handleDeleteBook;`, { target: ts.ScriptTarget.ES2022 });
const a = { bookId: "a", title: "Libro A", currentUserRole: "OWNER" };
const b = { bookId: "b", title: "Libro B", currentUserRole: "OWNER" };
const c = { bookId: "c", title: "Libro C", currentUserRole: "OWNER" };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: { after: (callback: () => void) => void }, confirmations: boolean[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  for (const scope of ["all", "mine", "shared"]) client.setQueryData(["books", scope], [a, b, c]);
  let deleting = new Set<string>(), removing = new Set<string>();
  let error: string | null = null, success: string | null = null;
  const requests: { id: string; action: string; options?: unknown; completion: ReturnType<typeof deferred> }[] = [];
  const timers: (() => void)[] = [];
  const pendingBookRemovalsRef = { current: new Set<string>() };
  const dependencies = {
    accessToken: "token", pendingBookRemovalsRef, queryClient: client, editingBook: null,
    setDeletingBookIds: (update: (ids: Set<string>) => Set<string>) => { deleting = update(deleting); },
    setRemovingBookIds: (update: (ids: Set<string>) => Set<string>) => { removing = update(removing); },
    setBookActionError: (value: string | null) => { error = value; }, setBookActionSuccess: (value: string | null) => { success = value; },
    setViewTransitionDirection: () => {}, setEditingBook: () => {}, removalExitAnimationMs: 250,
    window: { confirm: () => confirmations.shift() ?? true, setTimeout: (callback: () => void) => { timers.push(callback); } },
    deleteBook: async (_token: string, id: string, options?: unknown) => { const completion = deferred(); requests.push({ id, action: "delete", options, completion }); await completion.promise; },
    leaveBookShare: async (_token: string, id: string) => { const completion = deferred(); requests.push({ id, action: "leave", completion }); await completion.promise; }
  };
  const handle = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies)) as (book: typeof a) => Promise<void>;
  return { client, handle, requests, timers, pendingBookRemovalsRef,
    get deleting() { return deleting; }, get removing() { return removing; }, get error() { return error; }, get success() { return success; },
    books: (scope = "all") => client.getQueryData<typeof a[]>(["books", scope])!.map((book) => book.bookId) };
}

test("two deletions complete in reverse order without clearing the other book's pending indicator", async (t) => {
  const app = setup(t);
  const first = app.handle(a), second = app.handle(b);
  assert.deepEqual([...app.deleting].sort(), ["a", "b"]);
  assert.equal(app.requests.length, 2);
  app.requests[1]!.completion.resolve(); await flush();
  assert.deepEqual([...app.removing], ["b"]);
  app.timers.shift()!(); await second;
  assert.deepEqual([...app.deleting], ["a"]);
  assert.deepEqual(app.books(), ["a", "c"]);
  app.requests[0]!.completion.resolve(); await flush(); app.timers.shift()!(); await first;
  assert.equal(app.deleting.size, 0); assert.equal(app.removing.size, 0);
  for (const scope of ["all", "mine", "shared"]) assert.deepEqual(app.books(scope), ["c"]);
});

test("overlapping exit animations are independent and duplicate clicks cannot send another request for the same book", async (t) => {
  const app = setup(t);
  const first = app.handle(a);
  await app.handle(a);
  assert.equal(app.requests.length, 1);
  const second = app.handle(b);
  app.requests[0]!.completion.resolve(); app.requests[1]!.completion.resolve(); await flush();
  assert.deepEqual([...app.removing].sort(), ["a", "b"]);
  app.timers.splice(1, 1)[0]!(); await second;
  assert.deepEqual([...app.removing], ["a"]);
  assert.deepEqual([...app.deleting], ["a"]);
  app.timers.shift()!(); await first;
  assert.equal(app.pendingBookRemovalsRef.current.size, 0);
});

test("one failure does not unlock another deletion, and the failed book remains retryable", async (t) => {
  const app = setup(t);
  const first = app.handle(a), second = app.handle(b);
  app.requests[0]!.completion.reject(new Error("Error de prueba")); await first;
  assert.deepEqual([...app.deleting], ["b"]);
  assert.match(app.error!, /Libro A.*Error de prueba/);
  assert.deepEqual(app.books(), ["a", "b", "c"]);
  app.requests[1]!.completion.resolve(); await flush(); app.timers.shift()!(); await second;
  assert.deepEqual(app.books(), ["a", "c"]);
  const retry = app.handle(a);
  assert.equal(app.requests.length, 3);
  app.requests[2]!.completion.resolve(); await flush(); app.timers.shift()!(); await retry;
  assert.deepEqual(app.books(), ["c"]);
});

test("declining forced deletion of a shared book preserves another book's exit animation", async (t) => {
  const app = setup(t, [true, true, false]);
  const first = app.handle(a), second = app.handle(b);
  app.requests[1]!.completion.resolve(); await flush();
  app.requests[0]!.completion.reject(new Error("Este libro está compartido")); await first;
  assert.deepEqual([...app.deleting], ["b"]);
  assert.deepEqual([...app.removing], ["b"]);
  assert.equal(app.requests.length, 2);
  app.timers.shift()!(); await second;
  assert.deepEqual(app.books(), ["a", "c"]);
});

test("leaving a share and deleting an owned book use independent requests and state", async (t) => {
  const app = setup(t);
  const first = app.handle({ ...a, currentUserRole: "VIEWER" }), second = app.handle(b);
  assert.deepEqual(app.requests.map((request) => request.action), ["leave", "delete"]);
  app.requests[0]!.completion.resolve(); await flush(); app.timers.shift()!(); await first;
  assert.deepEqual([...app.deleting], ["b"]);
  app.requests[1]!.completion.resolve(); await flush(); app.timers.shift()!(); await second;
  assert.deepEqual(app.books(), ["c"]);
});

test("a stale in-flight shelf fetch cannot resurrect a successfully deleted book", async (t) => {
  const app = setup(t);
  const stale = deferred<typeof a[]>();
  const fetching = app.client.fetchQuery({ queryKey: ["books", "all"], queryFn: () => stale.promise }).catch(() => undefined);
  const deletion = app.handle(a);
  app.requests[0]!.completion.resolve(); await flush(); app.timers.shift()!(); await deletion;
  stale.resolve([a, b, c]); await fetching; await flush();
  assert.deepEqual(app.books(), ["b", "c"]);
  assert.match(text, /const isDeletingBook = deletingBookIds\.has\(book\.bookId\)/);
  assert.match(text, /const removalState = removingBookIds\.has\(book\.bookId\)/);
});

test("forced deletion retries only its own book and keeps the other pending operation intact", async (t) => {
  const app = setup(t);
  const first = app.handle(a), second = app.handle(b);
  app.requests[0]!.completion.reject(new Error("Este libro está compartido")); await flush();
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests[2]!.id, "a");
  assert.deepEqual(app.requests[2]!.options, { force: true });
  assert.deepEqual([...app.deleting].sort(), ["a", "b"]);
  app.requests[2]!.completion.resolve(); await flush(); app.timers.shift()!(); await first;
  assert.deepEqual([...app.deleting], ["b"]);
  app.requests[1]!.completion.resolve(); await flush(); app.timers.shift()!(); await second;
  assert.deepEqual(app.books(), ["c"]);
});
