-- Stable physical PDF sheet identity, independent of gallery reordering.
DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns
    WHERE table_name = 'BOOK_PAGES' AND column_name = 'SOURCE_PDF_PAGE_NUMBER';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_pages ADD (source_pdf_page_number NUMBER(6) CONSTRAINT ck_pages_pdf_number CHECK (source_pdf_page_number >= 1 AND source_pdf_page_number = TRUNC(source_pdf_page_number)))';
  END IF;
END;
/
