-- 015_book_sharing.sql
-- Adds book sharing: per-book roles (viewer/commenter/editor) and
-- a per-book flag to share user annotations between users with access.

CREATE TABLE book_shares (
  book_id     VARCHAR2(36 CHAR) NOT NULL,
  user_id     VARCHAR2(36 CHAR) NOT NULL,
  role        VARCHAR2(16 CHAR) NOT NULL,
  invited_by  VARCHAR2(36 CHAR),
  created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_book_shares PRIMARY KEY (book_id, user_id),
  CONSTRAINT ck_book_shares_role CHECK (role IN ('viewer', 'commenter', 'editor')),
  CONSTRAINT fk_book_shares_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_shares_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_shares_invited_by FOREIGN KEY (invited_by) REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_book_shares_user ON book_shares (user_id, book_id);

-- Audit log for share-related actions.
CREATE TABLE book_share_audit_log (
  log_id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id        VARCHAR2(36 CHAR) NOT NULL,
  actor_user_id  VARCHAR2(36 CHAR),
  target_user_id VARCHAR2(36 CHAR),
  action         VARCHAR2(32 CHAR) NOT NULL,
  details        VARCHAR2(2000 CHAR),
  created_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT fk_book_share_audit_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_share_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_book_share_audit_target FOREIGN KEY (target_user_id) REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_book_share_audit_book ON book_share_audit_log (book_id, created_at);

-- Per-book flag: when 'Y', users with commenter/editor/owner role can
-- see each other's notes, highlights and bookmarks. Default 'N' keeps
-- the historical "private annotations" behaviour.
ALTER TABLE books ADD (
  share_user_annotations CHAR(1 CHAR) DEFAULT 'N' NOT NULL,
  CONSTRAINT ck_books_share_user_annotations CHECK (share_user_annotations IN ('Y', 'N'))
);
