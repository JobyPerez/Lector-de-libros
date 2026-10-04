-- Additive, idempotent migration. No historical text, identity or annotation is modified.
DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'BOOK_PAGES' AND column_name = 'VISUAL_DOCUMENT_JSON';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_pages ADD (visual_document_json CLOB)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'BOOK_PAGES' AND column_name = 'SOURCE_HTML_CONTENT';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_pages ADD (source_html_content CLOB)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'IS_ACTIVE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (is_active NUMBER(1) DEFAULT 1 NOT NULL)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'INCLUDE_IN_TOC';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (include_in_toc NUMBER(1))';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'IMAGE_WIDTH_PCT';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (image_width_pct NUMBER)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_AI_REQUESTS' AND column_name = 'IS_STALE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_ai_requests ADD (is_stale NUMBER(1) DEFAULT 0 NOT NULL)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SECTION_SUMMARIES' AND column_name = 'IS_STALE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_section_summaries ADD (is_stale NUMBER(1) DEFAULT 0 NOT NULL)';
  END IF;
END;
/

DECLARE
  constraint_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'BOOK_PAGES' AND constraint_name = 'CK_BOOK_PAGES_VISUAL_DOCUMENT';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_pages ADD CONSTRAINT ck_book_pages_visual_document CHECK (visual_document_json IS JSON STRICT WITH UNIQUE KEYS)';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'BOOK_PARAGRAPHS' AND constraint_name = 'CK_BOOK_PARAGRAPHS_ACTIVE';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD CONSTRAINT ck_book_paragraphs_active CHECK (is_active IN (0, 1))';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'BOOK_PARAGRAPHS' AND constraint_name = 'CK_BOOK_PARAGRAPHS_TOC';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD CONSTRAINT ck_book_paragraphs_toc CHECK (include_in_toc IN (0, 1))';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'BOOK_PARAGRAPHS' AND constraint_name = 'CK_BOOK_PARAGRAPHS_IMAGE_WIDTH';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD CONSTRAINT ck_book_paragraphs_image_width CHECK (image_width_pct BETWEEN 1 AND 100)';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'USER_BOOK_AI_REQUESTS' AND constraint_name = 'CK_BOOK_AI_REQUESTS_STALE';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_ai_requests ADD CONSTRAINT ck_book_ai_requests_stale CHECK (is_stale IN (0, 1))';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'USER_BOOK_SECTION_SUMMARIES' AND constraint_name = 'CK_BOOK_SECTION_SUMMARIES_STALE';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_section_summaries ADD CONSTRAINT ck_book_section_summaries_stale CHECK (is_stale IN (0, 1))';
  END IF;
END;
/
