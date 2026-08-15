-- 025_user_appearance_settings.sql
-- Adds theme mode and palette preference columns to users table.

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'THEME_MODE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (theme_mode VARCHAR2(20 CHAR) DEFAULT 'system')]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'THEME_PALETTE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (theme_palette VARCHAR2(30 CHAR) DEFAULT 'default')]';
  END IF;
END;
/

COMMIT;
