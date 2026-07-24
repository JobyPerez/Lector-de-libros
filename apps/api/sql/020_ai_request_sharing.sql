CREATE TABLE ai_request_shares (
  request_id VARCHAR2(36 CHAR) NOT NULL,
  user_id VARCHAR2(36 CHAR) NOT NULL,
  created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ai_request_shares PRIMARY KEY (request_id, user_id),
  CONSTRAINT fk_ai_request_shares_request FOREIGN KEY (request_id) REFERENCES user_book_ai_requests (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_request_shares_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_request_shares_user
  ON ai_request_shares (user_id, request_id);
