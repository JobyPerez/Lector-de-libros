ALTER TABLE books ADD (
  outline_source VARCHAR2(30 CHAR)
);

ALTER TABLE books ADD CONSTRAINT ck_books_outline_source CHECK (outline_source IN ('EPUB_TOC', 'MANUAL'));

UPDATE books b
SET outline_source = 'MANUAL'
WHERE outline_source IS NULL
  AND EXISTS (
    SELECT 1
    FROM book_chapters c
    WHERE c.book_id = b.book_id
  );