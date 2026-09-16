import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFailures, formatGates, formatResult } from "../src/report.ts";
import type { AgentCallState, GateRecord, WorkflowRun } from "../src/types.ts";

const call = (label: string, gate?: Partial<GateRecord>): AgentCallState => ({
  id: 1,
  label,
  agent: "worker",
  phase: null,
  status: "done",
  turns: 1,
  tokens: 0,
  ...(gate
    ? {
        gate: {
          command: "bun test",
          outcome: "success",
          ok: true,
          reason: "gate exited 0",
          subject: "/repo",
          sharedWith: [],
          ...gate,
        },
      }
    : {}),
});

const runOf = (agents: AgentCallState[], result: string | null = "done"): WorkflowRun => ({
  runId: "w1",
  background: false,
  status: "done",
  startedAt: 0,
  finishedAt: 1,
  phases: [],
  agents,
  logs: [],
  result,
  error: null,
});

test("a run with no gates says nothing about gates", () => {
  assert.equal(formatGates(runOf([call("a")])), null);
  assert.equal(formatResult(runOf([call("a")])).includes("Gates"), false);
});

test("a clean pass costs one word, not a line", () => {
  const text = formatGates(runOf([call("a", {}), call("b", {})]))!;
  assert.equal(text, "Gates: 2 success");
});

test("a rejected step and its reason reach the result", () => {
  // Without this the reader sees a shorter array and no hint that a step was
  // rejected — the one thing the gate existed to say.
  const run = runOf([
    call("fix-auth", { outcome: "failure", ok: false, reason: "gate exited 1" }),
    call("fix-api", {}),
  ]);
  const text = formatResult(run);
  assert.match(text, /Gates: 1 failure, 1 success/);
  assert.match(text, /✗ fix-auth — failure: gate exited 1/);
  assert.equal(text.includes("✓ fix-api"), false);
  // and the script's own result is still there
  assert.match(text, /done$/);
});

test("a pass over a tree someone else was editing is not reported as clean", () => {
  const run = runOf([call("fix-api", { sharedWith: ["fix-auth"] })]);
  const text = formatGates(run)!;
  assert.match(text, /✓ fix-api/);
  assert.match(text, /not of this agent's work alone/);
});

test("a run whose calls all succeeded says nothing about failures", () => {
  assert.equal(formatFailures(runOf([call("a"), call("b")])), null);
  assert.equal(formatResult(runOf([call("a")])).includes("Failures"), false);
});

test("a call that failed for a non-gate reason says why, in the result", () => {
  // Until now a thrown error, a provider error or an empty answer all became a
  // silent `null` in the script — the model saw a shorter array and nothing
  // else. The reason has to travel with the result, the way gate verdicts do.
  const run = runOf([
    { ...call("scout-1"), status: "error", error: "No model available" },
    { ...call("worker-2"), status: "aborted", error: "cancelled while queued for a slot" },
    { ...call("worker-3"), status: "aborted" },
    call("worker-4"),
  ]);
  const text = formatFailures(run)!;
  assert.match(text, /^Failures: 1 error, 2 aborted/);
  assert.match(text, /✗ scout-1 — error: No model available/);
  assert.match(text, /✗ worker-2 — aborted: cancelled while queued for a slot/);
  // No recorded reason is still a line — the reader must learn the call did
  // not produce a result — just without inventing one.
  assert.match(text, /✗ worker-3 — aborted$/m);
  assert.equal(text.includes("worker-4"), false);
  // and formatResult carries it alongside the script's own result
  const result = formatResult(run);
  assert.match(result, /Failures: 1 error, 2 aborted/);
  assert.match(result, /done$/);
});

test("a gate failure is told once, by the gate ledger, not again as a failure", () => {
  const run = runOf([
    { ...call("fix-auth", { outcome: "failure", ok: false, reason: "gate exited 1" }), status: "error" },
  ]);
  assert.equal(formatFailures(run), null);
  const text = formatResult(run);
  assert.match(text, /✗ fix-auth — failure: gate exited 1/);
  assert.equal(text.includes("Failures"), false);
});

test("a cancelled run says who stopped it instead of hiding it", () => {
  const run: WorkflowRun = {
    ...runOf([{ ...call("a"), status: "aborted" }], null),
    status: "cancelled",
    error: "Cancelled by the user — 1 child agent stopped. Work already finished is kept; the run itself did not complete.",
  };
  const text = formatResult(run);
  assert.match(text, /^\[workflow w1\] cancelled/);
  assert.match(text, /Cancelled by the user — 1 child agent stopped/);
  assert.match(text, /Failures: 1 aborted/);
  assert.match(text, /script returned nothing/);
});

test("an errored run still lists the calls that failed under it", () => {
  const run: WorkflowRun = {
    ...runOf([{ ...call("a"), status: "error", error: "boom" }]),
    status: "error",
    error: "script threw",
  };
  const text = formatResult(run);
  assert.match(text, /Error: script threw/);
  assert.match(text, /✗ a — error: boom/);
});

test("a gate that could not run reads differently from one that failed", () => {
  const run = runOf([
    call("a", { outcome: "no_attestation", ok: false, reason: "gate never ran (spawn ENOENT)" }),
  ]);
  const text = formatGates(run)!;
  assert.match(text, /1 no_attestation/);
  assert.match(text, /never ran/);
  assert.equal(text.includes("failure"), false);
});
