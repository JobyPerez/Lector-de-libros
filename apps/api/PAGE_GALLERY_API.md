# Page Gallery API

All paths below are relative to the API root. Authentication is required.
IDs are persisted `book_pages.page_id` values. Positions are one-based and mutable.

## Gallery and Order

`GET /books/:bookId/pages` requires VIEWER or higher and returns:

```ts
{
  pages: Array<{
    pageId: string;
    position: number;
    pageNumber: number;
    pageLabel: string | null;
    pageType: string;
    updatedAt: string; // Exact FF6 version token, no timezone suffix.
    ocrStatus: string;
    paragraphCount: number;
    source: { type: "PDF" | "EPUB" | "IMAGES"; fileId: string | null;
      mimeType: string | null; rotation: number };
    preview: { kind: "IMAGE" | "CONTENT"; text: string;
      contentUrl: string; imageUrl: string | null };
    capabilities: { edit: boolean; delete: boolean; reorder: boolean;
      ocr: boolean; visualEditor: boolean };
  }>;
  pageIds: string[]; // Current persisted order.
  capabilities: { reorder: boolean };
}
```

Preview text is at most 500 characters from the first active paragraph. No page
HTML, image BLOB, or visual document is included in the gallery listing. PDF and
EPUB pages provide content previews through `preview.contentUrl`; images provide
both content and image URLs. These URLs contain `pageId` for safe targeting.
Gallery image URLs also include `thumbnail=true` to avoid downloading full images.

`POST /books/:bookId/pages/reorder` (also `PUT /books/:bookId/pages/order`) requires
EDITOR or higher. Request:

```json
{ "expectedPageIds": ["id-in-original-order"], "pageIds": ["id-in-new-order"] }
```

Both arrays must describe the entire book. The requested array must be a complete,
duplicate-free permutation. The expected array must exactly match persisted order.
Success returns the gallery response above, after one transaction commits.
Stale order returns 409 with `code: "PAGE_ORDER_CONFLICT"`; malformed permutations
return 400. The operation never recreates pages or paragraphs. It remaps files,
annotations, chapters, reading progress, and internal page links including links
inside visual document JSON and paragraph content. Paragraph audio caches and
reading audio offsets remain attached to their stable paragraphs. AI requests and
section summaries are marked stale. The original uploaded PDF/EPUB is not rewritten.

## Stable Page Targeting

Existing handlers accept optional `?pageId=<uuid>`. When supplied, this ID, scoped
to the book, overrides the position in the URL. A missing ID returns 404, never a
fallback to a different page. Mutations resolve it after taking the book lock.

- `GET /books/:bookId/pages/:pageNumber?pageId=...`
- `GET /books/:bookId/pages/:pageNumber/image?pageId=...`
- `DELETE /books/:bookId/pages/:pageNumber?pageId=...`
- `PUT /books/:bookId/pages/:pageNumber/ocr?pageId=...`
- `PUT /books/:bookId/pages/:pageNumber/visual-document?pageId=...`
- `PATCH /books/:bookId/pages/:pageNumber/elements?pageId=...`
- `PUT /books/:bookId/pages/:pageNumber/image-rotation?pageId=...`
- `PUT /books/:bookId/pages/:pageNumber/image?pageId=...`
- `POST /books/:bookId/pages/:pageNumber/rerun-ocr?pageId=...`

The page GET additionally returns `page.pageId`; deletion additionally returns
`deletedPageId`. Existing request bodies and response fields otherwise remain
unchanged. Editing should send the returned `expectedUpdatedAt` version, required
by the visual editor and element endpoints. Selected deletion can use the existing
DELETE handler once per stable ID; it is not an atomic bulk deletion API.

The image GET additionally accepts `thumbnail=true|false` (default false). A true
value returns WebP at quality 75, auto-oriented and rotated by the page's stored
`source_image_rotation`, resized to fit inside 360x480 without enlargement. The
thumbnail is already rotated; do not rotate it again in the gallery. Existing
image requests without this flag, or with false, return unchanged source bytes
and their original MIME type. `original=true` remains supported with either
variant. Thumbnail responses use a private revalidation cache policy and an ETag
derived from the source checksum (or a hash of source bytes when absent), file/page
identity, page rotation/version and variant. Matching `If-None-Match` returns 304
after authorization, without encoding a thumbnail. Source BLOBs are still read
server-side; no persistent thumbnail cache is introduced.

## Persistent OCR Selection

All OCR selection endpoints require EDITOR or higher. OCR is supported only for
IMAGES pages with a stored image, matching the existing single-page OCR restriction.

`POST /books/:bookId/ocr-jobs` request:

```ts
{
  pageIds: string[]; // 1..1000 unique IDs, processed in the supplied order.
  advancedLayout?: boolean; // Default false.
  ocrMode?: "AUTO" | "LOCAL" | "VISION" | "TEXTRACT"; // Default TEXTRACT.
  ocrModel?: string; // 1..255 characters.
  promptOverride?: string; // Up to 4000 characters.
}
```

The server validates every selected page before enqueueing and snapshots each
page version. Missing pages return 404; unsupported pages return 409. Success is
202 with the job directly, not a wrapper:

```ts
{
  jobId: string; bookId: string;
  status: "PENDING" | "RUNNING" | "READY" | "FAILED" | "CANCELLED";
  cancelRequested: boolean; attemptCount: number;
  total: number; completed: number; failed: number; processed: number;
  progress: number; // Fraction 0..1, processed / total.
  pages: Array<{ pageId: string; expectedUpdatedAt: string;
    status: "PENDING" | "READY" | "FAILED"; error?: string }>;
  error: string | null;
}
```

