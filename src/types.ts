/**
 * Local structural types for @pify/workflow.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

export const VALID_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type ValidTool = (typeof VALID_TOOLS)[number];

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Agent definition — same file format as @pify/subagent and @pify/swarm. */
export interface AgentDef {
  name: string;
  description: string;
  tools: ValidTool[];
  model: string | null;
  thinking: ThinkingLevelName | null;
  maxTurns: number;
  systemPrompt: string;
  source: "builtin" | "global" | "project";
  matchPatterns: string[];
  matchKeywords: string[];
}

export const DEFAULT_MAX_TURNS = 30;

/** Workflow execution limits. */
export const MAX_AGENTS_PER_RUN = 20;
export const AGENT_CONCURRENCY = 4;
export const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
/** Persisted results are capped so session files stay sane. */
export const MAX_PERSISTED_RESULT_CHARS = 32_000;

export type AgentCallStatus = "running" | "done" | "error" | "aborted";

export interface AgentCallState {
  id: number;
  label: string;
  agent: string;
  phase: string | null;
  status: AgentCallStatus;
  turns: number;
  tokens: number;
  /** Identity of the call (prompt + options), for resume (v0.4). */
  key?: string;
  /** What the call returned, replayed on resume. */
  result?: unknown;
  /** True when this result came from a prior run instead of a model. */
  cached?: boolean;
}

export type RunStatus = "running" | "done" | "error";

export interface WorkflowRun {
  runId: string;
  /** Run this one resumed from, when it did (v0.4). */
  resumedFrom?: string;
  background: boolean;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  phases: string[];
  agents: AgentCallState[];
  logs: string[];
  result: string | null;
  error: string | null;
}

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
