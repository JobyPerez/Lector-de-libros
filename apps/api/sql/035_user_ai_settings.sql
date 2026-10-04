DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'OPENCODE_API_KEY_ENCRYPTED';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (opencode_api_key_encrypted VARCHAR2(2000 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'GEMINI_API_KEY_ENCRYPTED';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (gemini_api_key_encrypted VARCHAR2(2000 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'OPENCODE_OCR_MODEL';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (opencode_ocr_model VARCHAR2(255 CHAR))]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'OPENCODE_SUMMARY_MODEL';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (opencode_summary_model VARCHAR2(255 CHAR))]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'OPENCODE_OCR_VISIBLE_MODELS';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (opencode_ocr_visible_models CLOB)';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'OPENCODE_SUMMARY_VISIBLE_MODELS';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE users ADD (opencode_summary_visible_models CLOB)';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'SHARE_AWS';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (share_aws CHAR(1 CHAR) DEFAULT '0')]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'SHARE_OPENCODE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (share_opencode CHAR(1 CHAR) DEFAULT '0')]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'SHARE_GOOGLE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (share_google CHAR(1 CHAR) DEFAULT '0')]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'SHARE_DEEPGRAM';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (share_deepgram CHAR(1 CHAR) DEFAULT '0')]';
  END IF;
END;
/

