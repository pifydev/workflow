import type { ThemeLike, WorkflowRun } from "./types.ts";

export function formatResult(run: WorkflowRun): string {
  const header = `[workflow ${run.runId}] ${run.status} — ${run.agents.length} agents, ${run.phases.length} phases`;
  if (run.status === "error") return `${header}\nError: ${run.error ?? "unknown"}`;
  if (run.status === "running") {
    return `${header}\nStill running — poll workflow_status runId="${run.runId}".`;
  }
  return `${header}\n${run.result ?? "(script returned nothing)"}`;
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
    lines.push(`${dim("│ ")}${theme.bold(run.phases[run.phases.length - 1]!)}`);
  }

  for (const agent of run.agents.slice(-6)) {
    const paint =
      agent.status === "running"
        ? (s: string) => theme.fg("warning", s)
        : agent.status === "done"
          ? (s: string) => theme.fg("success", s)
          : (s: string) => theme.fg("error", s);
    const icon = agent.status === "running" ? "⟳" : agent.status === "done" ? "✓" : "✗";
    lines.push(`${dim("│ ")}${paint(`${icon} ${agent.label}`)}${dim(` (${agent.agent})`)}`);
  }

  const lastLog = run.logs[run.logs.length - 1];
  if (lastLog) lines.push(dim(`│ ${lastLog.length > 48 ? `${lastLog.slice(0, 48)}…` : lastLog}`));

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
