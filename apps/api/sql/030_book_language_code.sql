ALTER TABLE books ADD (
  language_code VARCHAR2(2 CHAR) DEFAULT 'es' NOT NULL
);

ALTER TABLE books ADD CONSTRAINT ck_books_language_code CHECK (language_code IN ('es', 'it'));
