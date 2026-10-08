import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { processSelectionJob, registerGalleryOcrJobs, selectionJobResponse, selectionSchema } from "../src/modules/books/gallery-ocr-jobs.js";

const bookId = randomUUID();
const pageIds = [randomUUID(), randomUUID(), randomUUID()];
function jobFixture(status = "RUNNING") {
  const job = { jobId: randomUUID(), bookId, status, attemptCount: 1, lastError: null as string | null,
    payloadJson: JSON.stringify({ kind: "GALLERY_OCR_SELECTION", userId: "user", options: { ocrMode: "LOCAL" },
      pages: pageIds.map((pageId) => ({ pageId, expectedUpdatedAt: "v1", status: "PENDING" })) }) };
  const calls: any[] = [];
  const connection = { execute: async (sql: string, binds: any, options: any) => {
    calls.push({ sql, binds, options });
    if (sql.startsWith("SELECT")) return { rows: [structuredClone(job)] };
    if (binds.payload) job.payloadJson = binds.payload.val;
    if (sql.includes("last_error = 'CANCELLED'")) { job.status = "FAILED"; job.lastError = "CANCELLED"; }
    else if (binds.status) { job.status = job.lastError === "CANCEL_REQUESTED" ? "FAILED" : binds.status; job.lastError = job.lastError === "CANCEL_REQUESTED" ? "CANCELLED" : binds.error; }
    return { rowsAffected: 1 };
  } };
  return { job, connection: connection as any, calls };
}

test("selection validation rejects empty, duplicate, foreign-shaped payloads and supports all OCR modes", () => {
  assert.equal(selectionSchema.safeParse({ pageIds: [] }).success, false);
  assert.equal(selectionSchema.safeParse({ pageIds: [pageIds[0], pageIds[0]] }).success, false);
  assert.equal(selectionSchema.safeParse({ pageIds, userId: "other" }).success, false);
  for (const ocrMode of ["AUTO", "LOCAL", "TEXTRACT", "VISION"]) assert.equal(selectionSchema.parse({ pageIds, ocrMode }).ocrMode, ocrMode);
});

test("worker persists each page result, skips completed pages and records recoverable failures", async () => {
  const fixture = jobFixture();
  const payload = JSON.parse(fixture.job.payloadJson);
  payload.pages[0].status = "READY";
  fixture.job.payloadJson = JSON.stringify(payload);
  const processed: string[] = [];
  await processSelectionJob(fixture.connection, fixture.job, async (_book, user, page, options) => {
    assert.equal(user, "user"); assert.equal(options.ocrMode, "LOCAL"); assert.equal(page.expectedUpdatedAt, "v1");
    processed.push(page.pageId);
    if (page.pageId === pageIds[1]) throw new Error("Temporary OCR failure");
  });
  assert.deepEqual(processed, pageIds.slice(1));
  const state = selectionJobResponse(fixture.job);
  assert.equal(state.status, "FAILED"); assert.equal(state.completed, 2); assert.equal(state.failed, 1); assert.equal(state.progress, 1);
  assert.equal(state.pages[1]!.error, "Temporary OCR failure");
  const progressWrites = fixture.calls.filter((call) => call.binds?.payload);
  assert.equal(progressWrites.length, 2);
  assert.ok(progressWrites.every((call) => call.options.autoCommit === true && call.sql.includes("attempt_count = :attempt")));
});

test("cancellation is persisted and observed between pages, not a browser loop", async () => {
  const fixture = jobFixture();
  let processed = 0;
  await processSelectionJob(fixture.connection, fixture.job, async () => { processed++; fixture.job.lastError = "CANCEL_REQUESTED"; });
  assert.equal(processed, 1);
  assert.equal(selectionJobResponse(fixture.job).status, "CANCELLED");
  assert.equal(selectionJobResponse(fixture.job).completed, 1);
});

test("lease ownership loss stops processing and does not write results from an obsolete attempt", async () => {
  const fixture = jobFixture();
  const original = structuredClone(fixture.job);
  fixture.job.attemptCount++;
  await processSelectionJob(fixture.connection, original, async () => { assert.fail("must not process"); });
  assert.ok(fixture.calls.every((call) => call.sql.startsWith("SELECT")));
});

