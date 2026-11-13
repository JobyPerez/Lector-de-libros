-- Book-wide comments and personal ordering of the notes/highlights tab.
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE user_book_comments (
      comment_id VARCHAR2(36 CHAR) NOT NULL,
      user_id VARCHAR2(36 CHAR) NOT NULL,
      book_id VARCHAR2(36 CHAR) NOT NULL,
      title VARCHAR2(300 CHAR),
      comment_text CLOB,
      created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
      CONSTRAINT pk_user_book_comments PRIMARY KEY (comment_id),
      CONSTRAINT fk_book_comments_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_book_comments_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
    )
  ]';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -955 THEN RAISE; END IF;
END;
/
BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX idx_book_comments_book ON user_book_comments (book_id, user_id)';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -955 THEN RAISE; END IF;
END;
/
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE user_annotation_order (
      user_id VARCHAR2(36 CHAR) NOT NULL,
      book_id VARCHAR2(36 CHAR) NOT NULL,
      entry_key VARCHAR2(60 CHAR) NOT NULL,
      position NUMBER(10) NOT NULL,
      CONSTRAINT pk_user_annotation_order PRIMARY KEY (user_id, book_id, entry_key),
      CONSTRAINT fk_annotation_order_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_annotation_order_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
    )
  ]';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -955 THEN RAISE; END IF;
END;
/
BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX idx_annotation_order_book ON user_annotation_order (book_id, user_id)';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -955 THEN RAISE; END IF;
END;
/
BEGIN
  EXECUTE IMMEDIATE 'ALTER TABLE annotation_shares DROP CONSTRAINT ck_annotation_shares_type';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -2443 THEN RAISE; END IF;
END;
/
ALTER TABLE annotation_shares ADD CONSTRAINT ck_annotation_shares_type CHECK (annotation_type IN ('bookmark', 'note', 'comment'))
/
CREATE OR REPLACE TRIGGER trg_annotation_shares_comment
BEFORE DELETE ON user_book_comments
FOR EACH ROW
BEGIN
  DELETE FROM annotation_shares
  WHERE annotation_id = :OLD.comment_id AND annotation_type = 'comment';
END;
/
-- Transfer each legacy value exactly once, in one transaction. Do not drop the
-- old column: keeping it empty allows a safe rollout alongside the old API.
DECLARE
  v_id VARCHAR2(32);
BEGIN
  FOR settings IN (
    SELECT user_id, book_id, user_comments, created_at, updated_at
    FROM user_book_settings
    WHERE user_comments IS NOT NULL AND DBMS_LOB.GETLENGTH(user_comments) > 0
    FOR UPDATE
  ) LOOP
    v_id := LOWER(RAWTOHEX(SYS_GUID()));
    INSERT INTO user_book_comments (comment_id, user_id, book_id, comment_text, created_at, updated_at)
    VALUES (
      SUBSTR(v_id, 1, 8) || '-' || SUBSTR(v_id, 9, 4) || '-' || SUBSTR(v_id, 13, 4) || '-' || SUBSTR(v_id, 17, 4) || '-' || SUBSTR(v_id, 21, 12),
      settings.user_id, settings.book_id, settings.user_comments, settings.created_at, settings.updated_at
    );
    UPDATE user_book_settings SET user_comments = NULL
    WHERE user_id = settings.user_id AND book_id = settings.book_id;
  END LOOP;
  COMMIT;
EXCEPTION WHEN OTHERS THEN
  ROLLBACK;
  RAISE;
END;
/
