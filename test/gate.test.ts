import { test } from "node:test";
import assert from "node:assert/strict";
import { contractProblems, evaluateGate, normalizeGate } from "../src/gate.ts";

const run = (over: Partial<Parameters<typeof evaluateGate>[1]> = {}) => ({
  status: 0,
  signal: null,
  output: "",
  ...over,
});

test("a bare command keeps the exit-code contract", () => {
  assert.deepEqual(normalizeGate("bun test"), { command: "bun test" });
  assert.equal(evaluateGate({ command: "bun test" }, run({ status: 0 })).outcome, "success");
  assert.equal(evaluateGate({ command: "bun test" }, run({ status: 1 })).outcome, "failure");
  assert.match(evaluateGate({ command: "x" }, run({ status: 2 })).reason, /exited 2/);
});

test("exiting 0 without the evidence is result_missing, not a pass", () => {
  // The hole: the command ran, proved nothing, and exited 0.
  const contract = { command: "bun test", expect: "\\d+ pass" };
  const silent = evaluateGate(contract, run({ status: 0, output: "no test files found" }));
  assert.equal(silent.outcome, "result_missing");
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /never matched/);
  assert.match(silent.reason, /nothing was verified/);

  const real = evaluateGate(contract, run({ status: 0, output: "42 pass 0 fail" }));
  assert.equal(real.outcome, "success");
  assert.equal(real.ok, true);
  assert.match(real.reason, /matched/);
});

test("a failure pattern beats a zero exit", () => {
  const contract = { command: "deploy.sh", expect: "DEPLOYED", failure: "ROLLBACK" };
  const rolled = evaluateGate(contract, run({ status: 0, output: "DEPLOYED\nthen ROLLBACK" }));
  assert.equal(rolled.outcome, "failure");
  assert.match(rolled.reason, /failure pattern/);
  // and it is checked before the exit code, so a 0 exit cannot hide it
  assert.equal(evaluateGate(contract, run({ status: 0, output: "ROLLBACK" })).outcome, "failure");
});

test("a killed run is a timeout, not a failure", () => {
  const contract = { command: "sleep 999", timeoutMs: 1000 };
  assert.equal(evaluateGate(contract, run({ status: null, signal: "SIGTERM" })).outcome, "timeout");
  assert.equal(evaluateGate(contract, run({ status: 0, timedOut: true })).outcome, "timeout");
  assert.match(evaluateGate(contract, run({ timedOut: true })).reason, /1000ms/);
});

test("patterns are multiline, so a sentinel on its own line counts", () => {
  const contract = { command: "build", expect: "^BUILD OK$" };
  assert.equal(evaluateGate(contract, run({ output: "step 1\nstep 2\nBUILD OK" })).outcome, "success");
  assert.equal(evaluateGate(contract, run({ output: "step 1\nBUILD FAILED" })).outcome, "result_missing");
});

test("a broken contract fails closed instead of passing", () => {
  assert.deepEqual(contractProblems({ command: "x" }), []);
  assert.ok(contractProblems({ command: "  " })[0]!.includes("no command"));
  assert.ok(contractProblems({ command: "x", expect: "[unclosed" })[0]!.includes("not a valid regular expression"));
  assert.ok(contractProblems({ command: "x", failure: "(" })[0]!.includes("failure"));
  assert.ok(contractProblems({ command: "x", timeoutMs: 0 })[0]!.includes("positive"));
});
