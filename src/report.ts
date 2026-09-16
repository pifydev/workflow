import { clampWidth } from "./widget-clamp.ts";
import { attributionNote } from "./gate.ts";
import type { ThemeLike, WorkflowRun } from "./types.ts";

/**
 * What the gates in this run actually proved.
 *
 * Without this the result is silent about them. A failed gate makes `agent()`
 * return `null`, the script's own `.filter(Boolean)` drops it, and the reader
 * gets a shorter array with no hint that a step was rejected or why — which is
 * the one thing a gate exists to say. So the reasons travel with the result.
 *
 * Compact on purpose: a clean, attributable pass needs no explanation and gets
 * one word in the tally. Only verdicts that change what the reader should do
 * spend a line.
 */
export function formatGates(run: WorkflowRun): string | null {
  const gated = run.agents.filter((a) => a.gate);
  if (gated.length === 0) return null;

  const tally = new Map<string, number>();
  for (const call of gated) tally.set(call.gate!.outcome, (tally.get(call.gate!.outcome) ?? 0) + 1);
  const summary = [...tally.entries()].map(([outcome, n]) => `${n} ${outcome}`).join(", ");

  const lines = [`Gates: ${summary}`];
  for (const call of gated) {
    const gate = call.gate!;
    const note = attributionNote(gate);
    if (gate.ok && !note) continue;
    lines.push(
      `  ${gate.ok ? "✓" : "✗"} ${call.label} — ${gate.outcome}: ${gate.reason}` +
        (note ? `\n      ${note}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * The calls that produced nothing for a reason other than a gate.
 *
 * Same problem as the gates, one layer down: a child that threw, hit a
 * provider error, answered with nothing, missed its schema twice or was
 * cancelled before it started all resolve `null`, and `null` carries no
 * reason. A gate rejection is already told by the ledger above, so a call
 * whose only failure is its gate is not repeated here.
 */
export function formatFailures(run: WorkflowRun): string | null {
  const failed = run.agents.filter(
    (a) => (a.status === "error" || a.status === "aborted") && !(a.gate && !a.gate.ok && !a.error),
  );
  if (failed.length === 0) return null;

  const tally = new Map<string, number>();
  for (const call of failed) tally.set(call.status, (tally.get(call.status) ?? 0) + 1);
  const summary = [...tally.entries()].map(([status, n]) => `${n} ${status}`).join(", ");

  const lines = [`Failures: ${summary}`];
  for (const call of failed) {
    lines.push(`  ✗ ${call.label} — ${call.status}${call.error ? `: ${call.error}` : ""}`);
  }
  return lines.join("\n");
}

export function formatResult(run: WorkflowRun): string {
  const header = `[workflow ${run.runId}] ${run.status} — ${run.agents.length} agents, ${run.phases.length} phases`;
  if (run.status === "error") return [header, `Error: ${run.error ?? "unknown"}`, formatFailures(run)].filter(Boolean).join("\n");
  if (run.status === "running") {
    return `${header}\nStill running — its result is delivered when it finishes; workflow_status runId="${run.runId}" shows progress.`;
  }
  // A cancelled run's error is the cancel note — who stopped it and what that
  // cost. Hiding it left the model with a verdict and no cause.
  const cancelled = run.status === "cancelled" ? run.error : null;
  return [header, cancelled, formatGates(run), formatFailures(run), run.result ?? "(script returned nothing)"]
    .filter(Boolean)
    .join("\n");
}

export function formatStatus(run: WorkflowRun): string {
  const agents = run.agents
    .map((a) => `${a.id}:${a.label}=${a.status}${a.turns ? `(${a.turns}t)` : ""}`)
    .join(" · ");
  const phase = run.phases.length > 0 ? ` · phase: ${run.phases[run.phases.length - 1]}` : "";
  return `[workflow ${run.runId}] ${run.status}${phase}${agents ? ` — ${agents}` : ""}`;
}

const WIDTH = 54;

export function buildWidgetLines(run: WorkflowRun | null, theme: ThemeLike, now: number): string[] {
  if (!run) return [];
  if (run.status !== "running" && (run.finishedAt ?? 0) < now - 15_000) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [];
  const title = ` ⚙ workflow ${run.runId} `;
  const hint = " /workflows ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  lines.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

  if (run.phases.length > 0) {
    lines.push(`${dim("│ ")}${theme.bold(clampWidth(run.phases[run.phases.length - 1]!))}`);
  }

  for (const agent of run.agents.slice(-6)) {
    const paint =
      agent.status === "running"
        ? (s: string) => theme.fg("warning", s)
        : agent.status === "done"
          ? (s: string) => theme.fg("success", s)
          : (s: string) => theme.fg("error", s);
    const icon = agent.status === "running" ? "⟳" : agent.status === "done" ? "✓" : "✗";
    lines.push(`${dim("│ ")}${paint(`${icon} ${clampWidth(agent.label, 32)}`)}${dim(` (${clampWidth(agent.agent, 16)})`)}`);
  }

  const lastLog = run.logs[run.logs.length - 1];
  if (lastLog) lines.push(dim(`│ ${lastLog.length > 48 ? `${lastLog.slice(0, 48)}…` : lastLog}`));

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
