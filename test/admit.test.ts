import { test } from "node:test";
import assert from "node:assert/strict";
import { admitChild } from "../src/admit.ts";
import type { AgentCallState, WorkflowRun } from "../src/types.ts";

const callOf = (label = "worker-2"): AgentCallState => ({
  id: 2,
  label,
  agent: "worker",
  phase: null,
  status: "running",
  turns: 0,
  tokens: 0,
});

const runOf = (status: WorkflowRun["status"] = "running"): Pick<WorkflowRun, "status" | "logs"> => ({
  status,
  logs: [],
});

test("a child parked in the semaphore does not start once the run was cancelled", async () => {
  // The extension's ordering: guard → await acquire() → (this check) → create
  // session → prompt. Esc arrives while the call is still queued; cancelRun
  // only aborts sessions in `live`, and this one has none yet. Without the
  // re-check the slot arrives and the child runs to completion on a run the
  // user already stopped.
  let grant!: () => void;
  const acquire = new Promise<void>((resolve) => (grant = resolve));
  const run = runOf();
  const call = callOf();

  const started = (async () => {
    await acquire;
    return admitChild(run, call, "slot");
  })();
  run.status = "cancelled";
  grant();

  assert.equal(await started, false);
  assert.equal(call.status, "aborted");
  assert.match(call.error ?? "", /queued/);
  assert.equal(run.logs.length, 1);
  assert.match(run.logs[0]!, /worker-2/);
  assert.match(run.logs[0]!, /cancelled/);
});

test("a child that already has a session but has not prompted yet is refused too", () => {
  // createAgentSession is async and the cancel can land between it and
  // session.prompt; the session is registered in `live` by then but abortRun
  // has already swept, so nothing would stop the prompt.
  const run = runOf("cancelled");
  const call = callOf("scout-1");
  assert.equal(admitChild(run, call, "prompt"), false);
  assert.equal(call.status, "aborted");
  assert.match(call.error ?? "", /prompt/);
});

test("a running run admits and leaves the call untouched", () => {
  const run = runOf();
  const call = callOf();
  assert.equal(admitChild(run, call, "slot"), true);
  assert.equal(call.status, "running");
  assert.equal(call.error, undefined);
  assert.deepEqual(run.logs, []);
});

test("any terminal status refuses, not only cancelled", () => {
  // Same rule as the first guard: a run that errored or finished mid-fan-out
  // must not start children either — the zombie script keeps calling agent().
  for (const status of ["done", "error"] as const) {
    const run = runOf(status);
    const call = callOf();
    assert.equal(admitChild(run, call, "slot"), false, status);
    assert.equal(call.status, "aborted");
    assert.match(run.logs[0]!, new RegExp(status));
  }
});