test("all-page completion racing cancellation persists CANCELLED as a retryable failed DB job", async () => {
  const fixture = jobFixture();
  await processSelectionJob(fixture.connection, fixture.job, async (_book, _user, page) => {
    if (page.pageId === pageIds[2]) fixture.job.lastError = "CANCEL_REQUESTED";
  });
  assert.equal(fixture.job.status, "FAILED");
  assert.equal(selectionJobResponse(fixture.job).status, "CANCELLED");
  const finalization = fixture.calls.at(-1).sql;
  assert.equal([...finalization.matchAll(/DBMS_LOB.SUBSTR\(last_error, 4000, 1\) = 'CANCEL_REQUESTED'/g)].length, 2);
  assert.doesNotMatch(finalization, /\b(?:WHEN|AND|WHERE)\s+last_error\s*=/i, "Oracle cannot compare CLOBs directly");
});

async function apiFixture(sourceType = "IMAGES") {
  const jobs = new Map<string, any>();
  const calls: any[] = [];
  let snapshot: Map<string, any> | undefined;
  let permissionChecks = 0, denyPermissionAt = 0;
  const connection = { execute: async (sql: string, binds: any) => {
    calls.push({ sql, binds });
    if (sql.includes("FOR UPDATE")) snapshot = structuredClone(jobs);
    if (sql.includes('b.source_type AS "sourceType"')) return { rows: pageIds.map((pageId) => ({ pageId, updatedAt: "v1", sourceType, mimeType: "image/png" })) };
    if (sql.includes("INSERT INTO processing_jobs")) {
      jobs.set(binds.jobId, { jobId: binds.jobId, bookId: binds.bookId, status: "PENDING", attemptCount: 0, lastError: null, payloadJson: binds.payload.val });
    } else if (sql.startsWith("SELECT") && sql.includes('job_id AS "jobId"')) return { rows: jobs.has(binds?.jobId) ? [structuredClone(jobs.get(binds.jobId))] : [] };
    else if (sql.startsWith("UPDATE processing_jobs")) {
      const job = jobs.get(binds.jobId);
      if (binds.payload) { job.payloadJson = binds.payload.val; job.status = "PENDING"; job.lastError = null; }
      else { job.status = binds.status; job.lastError = binds.error; }
    }
    return { rows: [], rowsAffected: 1 };
  }, commit: async () => { calls.push({ sql: "commit" }); snapshot = undefined; }, rollback: async () => {
    calls.push({ sql: "rollback" });
    if (snapshot) { jobs.clear(); for (const [id, job] of snapshot) jobs.set(id, job); }
  }, close: async () => {} };
  const app = Fastify();
  registerGalleryOcrJobs(app, { getConnection: async () => connection as any,
    assertEditor: async (db, checkedBookId, checkedUserId) => {
      assert.equal(db, connection); assert.equal(checkedBookId, bookId); assert.equal(checkedUserId, "user");
      assert.ok(snapshot, "must recheck permission after the transaction lock");
      calls.push({ sql: "permission" });
      if (++permissionChecks === denyPermissionAt) throw Object.assign(new Error("EDITOR revoked"), { statusCode: 403 });
    },
    authenticate: async (request) => { request.currentUser = { userId: "user" } as any; },
    editor: async (request, reply) => { if (request.headers["x-role"] === "VIEWER") return reply.status(403).send({ message: "EDITOR required" }); },
    runPage: async () => { assert.fail("Worker must not run during endpoint tests"); } });
  return { app, jobs, calls, revokeOnCheck: (offset = 1) => { denyPermissionAt = permissionChecks + offset; } };
}

