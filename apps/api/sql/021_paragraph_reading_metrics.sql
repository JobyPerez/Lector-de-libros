DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'WORD_COUNT';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (word_count NUMBER DEFAULT 0 NOT NULL)';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'BOOK_PARAGRAPHS' AND column_name = 'TTS_CHARACTER_COUNT';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE book_paragraphs ADD (tts_character_count NUMBER DEFAULT 0 NOT NULL)';
  END IF;
END;
/

-- Populate existing rows with: npm run backfill:paragraph-reading-metrics --workspace @lector/api
