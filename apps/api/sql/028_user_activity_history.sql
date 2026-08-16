-- Migración para ampliar el historial de actividad de usuarios
-- Añadir campos de capítulo, duración y sesión a user_activity_events
-- y permitir acciones BOOK_IMPORTED y AUDIO_LISTENED

ALTER TABLE user_activity_events ADD (
  chapter_title VARCHAR2(500 CHAR),
  duration_seconds NUMBER(12) DEFAULT 0,
  session_id VARCHAR2(36 CHAR)
);

-- Actualizar restricción de tipo de acción
ALTER TABLE user_activity_events DROP CONSTRAINT ck_user_activity_action;

ALTER TABLE user_activity_events ADD CONSTRAINT ck_user_activity_action
  CHECK (action IN ('LOGIN', 'BOOK_VIEWED', 'BOOK_CREATED', 'BOOK_IMPORTED', 'BOOK_UPDATED', 'BOOK_DELETED', 'AUDIO_LISTENED'));
