CREATE TABLE users (
  user_id VARCHAR2(36 CHAR) PRIMARY KEY,
  username VARCHAR2(50 CHAR) NOT NULL,
  email VARCHAR2(255 CHAR) NOT NULL,
  display_name VARCHAR2(120 CHAR),
  password_hash VARCHAR2(255 CHAR) NOT NULL,
  role VARCHAR2(20 CHAR) DEFAULT 'EDITOR' NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_users_role CHECK (role IN ('ADMIN', 'EDITOR')),
  CONSTRAINT uq_users_username UNIQUE (username),
  CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE TABLE user_refresh_tokens (
  refresh_token_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  token_hash VARCHAR2(64 CHAR) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  user_agent VARCHAR2(500 CHAR),
  ip_address VARCHAR2(45 CHAR),
  CONSTRAINT uq_refresh_tokens_hash UNIQUE (token_hash),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE password_reset_tokens (
  reset_token_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  token_hash VARCHAR2(64 CHAR) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  CONSTRAINT uq_password_reset_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_password_reset_tokens_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE books (
  book_id VARCHAR2(36 CHAR) PRIMARY KEY,
  owner_user_id VARCHAR2(36 CHAR) NOT NULL,
  title VARCHAR2(500 CHAR) NOT NULL,
  author_name VARCHAR2(255 CHAR),
  synopsis CLOB,
  source_type VARCHAR2(20 CHAR) NOT NULL,
  status VARCHAR2(20 CHAR) DEFAULT 'DRAFT' NOT NULL,
  total_pages NUMBER DEFAULT 0 NOT NULL,
  total_paragraphs NUMBER DEFAULT 0 NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_books_source_type CHECK (source_type IN ('PDF', 'EPUB', 'IMAGES')),
  CONSTRAINT ck_books_status CHECK (status IN ('DRAFT', 'PROCESSING', 'READY', 'FAILED')),
  CONSTRAINT fk_books_owner FOREIGN KEY (owner_user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE book_files (
  file_id VARCHAR2(36 CHAR) PRIMARY KEY,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  file_kind VARCHAR2(20 CHAR) NOT NULL,
  file_name VARCHAR2(500 CHAR),
  mime_type VARCHAR2(100 CHAR) NOT NULL,
  page_number NUMBER,
  paragraph_number NUMBER,
  byte_size NUMBER NOT NULL,
  checksum_sha256 VARCHAR2(64 CHAR),
  content_blob BLOB NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_book_files_kind CHECK (file_kind IN ('ORIGINAL_PDF', 'ORIGINAL_EPUB', 'PAGE_IMAGE', 'COVER_IMAGE', 'TTS_AUDIO')),
  CONSTRAINT fk_book_files_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE TABLE book_pages (
  page_id VARCHAR2(36 CHAR) PRIMARY KEY,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  page_number NUMBER NOT NULL,
  source_file_id VARCHAR2(36 CHAR),
  raw_text CLOB,
  edited_text CLOB,
  ocr_status VARCHAR2(20 CHAR) DEFAULT 'PENDING' NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_book_pages_number UNIQUE (book_id, page_number),
  CONSTRAINT ck_book_pages_ocr_status CHECK (ocr_status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'SKIPPED')),
  CONSTRAINT fk_book_pages_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_pages_file FOREIGN KEY (source_file_id) REFERENCES book_files (file_id) ON DELETE SET NULL
);

CREATE TABLE book_paragraphs (
  paragraph_id VARCHAR2(36 CHAR) PRIMARY KEY,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  page_id VARCHAR2(36 CHAR),
  page_number NUMBER NOT NULL,
  paragraph_number NUMBER NOT NULL,
  sequence_number NUMBER NOT NULL,
  paragraph_text CLOB NOT NULL,
  audio_file_id VARCHAR2(36 CHAR),
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_book_paragraphs_sequence UNIQUE (book_id, sequence_number),
  CONSTRAINT uq_book_paragraphs_page_order UNIQUE (book_id, page_number, paragraph_number),
  CONSTRAINT fk_book_paragraphs_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_paragraphs_page FOREIGN KEY (page_id) REFERENCES book_pages (page_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_paragraphs_audio FOREIGN KEY (audio_file_id) REFERENCES book_files (file_id) ON DELETE SET NULL
);

CREATE TABLE user_book_progress (
  progress_id VARCHAR2(36 CHAR) PRIMARY KEY,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  book_id VARCHAR2(36 CHAR) NOT NULL,
  current_page_number NUMBER DEFAULT 1 NOT NULL,
  current_paragraph_number NUMBER DEFAULT 1 NOT NULL,
  current_sequence_number NUMBER DEFAULT 1 NOT NULL,
  audio_offset_ms NUMBER DEFAULT 0 NOT NULL,
  reading_percentage NUMBER(5,2) DEFAULT 0 NOT NULL,
  last_opened_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_user_book_progress UNIQUE (user_id, book_id),
  CONSTRAINT ck_user_book_progress_percentage CHECK (reading_percentage >= 0 AND reading_percentage <= 100),
  CONSTRAINT fk_user_book_progress_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_book_progress_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE
);

CREATE TABLE processing_jobs (
  job_id VARCHAR2(36 CHAR) PRIMARY KEY,
  book_id VARCHAR2(36 CHAR),
  page_id VARCHAR2(36 CHAR),
  job_type VARCHAR2(20 CHAR) NOT NULL,
  status VARCHAR2(20 CHAR) DEFAULT 'PENDING' NOT NULL,
  attempt_count NUMBER DEFAULT 0 NOT NULL,
  payload_json CLOB,
  last_error CLOB,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  CONSTRAINT ck_processing_jobs_type CHECK (job_type IN ('PARSE_PDF', 'PARSE_EPUB', 'OCR_PAGE', 'GENERATE_TTS')),
  CONSTRAINT ck_processing_jobs_status CHECK (status IN ('PENDING', 'RUNNING', 'READY', 'FAILED')),
  CONSTRAINT fk_processing_jobs_book FOREIGN KEY (book_id) REFERENCES books (book_id) ON DELETE CASCADE,
  CONSTRAINT fk_processing_jobs_page FOREIGN KEY (page_id) REFERENCES book_pages (page_id) ON DELETE CASCADE
);

CREATE INDEX idx_books_owner ON books (owner_user_id);
CREATE INDEX idx_book_files_book_kind ON book_files (book_id, file_kind);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens (user_id, expires_at);
CREATE INDEX idx_user_refresh_tokens_user ON user_refresh_tokens (user_id, expires_at);
CREATE INDEX idx_processing_jobs_status ON processing_jobs (status, job_type, created_at);

CREATE OR REPLACE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/

CREATE OR REPLACE TRIGGER trg_books_updated_at
BEFORE UPDATE ON books
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/

CREATE OR REPLACE TRIGGER trg_book_pages_updated_at
BEFORE UPDATE ON book_pages
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/

CREATE OR REPLACE TRIGGER trg_user_book_progress_updated_at
BEFORE UPDATE ON user_book_progress
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/