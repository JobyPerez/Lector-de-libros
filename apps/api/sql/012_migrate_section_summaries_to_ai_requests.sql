ALTER TABLE user_book_ai_requests ADD legacy_summary_id VARCHAR2(36 CHAR);

CREATE UNIQUE INDEX uq_user_book_ai_requests_legacy
  ON user_book_ai_requests (legacy_summary_id);

INSERT INTO user_book_ai_requests (
  request_id,
  user_id,
  book_id,
  scope_type,
  chapter_id,
  section_title,
  start_page_number,
  end_page_number,
  start_paragraph_number,
  end_paragraph_number,
  start_sequence_number,
  end_sequence_number,
  prompt_text,
  response_text,
  legacy_summary_id,
  created_at,
  updated_at
)
SELECT
  LOWER(REGEXP_REPLACE(RAWTOHEX(SYS_GUID()), '(.{8})(.{4})(.{4})(.{4})(.{12})', '\1-\2-\3-\4-\5')),
  user_id,
  book_id,
  'SECTION',
  chapter_id,
  section_title,
  start_page_number,
  end_page_number,
  start_paragraph_number,
  end_paragraph_number,
  start_sequence_number,
  end_sequence_number,
  TO_CLOB(q'[Eres editor literario. Resume una sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.]'),
  summary_text,
  summary_id,
  created_at,
  updated_at
FROM user_book_section_summaries summaries
WHERE NOT EXISTS (
  SELECT 1
  FROM user_book_ai_requests requests
  WHERE requests.legacy_summary_id = summaries.summary_id
);
