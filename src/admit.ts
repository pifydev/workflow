/**
 * The cancel check a queued child has to pass again before it starts.
 *
 * spawnChildAgent checks `run.status` once, at the top — and then awaits a
 * semaphore slot, a resource-loader reload and createAgentSession before the
 * first prompt goes out. cancelRun aborts the sessions registered in `live`,
 * which a call parked in the semaphore or mid-createAgentSession is not. So
 * after Esc or a timeout every queued child still got its slot and ran to
 * completion, paid for, on a run the user had already stopped.
 *
 * Two more looks at the same flag close that: one when the slot arrives, one
 * right before the prompt. Both belong INSIDE the try whose finally releases
 * the slot; an early return placed before it would leak a semaphore slot for
 * the rest of the session.
 *
 * Pure: the run's status and log, the call's status and reason.
 */
import type { AgentCallState, WorkflowRun } from "./types.ts";

/** Where in the start-up sequence the child is asking. */
export type AdmitStage = "slot" | "prompt";

/**
 * Whether the child may still start. Any terminal status refuses, not just
 * "cancelled" — the same rule as the first guard: a run that errored or
 * finished mid-fan-out must not start children either, because the script
 * is ordinary JavaScript and keeps calling agent() after the run is over.
 */
export function admitChild(
  run: Pick<WorkflowRun, "status" | "logs">,
  call: AgentCallState,
  stage: AdmitStage,
): boolean {
  if (run.status === "running") return true;
  call.status = "aborted";
  call.error = stage === "slot" ? "cancelled while queued for a slot" : "cancelled before its first prompt";
  run.logs.push(`${call.label}: ${call.error} (run ${run.status})`);
  return false;
}
