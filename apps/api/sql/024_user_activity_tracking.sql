CREATE TABLE user_activity_events (
  activity_id VARCHAR2(36 CHAR) NOT NULL,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  action VARCHAR2(30 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR),
  book_title VARCHAR2(500 CHAR),
  ip_address VARCHAR2(64 CHAR),
  user_agent VARCHAR2(1000 CHAR),
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_user_activity_events PRIMARY KEY (activity_id),
  CONSTRAINT fk_user_activity_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT ck_user_activity_action CHECK (action IN ('LOGIN', 'BOOK_VIEWED', 'BOOK_CREATED', 'BOOK_UPDATED', 'BOOK_DELETED'))
);

CREATE INDEX idx_user_activity_user_date
  ON user_activity_events (user_id, created_at DESC);

CREATE INDEX idx_user_activity_book
  ON user_activity_events (book_id, created_at DESC);

CREATE TABLE user_reading_sessions (
  session_id VARCHAR2(36 CHAR) NOT NULL,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  duration_seconds NUMBER(12) DEFAULT 0 NOT NULL,
  started_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  last_activity_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_user_reading_sessions PRIMARY KEY (session_id),
  CONSTRAINT fk_reading_session_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_reading_session_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT ck_reading_session_duration CHECK (duration_seconds >= 0)
);

CREATE INDEX idx_reading_sessions_user_date
  ON user_reading_sessions (user_id, last_activity_at DESC);

CREATE INDEX idx_reading_sessions_book
  ON user_reading_sessions (book_id, last_activity_at DESC);
