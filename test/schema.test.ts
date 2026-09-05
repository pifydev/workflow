import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  readStructured,
  retryPrompt,
  schemaInstruction,
  validateAgainstSchema,
} from "../src/schema.ts";

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["file", "severity"],
        properties: {
          file: { type: "string" },
          severity: { type: "string", enum: ["low", "high"] },
          line: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

test("extractJson survives the wrappers models add", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
  assert.equal(extractJson("no json at all"), undefined);
  assert.equal(extractJson(""), undefined);
});

test("validateAgainstSchema checks the keywords workflows actually use", () => {
  assert.deepEqual(validateAgainstSchema({ findings: [] }, FINDINGS), []);
  assert.deepEqual(
    validateAgainstSchema({ findings: [{ file: "a.ts", severity: "high", line: 3 }] }, FINDINGS),
    [],
  );

  assert.deepEqual(validateAgainstSchema({}, FINDINGS), ["value.findings is required"]);
  assert.deepEqual(validateAgainstSchema({ findings: "nope" }, FINDINGS), [
    "value.findings must be array, got string",
  ]);
  assert.deepEqual(validateAgainstSchema({ findings: [{ file: "a.ts" }] }, FINDINGS), [
    "value.findings[0].severity is required",
  ]);
  assert.deepEqual(validateAgainstSchema({ findings: [{ file: "a.ts", severity: "medium" }] }, FINDINGS), [
    'value.findings[0].severity must be one of "low", "high"',
  ]);
  assert.deepEqual(
    validateAgainstSchema({ findings: [{ file: "a.ts", severity: "low", line: 0 }] }, FINDINGS),
    ["value.findings[0].line must be >= 1"],
  );
  assert.deepEqual(
    validateAgainstSchema({ findings: [{ file: "a.ts", severity: "low", line: 1.5 }] }, FINDINGS),
    ["value.findings[0].line must be integer, got number"],
  );
  const tooMany = { findings: [1, 2, 3, 4].map(() => ({ file: "a.ts", severity: "low" })) };
  assert.deepEqual(validateAgainstSchema(tooMany, FINDINGS), [
    "value.findings allows at most 3 item(s), got 4",
  ]);
});

test("validateAgainstSchema ignores keywords it does not implement", () => {
  const schema = { type: "object", additionalProperties: false, $comment: "x", patternProperties: {} };
  assert.deepEqual(validateAgainstSchema({ anything: true }, schema), []);
  // and an empty schema accepts anything
  assert.deepEqual(validateAgainstSchema(42, {}), []);
});

test("null is a type, not a missing object", () => {
  assert.deepEqual(validateAgainstSchema(null, { type: "object" }), ["value must be object, got null"]);
  assert.deepEqual(validateAgainstSchema(null, { type: "null" }), []);
  assert.deepEqual(validateAgainstSchema([], { type: "object" }), ["value must be object, got array"]);
});

test("readStructured combines extraction and validation", () => {
  const good = readStructured('```json\n{"findings":[]}\n```', FINDINGS);
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { findings: [] });

  const noJson = readStructured("I could not find anything.", FINDINGS);
  assert.equal(noJson.ok, false);
  assert.deepEqual(noJson.errors, ["the answer contained no JSON value"]);

  const wrongShape = readStructured('{"results":[]}', FINDINGS);
  assert.equal(wrongShape.ok, false);
  assert.ok(wrongShape.errors[0]!.includes("required"));
});

test("the retry tells the child what was wrong and what to send", () => {
  const prompt = retryPrompt(["value.findings is required"], FINDINGS);
  assert.ok(prompt.includes("did not match"));
  assert.ok(prompt.includes("- value.findings is required"));
  assert.ok(prompt.includes("ONE JSON object"));
  assert.ok(prompt.includes('"maxItems":3'));
  // long error lists are trimmed, not dumped
  const many = retryPrompt(Array.from({ length: 20 }, (_, i) => `e${i}`), FINDINGS);
  assert.equal(many.split("\n").filter((l) => l.startsWith("- ")).length, 8);
});

test("schemaInstruction states the whole contract", () => {
  const text = schemaInstruction(FINDINGS);
  assert.ok(text.includes("ONE JSON object"));
  assert.ok(text.includes("no markdown fence"));
  assert.ok(text.includes('"severity"'));
});
