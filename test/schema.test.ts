import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  toDiagnostic,
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
  // v0.6: the message became a diagnostic, so the subject is named rather
  // than the raw line being echoed.
  assert.ok(prompt.includes("subject: value.findings"));
  assert.ok(prompt.includes("evidence: is required"));
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

test("v0.6 a diagnostic names the subject, the evidence, and the legal repairs", () => {
  const required = toDiagnostic("root.file is required");
  assert.equal(required.subject, "root.file");
  assert.equal(required.evidence, "is required");
  assert.ok(required.supportedFixes[0]!.includes("add root.file"));

  const wrongType = toDiagnostic("root.line must be number, got string");
  assert.equal(wrongType.subject, "root.line");
  assert.ok(wrongType.supportedFixes[0]!.includes("make root.line a number"));

  const union = toDiagnostic("root.id must be one of string|number, got boolean");
  assert.ok(union.supportedFixes[0]!.includes("string or number"));

  const enumerated = toDiagnostic('root.severity must be one of "low", "high"');
  assert.ok(enumerated.supportedFixes[0]!.includes('one of "low", "high"'));

  const bounded = toDiagnostic("root.line must be >= 1");
  assert.ok(bounded.supportedFixes[0]!.includes("satisfies"));

  // every diagnostic carries the repair models reach for and should not
  for (const message of ["root.x is required", "root.y must be string, got number", "root.z is odd"]) {
    assert.ok(
      toDiagnostic(message).supportedFixes.some((f) => f.includes("keep every field that already validates")),
      message,
    );
  }
  // a message with no leading path still produces something usable
  assert.equal(toDiagnostic("something went wrong").subject, "something");
  assert.equal(toDiagnostic("").subject, "root");
});

test("v0.6 the retry prompt bounds the repair instead of listing complaints", () => {
  const schema = { type: "object", properties: { file: { type: "string" } }, required: ["file"] };
  const prompt = retryPrompt(["root.file is required", 'root.severity must be one of "low", "high"'], schema);

  assert.ok(prompt.includes("subject: root.file"));
  assert.ok(prompt.includes("evidence: is required"));
  assert.ok(prompt.includes("fixes: add root.file"));
  // the instruction that measurably stopped a model rewriting valid fields
  assert.ok(prompt.includes("Do not restructure the parts that already validated"));
  assert.ok(prompt.includes("Change one thing per diagnostic"));
  // the schema still travels with it
  assert.ok(prompt.includes("ONE JSON object"));

  // long failure lists stay bounded
  const many = Array.from({ length: 20 }, (_, i) => `root.f${i} is required`);
  assert.equal(retryPrompt(many, schema).split("subject:").length - 1, 8);
});
