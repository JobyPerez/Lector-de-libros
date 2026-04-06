ALTER TABLE book_pages ADD (
  page_label VARCHAR2(50 CHAR),
  page_type VARCHAR2(20 CHAR) DEFAULT 'BODY' NOT NULL,
  CONSTRAINT ck_book_pages_page_type CHECK (page_type IN ('COVER', 'FRONTMATTER', 'BODY', 'BACKMATTER'))
);

CREATE TABLE book_chapters (
  chapter_id VARCHAR2(36 CHAR) PRIMARY KEY,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  title VARCHAR2(500 CHAR) NOT NULL,
  heading_level NUMBER DEFAULT 1 NOT NULL,
  page_number NUMBER NOT NULL,
  paragraph_number NUMBER DEFAULT 1 NOT NULL,
  sequence_number NUMBER NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_book_chapters_level CHECK (heading_level BETWEEN 1 AND 6),
  CONSTRAINT uq_book_chapters_sequence UNIQUE (book_id, sequence_number),
  CONSTRAINT fk_book_chapters_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE INDEX idx_book_chapters_book ON book_chapters (book_id, sequence_number, page_number, paragraph_number);

CREATE OR REPLACE TRIGGER trg_book_chapters_updated_at
BEFORE UPDATE ON book_chapters
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/