# Frontend Gallery Contract

All requests use the existing bearer-token transport and automatic session refresh. TypeScript interfaces live in `src/app/api.ts` and align with `apps/api/PAGE_GALLERY_API.md`.

## Gallery and Ordering

- `GET /books/:bookId` uses the existing `{ book: BookSummary }` response and `currentUserRole` permissions.
- `GET /books/:bookId/pages` returns `{ pages: BookGalleryPage[], pageIds: string[], capabilities: { reorder: boolean } }`, sorted by persisted position.
- Each page includes immutable `pageId`, numeric `position` and `pageNumber`, nullable `pageLabel`, `pageType`, `paragraphCount`, `source: { type, fileId, mimeType, rotation }`, `updatedAt`, `ocrStatus`, `preview: { kind: "IMAGE" | "CONTENT", text: string, contentUrl: string, imageUrl: string | null }`, and `capabilities: { edit, delete, reorder, ocr, visualEditor }` booleans. `preview.text` is a plain-text excerpt of up to 500 characters from the first active paragraph. The frontend never renders it as HTML.
- `POST /books/:bookId/pages/reorder` accepts `{ pageIds: string[], expectedPageIds: string[] }`. Both contain complete orders, with `pageIds` a permutation. Return the same gallery response. Reject stale expected order with HTTP 409 without changing anything.
- Existing `GET /books/:bookId/pages/:pageNumber/image?v=:updatedAt&pageId=:pageId&thumbnail=true` returns an authenticated thumbnail blob for the gallery. Resolve `pageId` within the book before using the numeric address. Images are fetched only near the viewport; object URLs are revoked. Gallery cache keys include a `thumbnail` variant. `fetchBookPageImage` accepts an optional final thumbnail flag (default false); reader, original-image and editor calls remain unchanged and full size.
- Existing `GET /books/:bookId/pages/:pageNumber?pageId=:pageId` returns `BookPageResponse`. This provides lazy plain-text content when the gallery excerpt is empty, including imported PDF/EPUB pages.
- Existing `DELETE /books/:bookId/pages/:pageNumber?pageId=:pageId` returns `{ book, deletedPageId, deletedPageNumber, nextPageNumber }`. Resolve the immutable ID first, never delete a different page at a stale number. Bulk deletion confirms once and calls this sequentially. It is not transactional across the selection: failures report completed deletions and refresh affected caches.

## Persistent OCR

- `POST /books/:bookId/ocr-jobs` accepts `{ pageIds: string[], ocrMode: "LOCAL" | "VISION" | "TEXTRACT", advancedLayout: boolean }`. LOCAL always sends `advancedLayout: false`. Selected pages must have images in an IMAGES book, and the requester must be an editor/owner. Return HTTP 202 with the job directly, not a `{ job }` envelope.
- `GET /books/:bookId/ocr-jobs/:jobId` returns the same job shape. Poll every two seconds while PENDING/RUNNING.
- `POST /books/:bookId/ocr-jobs/:jobId/cancel` and `/retry` return that job shape. Retry only incomplete/failed pages; completed page identities remain unchanged.
- Job shape: `{ jobId, bookId, status: "PENDING" | "RUNNING" | "READY" | "FAILED" | "CANCELLED", cancelRequested: boolean, attemptCount: number, total: number, completed: number, failed: number, processed: number, progress: number, pages: [{ pageId, expectedUpdatedAt, status: "PENDING" | "READY" | "FAILED", error?: string }], error: string | null }`.
- The server persists execution and errors. The frontend stores the latest job ID per user/book in localStorage so navigation and reload resume monitoring. There is no job-list endpoint requirement. Jobs started in another browser/device cannot be discovered from this frontend.
- Pending/failed OCR selection shortcuts use current job page status when available, otherwise listing OCR status, and include only existing OCR-capable pages. Any job-polling error offers Close tracking: this clears local tracking and unlocks the gallery without sending a cancellation request. The UI explicitly warns that the server job is not cancelled.

## Navigation and Safety

Reader's gallery button immediately follows Edit page. Gallery Read/Edit links first resolve the immutable page ID against a fresh listing, then enter the existing reader/builder with `pageId` / `reviewPageId` and a gallery `returnTo`. Reader and builder GETs retain that ID even if the listed number becomes stale before the fetch. Successful numeric navigation pins the returned `page.pageId`; explicit navigation to another position releases the old ID. Returned page numbers update display and canonical URLs (builder URL normalization waits while a draft is dirty). Numeric and immutable-ID cache keys are distinct; builder keys also isolate inactive editor content from reader content. The reader waits for route/progress hydration before pinning a cached page.

The reader gallery link includes the source `pageId` and numeric `page` hint. The gallery retains this query string through Read/Edit destinations and their `returnTo`, highlights the immutable source separately from selection, and scrolls to it once when loaded. Back to reader uses that source ID with its current persisted number. A deleted source never falls back to a different page at the old position. Compact/normal/large preview controls adjust card density without changing origin, selection, order or image request variant.

Builder draft identity is `bookId:pageId`, not position. Visual saves, edited-image uploads (including crop/rotation), rerun OCR and deletion send the loaded page ID. Image uploads snapshot it before asynchronous rendering. Transport helpers for OCR text, elements and image rotation also accept the immutable ID. All use the backend's `?pageId` targeting, with exact `expectedUpdatedAt` where supported; a deleted ID fails rather than falling back to another page. Original-image viewing retains the same ID. Builder-to-reader navigation retains it too.

Reader `PUT /books/:bookId/progress` includes `paragraphId` alongside existing numeric progress fields. The backend resolves that paragraph's current page/paragraph/sequence/percentage under the book lock instead of writing stale numeric positions after a reorder. Progress deduplication includes paragraph identity. Audio-block progress also supplies its stable paragraph ID.

Selection uses IDs, including additive Shift/range selection and stable multi-page moves. Drag/drop uses the same before/after operation as mobile/keyboard selects. Order is a local draft until Save order. Cancel discards it. Existing route/unload/logout warnings protect unsaved order; deletion and OCR are disabled until order is saved or cancelled. Mutations require book role and page capabilities. The current known active OCR job disables ordering/deletion; unknown jobs from other devices require server-side protection.

## Verification

`npm run typecheck --workspace @lector/web`

`npm run test --workspace @lector/web`

`test/page-gallery.test.ts` covers stable permutations/ranges, authenticated contracts, viewer permissions, escaped EPUB preview, mobile move, explicit Save/Cancel, deletion confirmation, origin highlighting/scrolling/return routes, preview density, OCR shortcuts and tracking dismissal using synthetic React DOM fixtures. `test/page-identity.test.ts` evaluates the actual query configurations, navigation effects and mutation handlers against synthetic transports to cover reorder races, cache isolation, stable image targets, gallery-only thumbnail requests, draft identity and paragraph-anchored progress. Visual-save/OCR recovery tests also assert immutable targets. Real API/database integration and real Chromium/mobile screenshots are not covered by these fixtures.
