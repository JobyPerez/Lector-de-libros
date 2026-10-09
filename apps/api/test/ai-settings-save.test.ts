import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { updateProfileSchema } from "../src/modules/auth/auth.routes.js";
import { serializeVisibleModels } from "../src/services/user-ai-credentials.js";

const routes = readFileSync(new URL("../src/modules/ai-settings/ai-settings.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("ai-settings.routes.ts", routes, ts.ScriptTarget.Latest, true);
const schemaNode = source.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => item.name.getText(source) === "aiSettingsUpdateSchema"));
assert.ok(schemaNode);
const schema = new Function("z", "updateProfileSchema", ts.transpile(`${schemaNode.getText(source)}; return aiSettingsUpdateSchema;`,
  { target: ts.ScriptTarget.ES2022 }))(z, updateProfileSchema);

function setup(failAt?: "ocr-visible" | "summary-visible" | "activity" | "summary" | "commit" | "duplicate") {
  const initial = { ocrModel: "old-ocr", summaryModel: "old-summary", ocrVisible: '["old-ocr"]', summaryVisible: '["old-summary"]' };
  let persisted = { ...initial };
  let pending = { ...initial };
  const events: string[] = [];
  const connection = {
    execute: async (sql: string, binds: any, options?: any) => {
      assert.ok(!options?.autoCommit, "all writes belong to the same transaction");
      if (sql.includes("SELECT email")) return { rows: [{ email: "user@example.com" }] };
      if (sql.includes("SET email")) {
        events.push("defaults");
        assert.match(sql, /opencode_ocr_model = CASE WHEN :hasOpencodeOcrModel = 1 THEN :opencodeOcrModel ELSE opencode_ocr_model END/u);
        assert.match(sql, /opencode_summary_model = CASE WHEN :hasOpencodeSummaryModel = 1 THEN :opencodeSummaryModel ELSE opencode_summary_model END/u);
        if (failAt === "duplicate") throw Object.assign(new Error("duplicate email"), { errorNum: 1 });
        if (binds.hasOpencodeOcrModel) pending.ocrModel = binds.opencodeOcrModel;
        if (binds.hasOpencodeSummaryModel) pending.summaryModel = binds.opencodeSummaryModel;
      } else {
        const key = sql.includes("opencode_ocr_visible_models") ? "ocrVisible" : "summaryVisible";
        const event = key === "ocrVisible" ? "ocr-visible" : "summary-visible";
        events.push(event);
        if (failAt === event) throw new Error("ORA-00904: missing required visibility column");
        pending[key] = binds.visibleModels;
      }
      return { rows: [] };
    },
    commit: async () => { events.push("commit"); if (failAt === "commit") throw new Error("commit failed"); persisted = { ...pending }; },
    rollback: async () => { events.push("rollback"); pending = { ...persisted }; },
    close: async () => { events.push("close"); }
  };
  const dependencies = {
    aiSettingsUpdateSchema: schema, getConnection: async () => connection, encryptOptionalSecret: () => undefined, serializeVisibleModels,
    recordUserActivity: async (db: unknown) => { assert.equal(db, connection); events.push("activity"); if (failAt === "activity") throw new Error("activity failed"); },
    getUserAiCredentialSummary: async (_userId: string, db: unknown) => {
      assert.equal(db, connection); events.push("summary"); if (failAt === "summary") throw new Error("summary failed"); return { ...pending };
    }
  };
  const start = routes.indexOf('  app.put("/ai-settings",');
  const end = routes.indexOf("\n  });", start);
  assert.ok(start >= 0 && end >= 0);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  const handler = new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
  const reply = { statusCode: 200, body: undefined as any, status(code: number) { this.statusCode = code; return this; },
    send(body: any) { this.body = body; return this; } };
  return { initial, events, reply, get persisted() { return persisted; }, call: (body: unknown) => handler({
    currentUser: { userId: "user" }, body, headers: {}, ip: "127.0.0.1"
  }, reply) };
}

test("AI settings commits defaults, both visible arrays and activity exactly once", async () => {
  const app = setup();
  await app.call({ opencodeOcrModel: "new-ocr", opencodeSummaryModel: "new-summary",
    opencodeOcrVisibleModels: ["new-ocr"], opencodeSummaryVisibleModels: [] });
  assert.deepEqual(app.events, ["defaults", "ocr-visible", "summary-visible", "activity", "summary", "commit", "close"]);
  assert.deepEqual(app.persisted, { ocrModel: "new-ocr", summaryModel: "new-summary", ocrVisible: '["new-ocr"]', summaryVisible: "[]" });
  assert.deepEqual(app.reply.body.settings, app.persisted);
});

test("failed visibility, activity, summary or commit rolls back defaults and every array without reporting success", async () => {
  for (const failure of ["ocr-visible", "summary-visible", "activity", "summary", "commit"] as const) {
    const app = setup(failure);
    await assert.rejects(app.call({ opencodeOcrModel: "new-ocr", opencodeSummaryModel: "new-summary",
      opencodeOcrVisibleModels: ["new-ocr"], opencodeSummaryVisibleModels: ["new-summary"] }),
    failure.endsWith("visible") ? /ORA-00904/u : /failed/u);
    assert.deepEqual(app.persisted, app.initial);
    assert.deepEqual(app.events.slice(-2), ["rollback", "close"]);
    assert.equal(app.reply.body, undefined);
    assert.equal(app.events.filter((event) => event === "commit").length, failure === "commit" ? 1 : 0);
  }
});

test("null clears model overrides while omitted fields retain stored defaults and visibility", async () => {
  const cleared = setup();
  await cleared.call({ opencodeOcrModel: null, opencodeSummaryModel: null });
  assert.deepEqual(cleared.persisted, { ...cleared.initial, ocrModel: null, summaryModel: null });
  const omitted = setup();
  await omitted.call({});
  assert.deepEqual(omitted.persisted, omitted.initial);
  const partial = setup();
  await partial.call({ opencodeOcrModel: null });
  assert.deepEqual(partial.persisted, { ...partial.initial, ocrModel: null });
  assert.ok(!partial.events.some((event) => event.endsWith("visible")));
  assert.equal(updateProfileSchema.safeParse({ email: "user@example.com", opencodeOcrModel: null }).success, false);
  assert.equal(schema.safeParse({ opencodeOcrModel: "" }).success, false);
});

test("duplicate email rolls back before returning conflict", async () => {
  const app = setup("duplicate");
  await app.call({ email: "taken@example.com", opencodeOcrModel: "new-ocr" });
  assert.equal(app.reply.statusCode, 409);
  assert.deepEqual(app.persisted, app.initial);
  assert.deepEqual(app.events, ["defaults", "rollback", "close"]);
});
