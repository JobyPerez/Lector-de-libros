CREATE TABLE user_bookmarks (
  bookmark_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  paragraph_id VARCHAR2(36 CHAR) NOT NULL,
  page_number NUMBER NOT NULL,
  paragraph_number NUMBER NOT NULL,
  sequence_number NUMBER NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_user_bookmark_paragraph UNIQUE (user_id, book_id, paragraph_id),
  CONSTRAINT fk_user_bookmarks_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_bookmarks_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_bookmarks_paragraph FOREIGN KEY (paragraph_id) REFERENCES book_paragraphs (paragraph_id) ON DELETE CASCADE
);

CREATE TABLE user_highlights (
  highlight_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  paragraph_id VARCHAR2(36 CHAR) NOT NULL,
  page_number NUMBER NOT NULL,
  paragraph_number NUMBER NOT NULL,
  sequence_number NUMBER NOT NULL,
  color VARCHAR2(20 CHAR) NOT NULL,
  char_start NUMBER NOT NULL,
  char_end NUMBER NOT NULL,
  highlighted_text CLOB NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_user_highlights_color CHECK (color IN ('YELLOW', 'GREEN', 'BLUE', 'PINK')),
  CONSTRAINT ck_user_highlights_range CHECK (char_start >= 0 AND char_end > char_start),
  CONSTRAINT fk_user_highlights_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_highlights_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_highlights_paragraph FOREIGN KEY (paragraph_id) REFERENCES book_paragraphs (paragraph_id) ON DELETE CASCADE
);

CREATE TABLE user_notes (
  note_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  page_number NUMBER NOT NULL,
  paragraph_id VARCHAR2(36 CHAR),
  paragraph_number NUMBER,
  sequence_number NUMBER,
  highlight_id VARCHAR2(36 CHAR),
  note_text CLOB NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT fk_user_notes_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_notes_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_notes_paragraph FOREIGN KEY (paragraph_id) REFERENCES book_paragraphs (paragraph_id) ON DELETE SET NULL,
  CONSTRAINT fk_user_notes_highlight FOREIGN KEY (highlight_id) REFERENCES user_highlights (highlight_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_bookmarks_book ON user_bookmarks (book_id, user_id, page_number, sequence_number);
CREATE INDEX idx_user_highlights_book ON user_highlights (book_id, user_id, page_number, sequence_number);
CREATE INDEX idx_user_notes_book ON user_notes (book_id, user_id, page_number, sequence_number);

CREATE OR REPLACE TRIGGER trg_user_highlights_updated_at
BEFORE UPDATE ON user_highlights
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/

CREATE OR REPLACE TRIGGER trg_user_notes_updated_at
BEFORE UPDATE ON user_notes
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/