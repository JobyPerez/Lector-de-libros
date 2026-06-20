DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'DEEPGRAM_API_KEY_ENCRYPTED';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (deepgram_api_key_encrypted VARCHAR2(2000 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'DEEPGRAM_TTS_MODEL';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (deepgram_tts_model VARCHAR2(100 CHAR))]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_REGION';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_region VARCHAR2(100 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_ACCESS_KEY_ID_ENCRYPTED';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_access_key_id_encrypted VARCHAR2(2000 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_SECRET_ACCESS_KEY_ENCRYPTED';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_secret_access_key_encrypted VARCHAR2(2000 CHAR))';
  END IF;
END;
/

COMMIT;
