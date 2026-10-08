import { randomUUID } from "node:crypto";
import oracledb from "oracledb";
import { z } from "zod";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { getConnection } from "../../config/database.js";

type Connection = Awaited<ReturnType<typeof getConnection>>;
type SelectionPage = { pageId: string; expectedUpdatedAt: string; status: "PENDING" | "READY" | "FAILED"; error?: string };
type Payload = { kind: "GALLERY_OCR_SELECTION"; userId: string; options: Record<string, unknown>; pages: SelectionPage[] };
type Job = { jobId: string; bookId: string; status: string; attemptCount: number; payloadJson: string; lastError: string | null };
const paramsSchema = z.object({ bookId: z.string().uuid(), jobId: z.string().uuid().optional() });
export const selectionSchema = z.object({
  pageIds: z.array(z.string().uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "Duplicate page IDs."),
  advancedLayout: z.boolean().default(false), ocrMode: z.enum(["AUTO", "LOCAL", "TEXTRACT", "VISION"]).default("TEXTRACT"),
  ocrModel: z.string().trim().min(1).max(255).optional(), promptOverride: z.string().trim().max(4000).optional()
}).strict();

export function selectionJobResponse(job: Job) {
  const payload = JSON.parse(job.payloadJson) as Payload;
  const completed = payload.pages.filter((page) => page.status === "READY").length;
  const failed = payload.pages.filter((page) => page.status === "FAILED").length;
  return { jobId: job.jobId, bookId: job.bookId,
    status: job.lastError === "CANCELLED" ? "CANCELLED" : job.status,
    cancelRequested: job.lastError === "CANCEL_REQUESTED", attemptCount: Number(job.attemptCount),
    total: payload.pages.length, completed, failed, processed: completed + failed,
    progress: payload.pages.length ? (completed + failed) / payload.pages.length : 1,
    pages: payload.pages, error: job.lastError };
}

const jobSelect = `SELECT job_id AS "jobId", book_id AS "bookId", status AS "status", attempt_count AS "attemptCount",
  payload_json AS "payloadJson", last_error AS "lastError" FROM processing_jobs`;
async function findJob(connection: Connection, bookId: string, jobId: string) {
  const result = await connection.execute(`${jobSelect} WHERE book_id = :bookId AND job_id = :jobId AND job_type = 'OCR_PAGE'`, { bookId, jobId });
  const job = (result.rows as Job[] | undefined)?.[0];
  if (!job || JSON.parse(job.payloadJson ?? "{}").kind !== "GALLERY_OCR_SELECTION") {
    throw Object.assign(new Error("OCR selection job not found."), { statusCode: 404 });
  }
  return job;
}

export async function processSelectionJob(connection: Connection, job: Job,
  runPage: (bookId: string, userId: string, page: SelectionPage, options: Record<string, unknown>) => Promise<void>) {
  const payload = JSON.parse(job.payloadJson) as Payload;
  for (const page of payload.pages) {
    const current = await findJob(connection, job.bookId, job.jobId);
    if (Number(current.attemptCount) !== Number(job.attemptCount) || current.status !== "RUNNING") return;
    if (current.lastError === "CANCEL_REQUESTED") {
      await connection.execute(`UPDATE processing_jobs SET status = 'FAILED', last_error = 'CANCELLED', finished_at = SYSTIMESTAMP
        WHERE job_id = :jobId AND attempt_count = :attempt`, { jobId: job.jobId, attempt: job.attemptCount }, { autoCommit: true });
      return;
    }
    if (page.status !== "PENDING") continue;
    try { await runPage(job.bookId, payload.userId, page, payload.options); page.status = "READY"; delete page.error; }
    catch (error) { page.status = "FAILED"; page.error = (error instanceof Error ? error.message : "OCR failed.").slice(0, 2000); }
    await connection.execute(`UPDATE processing_jobs SET payload_json = :payload, started_at = SYSTIMESTAMP
      WHERE job_id = :jobId AND attempt_count = :attempt AND status = 'RUNNING'`, {
      jobId: job.jobId, attempt: job.attemptCount, payload: { val: JSON.stringify(payload), type: oracledb.CLOB }
    }, { autoCommit: true });
  }
  await connection.execute(`UPDATE processing_jobs SET status = CASE WHEN DBMS_LOB.SUBSTR(last_error, 4000, 1) = 'CANCEL_REQUESTED' THEN 'FAILED' ELSE :status END,
    last_error = CASE WHEN DBMS_LOB.SUBSTR(last_error, 4000, 1) = 'CANCEL_REQUESTED' THEN 'CANCELLED' ELSE :error END,
    finished_at = SYSTIMESTAMP WHERE job_id = :jobId AND attempt_count = :attempt AND status = 'RUNNING'`, {
    jobId: job.jobId, attempt: job.attemptCount, status: payload.pages.some((page) => page.status === "FAILED") ? "FAILED" : "READY",
    error: payload.pages.some((page) => page.status === "FAILED") ? "One or more pages failed." : null
  }, { autoCommit: true });
}

