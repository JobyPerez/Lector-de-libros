CREATE TABLE user_book_ai_request_tts_audio_cache (
  request_id VARCHAR2(36 CHAR) NOT NULL,
  voice_model VARCHAR2(100 CHAR) NOT NULL,
  text_checksum_sha256 VARCHAR2(64 CHAR) NOT NULL,
  file_id VARCHAR2(36 CHAR) NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ai_request_tts_audio_cache PRIMARY KEY (request_id, voice_model),
  CONSTRAINT fk_ai_request_tts_cache_request FOREIGN KEY (request_id) REFERENCES user_book_ai_requests (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_request_tts_cache_file FOREIGN KEY (file_id) REFERENCES book_files (file_id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_request_tts_cache_file ON user_book_ai_request_tts_audio_cache (file_id);
CREATE INDEX idx_ai_request_tts_cache_lookup ON user_book_ai_request_tts_audio_cache (request_id, voice_model, text_checksum_sha256);

CREATE OR REPLACE TRIGGER trg_ai_request_tts_cache_updated
BEFORE UPDATE ON user_book_ai_request_tts_audio_cache
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/
