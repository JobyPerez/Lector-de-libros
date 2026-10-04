import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../sql/034_page_elements.sql", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/scripts/migrate-page-elements.ts", import.meta.url), "utf8");

test("SQL034 adds only guarded columns/constraints and preserves historical text and labels", () => {
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|UPDATE|TRUNCATE|MERGE)\b/iu);
  assert.equal((sql.match(/IF (?:column|constraint)_count = 0 THEN/gu) ?? []).length, 5);
  assert.match(sql, /element_role VARCHAR2\(32\) DEFAULT ''body'' NOT NULL/u);
  assert.match(sql, /read_aloud NUMBER\(1\) DEFAULT 1 NOT NULL/u);
  assert.match(sql, /geometry_json CLOB/u);
  assert.match(sql, /CHECK \(read_aloud IN \(0, 1\)\)/u);
  assert.match(sql, /CHECK \(geometry_json IS JSON STRICT WITH UNIQUE KEYS\)/u);
  assert.equal(sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean).length, 2);
});

test("migration runner reuses SQL034 and checks enabled validated constraints without logging credentials", () => {
  assert.match(script, /034_page_elements\.sql/u);
  assert.match(script, /columns\.rows\?\.length !== 3/u);
  assert.match(script, /constraints\.rows\?\.length !== 2/u);
  assert.match(script, /row\.status !== "ENABLED" \|\| row\.validated !== "VALIDATED"/u);
  assert.doesNotMatch(script, /appEnv|process\.env|console\.log\([^)]*rows/u);
  assert.match(script, /await connection\.close\(\)/u);
  assert.match(script, /await closeConnectionPool\(\)/u);
});
