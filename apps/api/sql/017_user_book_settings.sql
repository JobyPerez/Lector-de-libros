-- 017_user_book_settings.sql
-- Stores per-user settings for each accessible book.

CREATE TABLE user_book_settings (
  user_id         VARCHAR2(36 CHAR) NOT NULL,
  book_id         VARCHAR2(36 CHAR) NOT NULL,
  notion_book_url VARCHAR2(2000 CHAR),
  created_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_user_book_settings PRIMARY KEY (user_id, book_id),
  CONSTRAINT fk_user_book_settings_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_book_settings_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_book_settings_book ON user_book_settings (book_id, user_id);

INSERT INTO user_book_settings (user_id, book_id, notion_book_url)
SELECT owner_user_id, book_id, notion_book_url
FROM books
WHERE notion_book_url IS NOT NULL;

ALTER TABLE books DROP COLUMN notion_book_url;
