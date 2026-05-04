CREATE TABLE user_book_ai_requests (
  request_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  scope_type VARCHAR2(20 CHAR) NOT NULL,
  chapter_id VARCHAR2(200 CHAR),
  section_title VARCHAR2(500 CHAR),
  start_page_number NUMBER,
  end_page_number NUMBER,
  start_paragraph_number NUMBER,
  end_paragraph_number NUMBER,
  start_sequence_number NUMBER,
  end_sequence_number NUMBER,
  prompt_text CLOB NOT NULL,
  response_text CLOB NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_user_book_ai_requests_scope CHECK (scope_type IN ('BOOK', 'SECTION')),
  CONSTRAINT fk_user_book_ai_requests_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_book_ai_requests_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_book_ai_requests_book
  ON user_book_ai_requests (user_id, book_id, scope_type, chapter_id, created_at);

CREATE OR REPLACE TRIGGER trg_user_book_ai_requests_updated_at
BEFORE UPDATE ON user_book_ai_requests
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/
