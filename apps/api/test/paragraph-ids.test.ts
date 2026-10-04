import assert from "node:assert/strict";
import test from "node:test";
import { matchParagraphsWithExplicitIds } from "../src/modules/books/paragraph-ids.js";

const existing = [{ paragraphId: "a" }, { paragraphId: "b" }, { paragraphId: "c" }];
const replacements = [{ paragraphId: "new-1" }, { paragraphId: "new-2" }, { paragraphId: "new-3" }];

test("explicit reordered IDs are reserved before heuristics", () => {
  const matches = matchParagraphsWithExplicitIds(existing, replacements, ["b", null, "a"], (remaining, candidates) => {
    assert.deepEqual(remaining, [existing[2]]);
    assert.deepEqual(candidates, [replacements[1]]);
    return new Map([["c", candidates[0]!]]);
  });
  assert.equal(matches.get("b"), replacements[0]);
  assert.equal(matches.get("a"), replacements[2]);
  assert.equal(new Set(matches.values()).size, 3);
});

test("invalid IDs fail before invoking heuristics", () => {
  for (const ids of [["a"], ["a", "a", null], ["foreign-page", null, null]]) {
    assert.throws(() => matchParagraphsWithExplicitIds(existing, replacements, ids, () => {
      assert.fail("heuristics must not run");
    }), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 400);
  }
});

test("omitted and null IDs preserve legacy heuristic matching", () => {
  for (const ids of [undefined, [null, null, null]]) {
    const matches = matchParagraphsWithExplicitIds(existing, replacements, ids, (remaining, candidates) => {
      assert.deepEqual(remaining, existing);
      assert.deepEqual(candidates, replacements);
      return new Map([["a", candidates[0]!]]);
    });
    assert.equal(matches.get("a"), replacements[0]);
  }
});
