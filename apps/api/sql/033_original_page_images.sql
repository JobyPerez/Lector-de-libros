-- No historical backfill: preserve the current source on its first future edit.
ALTER TABLE book_files DROP CONSTRAINT ck_book_files_kind;
ALTER TABLE book_files ADD CONSTRAINT ck_book_files_kind
  CHECK (file_kind IN ('ORIGINAL_PDF', 'ORIGINAL_EPUB', 'PAGE_IMAGE', 'ORIGINAL_PAGE_IMAGE', 'COVER_IMAGE', 'CONTENT_IMAGE', 'TTS_AUDIO'));

-- file_name stores the stable source_file_id for this kind, not a page number.
CREATE UNIQUE INDEX uq_book_files_original_source ON book_files (
  CASE WHEN file_kind = 'ORIGINAL_PAGE_IMAGE' THEN book_id END,
  CASE WHEN file_kind = 'ORIGINAL_PAGE_IMAGE' THEN file_name END
);
