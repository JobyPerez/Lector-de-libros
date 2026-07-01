-- 016_annotation_sharing.sql
-- Adds per-annotation sharing: each note/bookmark can be shared with a
-- specific subset of the users that have access to the parent book.

CREATE TABLE annotation_shares (
  annotation_id   VARCHAR2(36 CHAR) NOT NULL,
  annotation_type VARCHAR2(16 CHAR) NOT NULL,
  user_id         VARCHAR2(36 CHAR) NOT NULL,
  created_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_annotation_shares PRIMARY KEY (annotation_id, annotation_type, user_id),
  CONSTRAINT ck_annotation_shares_type CHECK (annotation_type IN ('bookmark', 'note')),
  CONSTRAINT fk_annotation_shares_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_annotation_shares_user_lookup
  ON annotation_shares (user_id, annotation_type);

CREATE OR REPLACE TRIGGER trg_annotation_shares_bookmark_cascade
BEFORE DELETE ON user_bookmarks
FOR EACH ROW
BEGIN
  DELETE FROM annotation_shares
   WHERE annotation_id = :OLD.bookmark_id
     AND annotation_type = 'bookmark';
END;
/

CREATE OR REPLACE TRIGGER trg_annotation_shares_note_cascade
BEFORE DELETE ON user_notes
FOR EACH ROW
BEGIN
  DELETE FROM annotation_shares
   WHERE annotation_id = :OLD.note_id
     AND annotation_type = 'note';
END;
/
