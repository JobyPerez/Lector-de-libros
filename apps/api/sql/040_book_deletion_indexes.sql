-- Oracle needs leading FK indexes to avoid table-level locks when cascading
-- concurrent book deletions. ONLINE creation leaves normal DML available.
DECLARE
  PROCEDURE ensure_index(table_name_in VARCHAR2, column_name_in VARCHAR2, index_name_in VARCHAR2) IS
    existing_count NUMBER;
  BEGIN
    SELECT COUNT(*) INTO existing_count
    FROM user_ind_columns c JOIN user_indexes i ON i.index_name = c.index_name
    WHERE c.table_name = table_name_in AND c.column_name = column_name_in
      AND c.column_position = 1 AND i.status = 'VALID';
    IF existing_count = 0 THEN
      EXECUTE IMMEDIATE 'CREATE INDEX ' || index_name_in || ' ON ' || table_name_in || ' (' || column_name_in || ') ONLINE';
    END IF;
  END;
BEGIN
  ensure_index('BOOK_PAGES', 'SOURCE_FILE_ID', 'IDX_BP_SOURCE_FILE');
  ensure_index('BOOK_PARAGRAPHS', 'AUDIO_FILE_ID', 'IDX_BPAR_AUDIO_FILE');
  ensure_index('BOOK_PARAGRAPHS', 'PAGE_ID', 'IDX_BPAR_PAGE');
  ensure_index('PROCESSING_JOBS', 'BOOK_ID', 'IDX_PJ_BOOK');
  ensure_index('PROCESSING_JOBS', 'PAGE_ID', 'IDX_PJ_PAGE');
  ensure_index('USER_BOOKMARKS', 'PARAGRAPH_ID', 'IDX_UBM_PARAGRAPH');
  ensure_index('USER_BOOK_AI_REQUESTS', 'BOOK_ID', 'IDX_UBAI_BOOK');
  ensure_index('USER_BOOK_PROGRESS', 'BOOK_ID', 'IDX_UBP_BOOK');
  ensure_index('USER_HIGHLIGHTS', 'PARAGRAPH_ID', 'IDX_UH_PARAGRAPH');
  ensure_index('USER_NOTES', 'PARAGRAPH_ID', 'IDX_UN_PARAGRAPH');
END;
/
