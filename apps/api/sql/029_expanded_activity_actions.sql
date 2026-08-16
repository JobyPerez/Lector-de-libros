-- Migración para ampliar tipos de acción y metadatos de actividad
-- (page_number, detail, y ampliar action a VARCHAR2(50 CHAR))

ALTER TABLE user_activity_events ADD (
  page_number NUMBER(6),
  detail VARCHAR2(1000 CHAR)
);

ALTER TABLE user_activity_events MODIFY (
  action VARCHAR2(50 CHAR)
);

-- Actualizar restricción de tipo de acción
ALTER TABLE user_activity_events DROP CONSTRAINT ck_user_activity_action;

ALTER TABLE user_activity_events ADD CONSTRAINT ck_user_activity_action CHECK (
  action IN (
    'LOGIN',
    'LOGOUT',
    'PROFILE_UPDATED',
    'PASSWORD_RESET',
    'BOOK_VIEWED',
    'BOOK_CREATED',
    'BOOK_IMPORTED',
    'BOOK_UPDATED',
    'BOOK_DELETED',
    'BOOK_EXPORTED',
    'BOOK_STATUS_UPDATED',
    'BOOK_RATED',
    'BOOK_SHARED',
    'BOOK_UNSHARED',
    'BOOK_TRANSFERRED',
    'AUDIO_LISTENED',
    'OCR_UPDATED',
    'PAGE_OCR_RERUN',
    'PAGE_IMAGE_ROTATED',
    'PAGE_IMAGE_UPDATED',
    'PAGE_DELETED',
    'PAGES_IMPORTED',
    'BOOKMARK_CREATED',
    'BOOKMARK_DELETED',
    'NOTE_CREATED',
    'NOTE_UPDATED',
    'NOTE_DELETED',
    'HIGHLIGHT_CREATED',
    'HIGHLIGHT_DELETED',
    'AI_REQUEST_CREATED',
    'AI_REQUEST_DELETED',
    'CHAPTER_SUMMARY_GENERATED',
    'USER_CREATED',
    'USER_UPDATED',
    'USER_DELETED'
  )
);
