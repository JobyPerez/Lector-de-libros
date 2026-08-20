DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'USERS'
    AND column_name = 'DEEPGRAM_TTS_MODEL_IT';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (deepgram_tts_model_it VARCHAR2(100 CHAR))]';
  END IF;
END;
/

COMMIT;