test("job endpoints enqueue committed selection snapshots, expose persisted progress, cancel and retry only unfinished pages", async () => {
  const { app, jobs, calls } = await apiFixture();
  try {
    const created = await app.inject({ method: "POST", url: `/${bookId}/ocr-jobs`, payload: { pageIds, ocrMode: "LOCAL" } });
    assert.equal(created.statusCode, 202);
    const response = created.json();
    assert.equal(response.total, 3); assert.equal(response.completed, 0); assert.equal(response.status, "PENDING");
    const stored = jobs.get(response.jobId);
    assert.ok(stored); assert.equal(JSON.parse(stored.payloadJson).userId, "user");
    assert.equal(JSON.parse(stored.payloadJson).pages[0].expectedUpdatedAt, "v1");
    assert.ok(calls.some((call) => call.sql === "commit"));
    const base = `/${bookId}/ocr-jobs/${response.jobId}`;
    assert.equal((await app.inject(base)).json().status, "PENDING");
    assert.equal((await app.inject({ method: "POST", url: `${base}/retry` })).statusCode, 409);
    const payload = JSON.parse(stored.payloadJson); payload.pages[0].status = "READY"; stored.payloadJson = JSON.stringify(payload);
    assert.equal((await app.inject({ method: "POST", url: `${base}/cancel` })).json().status, "CANCELLED");
    const retried = await app.inject({ method: "POST", url: `${base}/retry` });
    assert.equal(retried.statusCode, 200); assert.equal(retried.json().status, "PENDING"); assert.equal(retried.json().completed, 1);
    assert.equal(retried.json().pages[1].expectedUpdatedAt, "v1", "retry must not overwrite concurrent content");
    assert.equal((await app.inject({ method: "POST", url: `/${bookId}/ocr-jobs`, payload: { pageIds }, headers: { "x-role": "VIEWER" } })).statusCode, 403);
    assert.equal((await app.inject(`/${bookId}/ocr-jobs/${randomUUID()}`)).statusCode, 404);
  } finally { await app.close(); }
});

test("selection enqueue rejects missing IDs and unsupported PDF/EPUB without a persisted job", async () => {
  for (const type of ["PDF", "EPUB", "IMAGES"]) {
    const { app, jobs, calls } = await apiFixture(type);
    try {
      const result = await app.inject({ method: "POST", url: `/${bookId}/ocr-jobs`, payload: { pageIds: type === "IMAGES" ? [randomUUID()] : pageIds } });
      assert.equal(result.statusCode, type === "IMAGES" ? 404 : 409);
      assert.equal(jobs.size, 0); assert.ok(calls.some((call) => call.sql === "rollback"));
    } finally { await app.close(); }
  }
});

test("enqueue, failed checkpoints and retry retain explicit model and advanced OCR options for unfinished IDs", async () => {
  const { app, jobs } = await apiFixture();
  const options = { ocrMode: "VISION", ocrModel: "explicit-model", advancedLayout: true, promptOverride: "Keep colored containers." };
  try {
    const created = await app.inject({ method: "POST", url: `/${bookId}/ocr-jobs`, payload: { pageIds, ...options } });
    assert.equal(created.statusCode, 202);
    const job = jobs.get(created.json().jobId);
    assert.deepEqual(JSON.parse(job.payloadJson).options, options);
    const fixture = jobFixture();
    Object.assign(fixture.job, job, { status: "RUNNING", attemptCount: 1 });
    await processSelectionJob(fixture.connection, fixture.job, async (book, user, page, received) => {
      assert.equal(book, bookId); assert.equal(user, "user");
      assert.deepEqual(received, options);
      assert.equal(page.expectedUpdatedAt, "v1");
      if (page.pageId !== pageIds[0]) throw new Error("Temporary provider failure");
    });
    assert.equal(fixture.job.status, "FAILED");
    const checkpoints = fixture.calls.filter((call) => call.binds?.payload);
    assert.equal(checkpoints.length, 3);
    for (const call of checkpoints) assert.deepEqual(JSON.parse(call.binds.payload.val).options, options);
    Object.assign(job, fixture.job);
    const retried = await app.inject({ method: "POST", url: `/${bookId}/ocr-jobs/${job.jobId}/retry` });
    assert.equal(retried.statusCode, 200);
    const payload = JSON.parse(job.payloadJson);
    assert.deepEqual(payload.options, options);
    assert.deepEqual(payload.pages.map((page: any) => [page.pageId, page.expectedUpdatedAt, page.status, page.error]),
      pageIds.map((id, index) => [id, "v1", index === 0 ? "READY" : "PENDING", undefined]));
    Object.assign(fixture.job, job, { status: "RUNNING", attemptCount: 2 });
    const processed: string[] = [];
    await processSelectionJob(fixture.connection, fixture.job, async (_book, _user, page, received) => {
      assert.deepEqual(received, options); processed.push(page.pageId);
    });
    assert.deepEqual(processed, pageIds.slice(1));
    assert.equal(fixture.job.status, "READY");
    assert.deepEqual(JSON.parse(fixture.job.payloadJson).options, options);
  } finally { await app.close(); }
});

