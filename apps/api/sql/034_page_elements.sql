-- Additive and idempotent. Legacy paragraphs remain body/read_aloud=1.
DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns
    WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'ELEMENT_ROLE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (element_role VARCHAR2(32) DEFAULT ''body'' NOT NULL)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns
    WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'READ_ALOUD';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (read_aloud NUMBER(1) DEFAULT 1 NOT NULL)';
  END IF;
  SELECT COUNT(*) INTO column_count FROM user_tab_columns
    WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'GEOMETRY_JSON';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (geometry_json CLOB)';
  END IF;
END;
/

DECLARE
  constraint_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO constraint_count FROM user_constraints
    WHERE table_name = 'BOOK_PARAGRAPHS' AND constraint_name = 'CK_BOOK_PARAGRAPHS_READ_ALOUD';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD CONSTRAINT ck_book_paragraphs_read_aloud CHECK (read_aloud IN (0, 1))';
  END IF;
  SELECT COUNT(*) INTO constraint_count FROM user_constraints
    WHERE table_name = 'BOOK_PARAGRAPHS' AND constraint_name = 'CK_BOOK_PARAGRAPHS_GEOMETRY';
  IF constraint_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD CONSTRAINT ck_book_paragraphs_geometry CHECK (geometry_json IS JSON STRICT WITH UNIQUE KEYS)';
  END IF;
END;
/
