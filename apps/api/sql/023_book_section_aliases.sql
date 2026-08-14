CREATE TABLE book_section_aliases (
  book_id VARCHAR2(36 CHAR) NOT NULL,
  old_chapter_id VARCHAR2(200 CHAR) NOT NULL,
  new_chapter_id VARCHAR2(200 CHAR) NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_book_section_aliases PRIMARY KEY (book_id, old_chapter_id),
  CONSTRAINT fk_book_section_aliases_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE INDEX idx_book_section_aliases_new
  ON book_section_aliases (book_id, new_chapter_id);
