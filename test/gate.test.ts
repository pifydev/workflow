import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributionNote,
  contractProblems,
  evaluateGate,
  normalizeGate,
  sharedWith,
} from "../src/gate.ts";

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

test("a check that never ran is not a verdict on the work", () => {
  // The distinction: "the tests ran and failed" and "the test runner is not
  // installed" are both not-a-pass, but only one is about the code. Reporting
  // the second as `failure` sends the reader debugging the wrong thing.
  const missing = evaluateGate({ command: "bun test" }, run({ status: null, spawnError: "spawn ENOENT" }));
  assert.equal(missing.outcome, "no_attestation");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /never ran/);
  assert.match(missing.reason, /nothing was proved/);

  // Neither an exit code nor a signal: no verdict was produced at all.
  const silent = evaluateGate({ command: "x" }, run({ status: null, signal: null }));
  assert.equal(silent.outcome, "no_attestation");

  // A timeout is still real evidence — the check was given its deadline.
  assert.equal(evaluateGate({ command: "x" }, run({ status: null, signal: "SIGTERM" })).outcome, "timeout");
  // And a genuine non-zero exit is still a failure, not an excuse.
  assert.equal(evaluateGate({ command: "x" }, run({ status: 1 })).outcome, "failure");
});

test("a gate names who else was editing the directory it judged", () => {
  const self = { id: 2, label: "fix-api", status: "running", workDir: "/repo" };
  const siblings = [
    { id: 1, label: "fix-auth", status: "running", workDir: "/repo" },
    { id: 2, label: "fix-api", status: "running", workDir: "/repo" },
    { id: 3, label: "done-already", status: "done", workDir: "/repo" },
    { id: 4, label: "isolated", status: "running", workDir: "/worktrees/x" },
  ];
  // Only live calls in the same directory count: a finished one cannot still
  // be editing, and an isolated one has its own checkout.
  assert.deepEqual(sharedWith(self, "/repo", siblings), ["fix-auth"]);

  // The isolated agent is the reason isolation is the fix rather than a
  // warning: nobody else can reach its tree, so its verdict is its own.
  const isolated = { id: 4, label: "isolated", status: "running", workDir: "/worktrees/x" };
  assert.deepEqual(sharedWith(isolated, "/worktrees/x", siblings), []);
});

test("a sibling that has not chosen a directory yet counts as sharing", () => {
  // A call is registered as running before its working directory is decided.
  // Assuming it shares costs a note that may be unnecessary; assuming it does
  // not would hide a real concurrent edit, so this fails safe.
  const self = { id: 1, label: "a", status: "running", workDir: "/repo" };
  const starting = [{ id: 2, label: "b", status: "running" }];
  assert.deepEqual(sharedWith(self, "/repo", starting), ["b"]);
});

test("a pass earned over a shared, moving tree says so", () => {
  assert.equal(attributionNote({ ok: true, sharedWith: [] }), null);
  const passed = attributionNote({ ok: true, sharedWith: ["fix-auth"] })!;
  assert.match(passed, /not of this agent's work alone/);
  const failed = attributionNote({ ok: false, sharedWith: ["a", "b"] })!;
  assert.match(failed, /may not be this agent's work/);
  // Plural agreement, because this line is read by a person.
  assert.match(attributionNote({ ok: true, sharedWith: ["a", "b"] })!, /were also changing/);
  assert.match(passed, /was also changing/);
});
