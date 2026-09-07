/**
 * What a gate actually proved.
 *
 * A gate exists so a step is verified by running something rather than by a
 * model saying it went well. Judging that run by its exit code alone leaves a
 * hole big enough to drive a workflow through: a command that never ran the
 * check still exits 0. A mistyped script name under `sh -c`, a test runner
 * that matched no tests, a `|| true` someone left in — each one reports
 * success while proving nothing.
 *
 * So a gate may state what success looks like. When it does, exiting 0
 * without that evidence is its own outcome (`result_missing`) rather than a
 * pass. The vocabulary is FradSer/pi-monitor's result contract.
 */

export type GateOutcome = "success" | "failure" | "result_missing" | "timeout";

export interface GateContract {
  /** The command to run. */
  command: string;
  /** Regex source: success requires a match in the combined output. */
  expect?: string;
  /** Regex source: a match means failure even when the command exits 0. */
  failure?: string;
  timeoutMs?: number;
}

export interface GateRun {
  /** Exit status, or null when the process was killed (timeout/signal). */
  status: number | null;
  /** Signal that killed it, when one did. */
  signal?: string | null;
  output: string;
  /** True when the runner stopped it at the timeout. */
  timedOut?: boolean;
}

export interface GateVerdict {
  outcome: GateOutcome;
  ok: boolean;
  /** One line for the run log, in this package's words. */
  reason: string;
}

/** Accept a bare command string or a full contract. */
export function normalizeGate(gate: string | GateContract): GateContract {
  return typeof gate === "string" ? { command: gate } : gate;
}

function compile(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, "m");
  } catch {
    return null;
  }
}

/**
 * Judge a finished gate run. Order matters: a timeout is a timeout whatever
 * else happened, an explicit failure pattern beats a zero exit, and a missing
 * success pattern is never a pass.
 */
export function evaluateGate(contract: GateContract, run: GateRun): GateVerdict {
  if (run.timedOut || (run.status === null && run.signal)) {
    return {
      outcome: "timeout",
      ok: false,
      reason: `gate timed out after ${contract.timeoutMs ?? "the default"}ms`,
    };
  }

  const failurePattern = compile(contract.failure);
  if (failurePattern && failurePattern.test(run.output)) {
    return {
      outcome: "failure",
      ok: false,
      reason: `gate output matched its failure pattern /${contract.failure}/`,
    };
  }

  if (run.status !== 0) {
    return { outcome: "failure", ok: false, reason: `gate exited ${run.status ?? "abnormally"}` };
  }

  const expectPattern = compile(contract.expect);
  if (expectPattern && !expectPattern.test(run.output)) {
    // The hole this closes: the command ran, said nothing that proves the
    // check happened, and exited 0.
    return {
      outcome: "result_missing",
      ok: false,
      reason: `gate exited 0 but its output never matched /${contract.expect}/ — nothing was verified`,
    };
  }

  return {
    outcome: "success",
    ok: true,
    reason: expectPattern ? `gate passed and matched /${contract.expect}/` : "gate exited 0",
  };
}

/** An unparseable pattern is a broken contract, not a passing one. */
export function contractProblems(contract: GateContract): string[] {
  const problems: string[] = [];
  if (!contract.command.trim()) problems.push("gate has no command");
  for (const [field, source] of [
    ["expect", contract.expect],
    ["failure", contract.failure],
  ] as const) {
    if (source && !compile(source)) problems.push(`gate ${field} is not a valid regular expression`);
  }
  if (contract.timeoutMs !== undefined && !(contract.timeoutMs > 0)) {
    problems.push("gate timeoutMs must be positive");
  }
  return problems;
}
