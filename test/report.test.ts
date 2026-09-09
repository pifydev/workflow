import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGates, formatResult } from "../src/report.ts";
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

test("a gate that could not run reads differently from one that failed", () => {
  const run = runOf([
    call("a", { outcome: "no_attestation", ok: false, reason: "gate never ran (spawn ENOENT)" }),
  ]);
  const text = formatGates(run)!;
  assert.match(text, /1 no_attestation/);
  assert.match(text, /never ran/);
  assert.equal(text.includes("failure"), false);
});
