ALTER TABLE book_pages ADD (
  source_image_rotation NUMBER DEFAULT 0 NOT NULL,
  CONSTRAINT ck_book_pages_image_rotation CHECK (source_image_rotation IN (0, 90, 180, 270))
);