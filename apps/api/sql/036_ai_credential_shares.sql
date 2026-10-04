DECLARE
  table_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO table_count FROM user_tables WHERE table_name = 'AI_CREDENTIAL_SHARES';
  IF table_count = 0 THEN
    EXECUTE IMMEDIATE q'[
      CREATE TABLE ai_credential_shares (
        share_id VARCHAR2(36 CHAR) NOT NULL,
        sharer_user_id VARCHAR2(36 CHAR) NOT NULL,
        recipient_user_id VARCHAR2(36 CHAR) NOT NULL,
        ia_type VARCHAR2(32 CHAR) NOT NULL,
        created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT pk_ai_credential_shares PRIMARY KEY (share_id),
        CONSTRAINT ck_ai_credential_shares_ia CHECK (ia_type IN ('AWS','OPENCODE_OCR','OPENCODE_SUMMARY','GOOGLE','DEEPGRAM')),
        CONSTRAINT uq_ai_credential_shares UNIQUE (sharer_user_id, recipient_user_id, ia_type)
      )
    ]';
  END IF;
END;
/

DECLARE
  index_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO index_count FROM user_indexes WHERE index_name = 'IX_AI_SHARES_RECIPIENT';
  IF index_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX ix_ai_shares_recipient ON ai_credential_shares (recipient_user_id, ia_type)';
  END IF;
END;
/

DECLARE
  index_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO index_count FROM user_indexes WHERE index_name = 'IX_AI_SHARES_SHARER';
  IF index_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX ix_ai_shares_sharer ON ai_credential_shares (sharer_user_id, ia_type)';
  END IF;
END;
/