for (const action of ["enqueue", "cancel", "retry"] as const) {
  for (const stage of ["after-lock", "before-commit"] as const) {
    test(`OCR selection ${action} rejects EDITOR revocation ${stage} and rolls back the job transaction`, async () => {
      const fixture = await apiFixture();
      try {
        let url = `/${bookId}/ocr-jobs`;
        if (action !== "enqueue") {
          const created = await fixture.app.inject({ method: "POST", url, payload: { pageIds } });
          assert.equal(created.statusCode, 202);
          const jobId = created.json().jobId;
          if (action === "retry") fixture.jobs.get(jobId).status = "FAILED";
          url += `/${jobId}/${action}`;
        }
        const originalJobs = structuredClone(fixture.jobs);
        fixture.calls.length = 0;
        fixture.revokeOnCheck(stage === "after-lock" ? 1 : 2);
        const result = await fixture.app.inject({ method: "POST", url, ...(action === "enqueue" ? { payload: { pageIds } } : {}) });
        assert.equal(result.statusCode, 403);
        assert.deepEqual(fixture.jobs, originalJobs);
        assert.ok(fixture.calls.some((call) => call.sql === "rollback"));
        assert.ok(!fixture.calls.some((call) => call.sql === "commit"));
        const lockIndex = fixture.calls.findIndex((call) => call.sql.includes("FOR UPDATE"));
        const permissionIndex = fixture.calls.findIndex((call) => call.sql === "permission");
        assert.ok(lockIndex >= 0 && lockIndex < permissionIndex);
        if (stage === "after-lock") assert.ok(!fixture.calls.some((call) => /^(UPDATE|INSERT)/.test(call.sql)));
      } finally { await fixture.app.close(); }
    });
  }
}

test("server worker resumes an expired persisted selection on startup and skips checkpointed pages", async () => {
  const fixture = jobFixture();
  const payload = JSON.parse(fixture.job.payloadJson);
  payload.pages[0].status = "READY";
  fixture.job.payloadJson = JSON.stringify(payload);
  const processed: string[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const calls: string[] = [];
  const connection = {
    execute: async (sql: string, binds: any, options: any) => {
      calls.push(sql);
      if (sql.includes("ORDER BY created_at")) return { rows: fixture.job.status === "RUNNING" ? [structuredClone(fixture.job)] : [] };
      if (sql.includes("attempt_count = attempt_count + 1")) {
        if (fixture.job.attemptCount !== binds.attempt) return { rowsAffected: 0 };
        fixture.job.attemptCount++; return { rowsAffected: 1 };
      }
      return fixture.connection.execute(sql, binds, options);
    }, close: async () => {}
  };
  const app = Fastify();
  registerGalleryOcrJobs(app, { getConnection: async () => connection as any,
    assertEditor: async () => {},
    authenticate: async () => {}, editor: async () => {}, runPage: async (_book, _user, page) => {
      processed.push(page.pageId); if (processed.length === 2) finished();
    } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await app.ready();
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Worker did not resume job")), 6000); })]);
  } finally { if (timeout) clearTimeout(timeout); await app.close(); }
  assert.deepEqual(processed, pageIds.slice(1));
  assert.equal(fixture.job.attemptCount, 2);
  assert.equal(selectionJobResponse(fixture.job).status, "READY");
  assert.ok(calls.some((sql) => sql.includes("INTERVAL '10' MINUTE")));
  assert.ok(calls.some((sql) => sql.includes("attempt_count = :attempt")));
});
