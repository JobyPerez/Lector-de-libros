CREATE TABLE book_paragraph_tts_audio_cache (
  paragraph_id VARCHAR2(36 CHAR) NOT NULL,
  voice_model VARCHAR2(100 CHAR) NOT NULL,
  text_checksum_sha256 VARCHAR2(64 CHAR) NOT NULL,
  file_id VARCHAR2(36 CHAR) NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_book_paragraph_tts_audio_cache PRIMARY KEY (paragraph_id, voice_model),
  CONSTRAINT fk_book_paragraph_tts_audio_cache_paragraph FOREIGN KEY (paragraph_id) REFERENCES book_paragraphs (paragraph_id) ON DELETE CASCADE,
  CONSTRAINT fk_book_paragraph_tts_audio_cache_file FOREIGN KEY (file_id) REFERENCES book_files (file_id) ON DELETE CASCADE
);

CREATE INDEX idx_book_paragraph_tts_audio_cache_file ON book_paragraph_tts_audio_cache (file_id);
CREATE INDEX idx_book_paragraph_tts_audio_cache_lookup ON book_paragraph_tts_audio_cache (paragraph_id, voice_model, text_checksum_sha256);

CREATE OR REPLACE TRIGGER trg_book_paragraph_tts_audio_cache_updated_at
BEFORE UPDATE ON book_paragraph_tts_audio_cache
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/