- `GET /books/:bookId/ocr-jobs/:jobId` returns the persisted job.
- `POST /books/:bookId/ocr-jobs/:jobId/cancel` returns the job. Pending jobs cancel
  immediately. Running jobs set `cancelRequested`; the current page may finish.
- `POST /books/:bookId/ocr-jobs/:jobId/retry` returns the job reset to PENDING.
  Only FAILED/CANCELLED jobs can be retried (otherwise 409). Completed pages are
  skipped, and unfinished pages retain their original version snapshots.

Jobs are real `processing_jobs` rows of type OCR_PAGE, with a purpose-discriminated
payload (`kind: GALLERY_OCR_SELECTION`). No database migration is required.
CANCELLED is represented as database status FAILED plus `last_error = CANCELLED`
to respect existing status constraints. A server worker polls every two seconds,
conditionally claims rows across API processes, and renews a ten-minute lease
every minute. Pending jobs and expired RUNNING leases resume after restart.
The creator's EDITOR access is rechecked for each page; credentials are resolved
server-side and never persisted in the job.

The worker invokes the same `rerun-ocr` handler as a direct request, passing the
selected stable page ID, its captured version, and all stored OCR options.
An explicit `ocrModel` overrides the account default in both paths. Retries retain
`ocrModel`, `ocrMode`, `advancedLayout`, `promptOverride`, and the original page
versions; they do not adopt new client options. Stored image rotation, book
language, margin hints, and the creator's effective credentials are resolved by
the shared handler at execution time. Advanced results use the same canonical
visual-document JSON and rendered HTML persistence, including colored and styled
containers. Identical options do not guarantee identical live provider output.

Single-page OCR handlers (including worker calls) recheck current EDITOR access
on the same connection after acquiring the book lock and immediately before
commit. Rerun additionally checks after provider completion before saving OCR
output. Permission loss fails
the page and rolls back its transaction. Enqueue, cancel and retry also recheck
EDITOR after their lock wait and before commit.

Cancellation cannot interrupt an OCR provider request already in flight. Stale,
deleted, edited or reordered pages fail safely rather than overwrite content.
Re-enqueue a fresh selection after refreshing when a version is stale. Retry is
intended for provider/transient failures, not to bypass version conflicts.
If the server crashes between committing page content and checkpointing the job,
recovery can mark that page FAILED on its version conflict; it will not silently
repeat/overwrite the completed OCR. No exactly-once provider execution is claimed.

## Reader Progress

`PUT /books/:bookId/progress` requires VIEWER or higher. Modern reader clients
must send the stable paragraph ID from the page response:

```ts
{
  paragraphId: string; // UUID of the current active paragraph in this book.
  audioOffsetMs?: number; // Nonnegative integer, defaults to 0.
  currentPageNumber?: number;
  currentParagraphNumber?: number;
  currentSequenceNumber?: number;
  readingPercentage?: number;
}
```

Success remains 204 with no body. The server holds the book lock while resolving
the paragraph ID and saving progress. With `paragraphId`, supplied numeric
coordinates are ignored and replaced by the paragraph's current database
coordinates. Reading percentage is always recomputed server-side. Deleted,
foreign-book and inactive IDs return 404 with `PROGRESS_PARAGRAPH_NOT_FOUND`,
without changing saved progress. Invalid/incomplete payloads return 400.

Shipped clients without `paragraphId` remain supported when they provide all
three numeric fields. The tuple must identify an active paragraph with matching
page, local paragraph and global sequence under the lock; inconsistent/stale
tuples return 409 with `PROGRESS_LOCATION_CONFLICT` and leave progress untouched.
Books containing no paragraphs accept the legacy `(valid page, 1, 1)` placeholder
at zero percent. A numeric tuple that also identifies a different paragraph after
reorder is inherently ambiguous without an ID. Only stable-ID clients are fully
protected from that case; refresh the reader after legacy conflicts.

Bookmark, highlight and note POST creation also hold the book lock before
reading paragraph/highlight coordinates, through annotation, sharing and audit
commit. This prevents new annotations from being persisted at pre-reorder
coordinates while another transaction saves a new order.

## Verification

The tests use fake database connections and Fastify injection, and cover gallery
shape, permission guards, IDs, ordering conflicts, transaction boundaries,
reference/link remapping, persisted selection progress, retry, cancellation and
lease ownership. Existing OCR/editor regression tests also exercise the reused
single-page handler. A live Oracle integration or provider OCR run is not included.

`advanced-layout-routes.test.ts` executes the extracted production worker adapter
and shared handler with mocked OCR/database dependencies, comparing direct and
queued calls across all four engines and stored rotations. It checks explicit
model precedence, prompt and advanced flags, credentials, hints, stable IDs,
version rejection, and canonical styled JSON/HTML writes. `gallery-ocr-jobs.test.ts`
also exercises enqueue, failed checkpoints, retry, and resumed processing with an
explicit model and advanced options preserved throughout.

Oracle query review used the initial schema and migrations 004, 005, 007, 015,
034 and SQL037, including CLOB types, numeric coordinate columns, unique/FK
constraints and job status checks. Cancellation finalization compares
`DBMS_LOB.SUBSTR(last_error, 4000, 1)` rather than the CLOB itself. Gallery previews
also convert paragraph CLOBs to bounded strings before selection; payload and
reordered document writes use explicit CLOB binds. The application fetches CLOBs
as strings, and same-connection role rechecks use Oracle's default READ COMMITTED
visibility. SQL assertions cover the cancellation comparison and the lock/claim
predicates; no claim of live Oracle execution is made.
