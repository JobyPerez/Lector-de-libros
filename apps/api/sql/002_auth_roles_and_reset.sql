DECLARE
  role_column_count NUMBER;
BEGIN
  SELECT COUNT(*)
  INTO role_column_count
  FROM user_tab_columns
  WHERE table_name = 'USERS'
    AND column_name = 'ROLE';

  IF role_column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (role VARCHAR2(20 CHAR) DEFAULT 'EDITOR' NOT NULL)]';
  END IF;
END;
/

DECLARE
  role_constraint_count NUMBER;
BEGIN
  SELECT COUNT(*)
  INTO role_constraint_count
  FROM user_constraints
  WHERE table_name = 'USERS'
    AND constraint_name = 'CK_USERS_ROLE';

  IF role_constraint_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD CONSTRAINT ck_users_role CHECK (role IN ('ADMIN', 'EDITOR'))]';
  END IF;
END;
/

UPDATE users
SET role = 'ADMIN'
WHERE LOWER(username) = 'joby';

UPDATE users
SET role = 'EDITOR'
WHERE LOWER(username) <> 'joby'
  AND role IS NULL;

DECLARE
  password_reset_table_count NUMBER;
BEGIN
  SELECT COUNT(*)
  INTO password_reset_table_count
  FROM user_tables
  WHERE table_name = 'PASSWORD_RESET_TOKENS';

  IF password_reset_table_count = 0 THEN
    EXECUTE IMMEDIATE q'[
      CREATE TABLE password_reset_tokens (
        reset_token_id VARCHAR2(36 CHAR) PRIMARY KEY,
        user_id VARCHAR2(36 CHAR) NOT NULL,
        token_hash VARCHAR2(64 CHAR) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        CONSTRAINT uq_password_reset_token_hash UNIQUE (token_hash),
        CONSTRAINT fk_password_reset_tokens_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
      )
    ]';
  END IF;
END;
/

DECLARE
  reset_index_count NUMBER;
BEGIN
  SELECT COUNT(*)
  INTO reset_index_count
  FROM user_indexes
  WHERE index_name = 'IDX_PASSWORD_RESET_TOKENS_USER';

  IF reset_index_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens (user_id, expires_at)';
  END IF;
END;
/

COMMIT;