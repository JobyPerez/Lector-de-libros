import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../sql/SQL037_visual_page_editor.sql", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/scripts/migrate-visual-page-editor.ts", import.meta.url), "utf8");

test("SQL037 is additive/idempotent and supplies nullable legacy metadata and validated flags", () => {
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|UPDATE|TRUNCATE|MERGE)\b/iu);
  assert.equal((sql.match(/IF column_count = 0 THEN/gu) ?? []).length, 7);
  assert.equal((sql.match(/IF constraint_count = 0 THEN/gu) ?? []).length, 6);
  assert.match(sql, /visual_document_json CLOB/u);
  assert.match(sql, /source_html_content CLOB/u);
  assert.match(sql, /is_active NUMBER\(1\) DEFAULT 1 NOT NULL/u);
  assert.match(sql, /include_in_toc NUMBER\(1\)\)/u);
  assert.match(sql, /image_width_pct NUMBER\)/u);
  assert.equal((sql.match(/is_stale NUMBER\(1\) DEFAULT 0 NOT NULL/gu) ?? []).length, 2);
  assert.match(sql, /visual_document_json IS JSON STRICT WITH UNIQUE KEYS/u);
  assert.match(sql, /image_width_pct BETWEEN 1 AND 100/u);
});

test("runner verifies actual summary tables, types/defaults, constraints and unchanged historical counts", () => {
  assert.match(script, /SQL037_visual_page_editor\.sql/u);
  assert.match(script, /USER_BOOK_SECTION_SUMMARIES/u);
  assert.match(script, /BK_SUMMARIES_/u);
  assert.match(script, /column_name = 'SUMMARY_TEXT'/u);
  assert.match(script, /columns.rows\?\.length !== 7/u);
  assert.match(script, /constraints.rows\?\.length !== 6/u);
  assert.match(script, /row.status !== "ENABLED" \|\| row.validated !== "VALIDATED"/u);
  assert.match(script, /JSON.stringify\(before.rows\) !== JSON.stringify\(after.rows\)/u);
  assert.match(script, /DBMS_LOB.GETLENGTH\(paragraph_text\)/u);
  assert.doesNotMatch(script, /appEnv|process.env|console.log\([^)]*rows/u);
  assert.match(script, /await closeConnectionPool\(\)/u);
});
