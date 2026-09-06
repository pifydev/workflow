import { test } from "node:test";
import assert from "node:assert/strict";
import { ResumeCursor, buildCache, callKey, resumeSummary } from "../src/resume.ts";
import type { AgentCallState } from "../src/types.ts";

function call(overrides: Partial<AgentCallState> = {}): AgentCallState {
  return {
    id: 1,
    label: "worker-1",
    agent: "worker",
    phase: null,
    status: "done",
    turns: 1,
    tokens: 100,
    ...overrides,
  };
}

test("callKey is stable across option order and undefined values", () => {
  assert.equal(callKey("do x", { label: "a", phase: "p" }), callKey("do x", { phase: "p", label: "a" }));
  assert.equal(callKey("do x", undefined), callKey("do x", {}));
  assert.equal(callKey("do x", { label: "a", gate: undefined }), callKey("do x", { label: "a" }));
  // anything that changes the call changes the key
  assert.notEqual(callKey("do x", { label: "a" }), callKey("do y", { label: "a" }));
  assert.notEqual(callKey("do x", { label: "a" }), callKey("do x", { label: "b" }));
  assert.notEqual(callKey("do x", { schema: { type: "object" } }), callKey("do x", {}));
});

test("buildCache keeps the finished prefix only", () => {
  const agents = [
    call({ id: 1, key: "k1", result: "one" }),
    call({ id: 2, key: "k2", result: "two" }),
    call({ id: 3, key: "k3", status: "error" }),
    call({ id: 4, key: "k4", result: "four" }),
  ];
  const cache = buildCache(agents);
  assert.deepEqual(cache, [
    { key: "k1", result: "one" },
    { key: "k2", result: "two" },
  ]);

  // calls from before v0.4 have no key and cannot be replayed
  assert.deepEqual(buildCache([call({ result: "x" })]), []);
  assert.deepEqual(buildCache([]), []);
});

test("the cursor replays a matching prefix and stops at the first difference", () => {
  const cursor = new ResumeCursor([
    { key: "k1", result: "one" },
    { key: "k2", result: "two" },
    { key: "k3", result: "three" },
  ]);
  assert.deepEqual(cursor.next("k1"), { hit: true, value: "one" });
  assert.deepEqual(cursor.next("k2"), { hit: true, value: "two" });
  assert.equal(cursor.reused, 2);

  // the script changed here
  assert.deepEqual(cursor.next("changed"), { hit: false });
  // and never resumes, even if a later call happens to match what was cached
  assert.deepEqual(cursor.next("k3"), { hit: false });
  assert.equal(cursor.exhausted, true);
  assert.equal(cursor.reused, 2);
});

test("a cursor over an empty cache is a no-op", () => {
  const cursor = new ResumeCursor([]);
  assert.deepEqual(cursor.next("k1"), { hit: false });
  assert.equal(cursor.reused, 0);
  assert.equal(cursor.exhausted, true);
});

test("running past the end of the cache just goes live", () => {
  const cursor = new ResumeCursor([{ key: "k1", result: "one" }]);
  assert.deepEqual(cursor.next("k1"), { hit: true, value: "one" });
  assert.equal(cursor.exhausted, true);
  assert.deepEqual(cursor.next("k2"), { hit: false });
  assert.equal(cursor.reused, 1);
});

test("structured results survive the cache", () => {
  const value = { findings: [{ file: "a.ts", line: 3 }] };
  const cursor = new ResumeCursor([{ key: "k1", result: value }]);
  assert.deepEqual(cursor.next("k1").value, value);
});

test("resumeSummary explains what happened", () => {
  assert.ok(resumeSummary(0, 0).includes("nothing to resume"));
  assert.ok(resumeSummary(0, 3).includes("first call already differs"));
  assert.ok(resumeSummary(2, 5).includes("reused 2 of 5"));
  assert.ok(resumeSummary(5, 5).includes("all 5"));
});
