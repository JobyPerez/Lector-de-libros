CREATE TABLE user_book_section_summaries (
  summary_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  chapter_id VARCHAR2(200 CHAR) NOT NULL,
  section_title VARCHAR2(500 CHAR) NOT NULL,
  start_page_number NUMBER NOT NULL,
  end_page_number NUMBER NOT NULL,
  start_paragraph_number NUMBER NOT NULL,
  end_paragraph_number NUMBER NOT NULL,
  start_sequence_number NUMBER NOT NULL,
  end_sequence_number NUMBER NOT NULL,
  summary_text CLOB NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_user_book_section_summary UNIQUE (user_id, book_id, chapter_id),
  CONSTRAINT fk_user_book_section_summary_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_book_section_summary_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_book_section_summaries_book
  ON user_book_section_summaries (book_id, user_id, chapter_id, start_sequence_number, end_sequence_number);

CREATE OR REPLACE TRIGGER trg_user_book_section_summaries_updated_at
BEFORE UPDATE ON user_book_section_summaries
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/