export function registerGalleryOcrJobs(app: FastifyInstance, dependencies: {
  getConnection: typeof getConnection; authenticate: preHandlerHookHandler; editor: preHandlerHookHandler;
  assertEditor: (connection: Connection, bookId: string, userId: string) => Promise<void>;
  runPage: (bookId: string, userId: string, page: SelectionPage, options: Record<string, unknown>) => Promise<void>;
}) {
  const guard = { preHandler: [dependencies.authenticate, dependencies.editor] };
  app.post("/:bookId/ocr-jobs", guard, async (request, reply) => {
    const { bookId } = paramsSchema.parse(request.params);
    const parsed = selectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: parsed.error.message });
    const { pageIds, ...options } = parsed.data;
    const connection = await dependencies.getConnection();
    try {
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await dependencies.assertEditor(connection, bookId, request.currentUser!.userId);
      const result = await connection.execute(`SELECT p.page_id AS "pageId",
        TO_CHAR(p.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6') AS "updatedAt",
        b.source_type AS "sourceType", f.mime_type AS "mimeType" FROM book_pages p
        JOIN books b ON b.book_id = p.book_id LEFT JOIN book_files f ON f.file_id = p.source_file_id
        WHERE p.book_id = :bookId`, { bookId });
      const stored = (result.rows ?? []) as Array<{ pageId: string; updatedAt: string; sourceType: string; mimeType: string | null }>;
      const pages: SelectionPage[] = pageIds.map((pageId) => {
        const page = stored.find((page) => page.pageId === pageId);
        if (!page) throw Object.assign(new Error("Selected page not found."), { statusCode: 404 });
        if (page.sourceType !== "IMAGES" || !page.mimeType?.startsWith("image/")) {
          throw Object.assign(new Error("Selected page does not support OCR."), { statusCode: 409 });
        }
        return { pageId, expectedUpdatedAt: page.updatedAt, status: "PENDING" };
      });
      const jobId = randomUUID();
      const payload: Payload = { kind: "GALLERY_OCR_SELECTION", userId: request.currentUser!.userId, options, pages };
      await connection.execute(`INSERT INTO processing_jobs (job_id, book_id, job_type, status, payload_json)
        VALUES (:jobId, :bookId, 'OCR_PAGE', 'PENDING', :payload)`, {
        bookId, jobId, payload: { val: JSON.stringify(payload), type: oracledb.CLOB }
      });
      await dependencies.assertEditor(connection, bookId, request.currentUser!.userId);
      await connection.commit();
      return reply.status(202).send(selectionJobResponse({ jobId, bookId, status: "PENDING", attemptCount: 0, payloadJson: JSON.stringify(payload), lastError: null }));
    } catch (error) { await connection.rollback(); throw error; }
    finally { await connection.close(); }
  });
  app.get("/:bookId/ocr-jobs/:jobId", guard, async (request, reply) => {
    const { bookId, jobId } = paramsSchema.parse(request.params);
    const connection = await dependencies.getConnection();
    try { return reply.send(selectionJobResponse(await findJob(connection, bookId, jobId!))); }
    finally { await connection.close(); }
  });
  for (const action of ["cancel", "retry"] as const) {
    app.post(`/:bookId/ocr-jobs/:jobId/${action}`, guard, async (request, reply) => {
      const { bookId, jobId } = paramsSchema.parse(request.params);
      const connection = await dependencies.getConnection();
      try {
        await connection.execute("SELECT job_id FROM processing_jobs WHERE book_id = :bookId AND job_id = :jobId FOR UPDATE", { bookId, jobId });
        await dependencies.assertEditor(connection, bookId, request.currentUser!.userId);
        const job = await findJob(connection, bookId, jobId!);
        if (action === "cancel") {
          if (job.status === "PENDING" || job.status === "RUNNING") {
            await connection.execute(`UPDATE processing_jobs SET last_error = :error, status = :status,
              finished_at = CASE WHEN :status = 'FAILED' THEN SYSTIMESTAMP ELSE finished_at END WHERE job_id = :jobId`, {
              jobId, error: job.status === "PENDING" ? "CANCELLED" : "CANCEL_REQUESTED", status: job.status === "PENDING" ? "FAILED" : "RUNNING"
            });
          }
        } else {
          if (job.status !== "FAILED") return reply.status(409).send({ message: "Only failed or cancelled jobs can be retried." });
          const payload = JSON.parse(job.payloadJson) as Payload;
          payload.pages.forEach((page) => { if (page.status !== "READY") { page.status = "PENDING"; delete page.error; } });
          await connection.execute(`UPDATE processing_jobs SET status = 'PENDING', last_error = NULL, finished_at = NULL,
            payload_json = :payload WHERE job_id = :jobId`, { jobId, payload: { val: JSON.stringify(payload), type: oracledb.CLOB } });
        }
        await dependencies.assertEditor(connection, bookId, request.currentUser!.userId);
        await connection.commit();
        return reply.send(selectionJobResponse(await findJob(connection, bookId, jobId!)));
      } catch (error) { await connection.rollback(); throw error; }
      finally { await connection.close(); }
    });
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing = false;
  const tick = async () => {
    const connection = await dependencies.getConnection();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      // Conditional claim handles multiple API processes; heartbeat leases recover interrupted work.
      const result = await connection.execute(`${jobSelect} WHERE job_type = 'OCR_PAGE'
        AND DBMS_LOB.INSTR(payload_json, '"kind":"GALLERY_OCR_SELECTION"') > 0
        AND (status = 'PENDING' OR (status = 'RUNNING' AND started_at < SYSTIMESTAMP - INTERVAL '10' MINUTE))
        ORDER BY created_at`);
      const job = ((result.rows ?? []) as Job[]).find((job) => JSON.parse(job.payloadJson ?? "{}").kind === "GALLERY_OCR_SELECTION");
      if (!job) return;
      const claimed = await connection.execute(`UPDATE processing_jobs SET status = 'RUNNING', started_at = SYSTIMESTAMP,
        attempt_count = attempt_count + 1 WHERE job_id = :jobId AND attempt_count = :attempt
        AND (status = 'PENDING' OR (status = 'RUNNING' AND started_at < SYSTIMESTAMP - INTERVAL '10' MINUTE))`,
        { jobId: job.jobId, attempt: Number(job.attemptCount) }, { autoCommit: true });
      if (!claimed.rowsAffected) return;
      job.attemptCount = Number(job.attemptCount) + 1;
      heartbeat = setInterval(() => {
        void (async () => {
          const heartbeatConnection = await dependencies.getConnection();
          try { await heartbeatConnection.execute(`UPDATE processing_jobs SET started_at = SYSTIMESTAMP
            WHERE job_id = :jobId AND attempt_count = :attempt AND status = 'RUNNING'`,
            { jobId: job.jobId, attempt: job.attemptCount }, { autoCommit: true }); }
          finally { await heartbeatConnection.close(); }
        })().catch((error) => app.log.error(error, "OCR job heartbeat failed"));
      }, 60000);
      heartbeat.unref();
      await processSelectionJob(connection, job, dependencies.runPage);
    } finally { if (heartbeat) clearInterval(heartbeat); await connection.close(); }
  };
  app.addHook("onReady", async () => {
    timer = setInterval(() => {
      if (active || closing) return;
      active = tick().catch((error) => app.log.error(error, "OCR selection worker failed")).finally(() => { active = undefined; });
    }, 2000);
    timer.unref();
  });
  app.addHook("onClose", async () => { closing = true; if (timer) clearInterval(timer); await active; });
}
