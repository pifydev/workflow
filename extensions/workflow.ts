/**
 * @pify/workflow — deterministic multi-step agent orchestration for pi.
 *
 * The top of the Pify agent stack (subagent → swarm → workflow): the model
 * submits a JavaScript orchestration script to the `workflow` tool — with
 * agent()/parallel()/pipeline()/phase()/log()/args globals — and the script
 * fans work out across child agents from the shared .pi/agents catalog,
 * keeping intermediate results in script variables instead of chat context.
 * Scripts run in a poisoned vm context (Date.now/Math.random/eval throw)
 * so control flow stays reproducible. Saved scripts in .pi/workflows/<name>.js
 * run by name. Background runs are polled with workflow_status.
 *
 * Design synthesis: CC-style dynamic workflow tool (michaelliv/
 * pi-dynamic-workflows), vm determinism discipline (tintinweb's
 * SubagentWorkflow), saved named workflows (AgwaB), child-runner pattern
 * proven in @pify/subagent and @pify/swarm.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { spawnSync } from "node:child_process";

import { BUILTIN_AGENTS } from "../src/builtin.ts";
import {
  createIsolationWorktree,
  isolationNote,
  removeIfUnchanged,
  type Isolation,
} from "../src/isolate.ts";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildWidgetLines, formatResult, formatStatus } from "../src/report.ts";
import { runScript, type AgentOptions } from "../src/sandbox.ts";
import { readStructured, retryPrompt, schemaInstruction } from "../src/schema.ts";
import {
  AGENT_CONCURRENCY,
  MAX_PERSISTED_RESULT_CHARS,
  isRecord,
  type AgentCallState,
  type AgentDef,
  type WorkflowRun,
} from "../src/types.ts";
import {
  contractProblems,
  evaluateGate,
  normalizeGate,
  type GateContract,
  type GateVerdict,
} from "../src/gate.ts";
import { ResumeCursor, buildCache, callKey, resumeSummary } from "../src/resume.ts";

const RUN_ENTRY = "workflow-run";
const CLEAN_WORKTREE_NOTE =
  "Ran isolated in a temporary worktree; it changed nothing, so the worktree was removed.";
const FALLBACK_AGENT = "scout";
const GATE_TIMEOUT_MS = 120_000;

/**
 * Run a gate command with the shell in the child's working directory.
 * Gate commands come from the workflow script — the same trust level as the
 * bash tool in this session.
 */
/**
 * Run a gate and judge it against its contract. A bare string keeps the old
 * exit-code meaning; a contract can also say what success has to look like,
 * which is what stops a command that never ran the check from passing.
 */
function runGate(gate: string | GateContract, cwd: string): GateVerdict & { output: string } {
  const contract = normalizeGate(gate);
  const problems = contractProblems(contract);
  if (problems.length > 0) {
    return { outcome: "failure", ok: false, reason: problems.join("; "), output: "" };
  }
  const timeoutMs = contract.timeoutMs ?? GATE_TIMEOUT_MS;
  try {
    const result = spawnSync(contract.command, {
      shell: true,
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const verdict = evaluateGate(
      { ...contract, timeoutMs },
      {
        status: result.status,
        signal: result.signal,
        output,
        timedOut: result.error?.message?.includes("ETIMEDOUT") || result.signal === "SIGTERM",
      },
    );
    return { ...verdict, output };
  } catch (err) {
    return {
      outcome: "failure",
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      output: "",
    };
  }
}

type UiContext = ExtensionContext;

export default function workflow(pi: ExtensionAPI) {
  let defs = new Map<string, AgentDef>();
  const runs = new Map<string, WorkflowRun>();
  let activeRun: WorkflowRun | null = null;
  let runCounter = 0;
  let lastUiCtx: UiContext | null = null;

  function loadDefs(cwd: string): void {
    defs = new Map();
    for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
      const def = parseAgentFile(name, content, "builtin");
      if (def) defs.set(def.name, def);
    }
    for (const [dir, source] of [
      [join(getAgentDir(), "agents"), "global"],
      [join(cwd, ".pi", "agents"), "project"],
    ] as const) {
      try {
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
          try {
            const def = parseAgentFile(basename(file, ".md"), readFileSync(join(dir, file), "utf8"), source);
            if (def) defs.set(def.name, def);
          } catch {
            // skip
          }
        }
      } catch {
        // dir missing
      }
    }
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const run = activeRun;
    const now = Date.now();
    if (!run || (run.status !== "running" && (run.finishedAt ?? 0) < now - 15_000)) {
      ctx.ui.setWidget("workflow", undefined);
      return;
    }
    ctx.ui.setWidget(
      "workflow",
      (_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
        new Text(buildWidgetLines(run, theme, Date.now()).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  }

  function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  // ── Child agent runner behind a shared concurrency semaphore ─────────

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (inFlight < AGENT_CONCURRENCY) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight++;
  }

  function release(): void {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }

  /**
   * One agent call, with the resume cache in front of it. The cursor hands
   * back the prior run's result while the calls still match; the first
   * difference ends the cache and everything after it runs live.
   */
  async function runChildAgent(
    ctx: UiContext,
    run: WorkflowRun,
    cursor: ResumeCursor | null,
    prompt: string,
    opts: AgentOptions | undefined,
  ): Promise<unknown> {
    const key = callKey(prompt, opts as Record<string, unknown> | undefined);
    if (cursor) {
      const cached = cursor.next(key);
      if (cached.hit) {
        const def = defs.get((opts?.agent ?? FALLBACK_AGENT).toLowerCase()) ?? defs.get(FALLBACK_AGENT);
        run.agents.push({
          id: run.agents.length + 1,
          label: opts?.label ?? `${def?.name ?? FALLBACK_AGENT}-${run.agents.length + 1}`,
          agent: def?.name ?? FALLBACK_AGENT,
          phase: opts?.phase ?? (run.phases[run.phases.length - 1] ?? null),
          status: "done",
          turns: 0,
          tokens: 0,
          key,
          result: cached.value,
          cached: true,
        });
        renderWidget();
        return cached.value;
      }
    }
    // The spawner pushes its call state synchronously, so this index is the
    // entry it will use.
    const index = run.agents.length;
    const value = await spawnChildAgent(ctx, run, prompt, opts);
    const call = run.agents[index];
    if (call) {
      call.key = key;
      if (call.status === "done") call.result = value;
    }
    return value;
  }

  async function spawnChildAgent(
    ctx: UiContext,
    run: WorkflowRun,
    prompt: string,
    opts: AgentOptions | undefined,
  ): Promise<unknown> {
    const def = defs.get((opts?.agent ?? FALLBACK_AGENT).toLowerCase()) ?? defs.get(FALLBACK_AGENT);
    if (!def) return null;

    const call: AgentCallState = {
      id: run.agents.length + 1,
      label: opts?.label ?? `${def.name}-${run.agents.length + 1}`,
      agent: def.name,
      phase: opts?.phase ?? (run.phases[run.phases.length - 1] ?? null),
      status: "running",
      turns: 0,
      tokens: 0,
    };
    run.agents.push(call);
    renderWidget();

    await acquire();
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      let model = ctx.model ?? null;
      if (def.model) {
        const [provider, ...rest] = def.model.split("/");
        const found =
          provider && rest.length > 0 ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
        if (found) model = found;
      }
      if (!model) throw new Error("No model available");

      // v0.2: worktree isolation for mutating steps.
      let isolation: Isolation | null = null;
      if (opts?.isolation === "worktree") {
        isolation = createIsolationWorktree(ctx.cwd, `${run.runId}-${call.label}`);
      }
      const workDir = isolation?.path ?? ctx.cwd;

      const promptHost = ctx as unknown as {
        getSystemPromptOptions?: () => { customPrompt?: string; appendSystemPrompt?: string };
      };
      const promptOptions = promptHost.getSystemPromptOptions?.() ?? {};

      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        tools: def.tools,
        resourceLoader: new DefaultResourceLoader({
          cwd: workDir,
          agentDir: getAgentDir(),
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
          systemPrompt: promptOptions.customPrompt,
          appendSystemPrompt: [
            ...(promptOptions.appendSystemPrompt ? [promptOptions.appendSystemPrompt] : []),
            def.systemPrompt,
            "You are one step of a scripted workflow. Your final assistant message IS the value returned to the script — return raw data/report, no pleasantries, no questions.",
            ...(opts?.schema ? [schemaInstruction(opts.schema)] : []),
          ],
        }),
      });
      session = created.session;

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
          call.turns++;
          const usage = (event as { message?: { usage?: { totalTokens?: number } } }).message?.usage;
          if (usage && typeof usage.totalTokens === "number") call.tokens += usage.totalTokens;
          renderWidget();
          if (call.turns >= def.maxTurns) void session?.abort().catch(() => {});
        }
      });

      await session.prompt(prompt, { source: "extension" } as never);

      /** Text of the newest assistant message, with its stop reason. */
      const lastAnswer = () => {
        const messages = session!.messages as Array<{
          role?: string;
          stopReason?: unknown;
          content?: Array<{ type?: string; text?: string }>;
        }>;
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        return {
          stopReason: last?.stopReason,
          text: (last?.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
            .trim(),
        };
      };

      let { stopReason, text } = lastAnswer();

      if (stopReason === "aborted") {
        call.status = "aborted";
        return text || null;
      }
      if (stopReason === "error" || !text) {
        call.status = "error";
        return null;
      }

      // v0.3 schema: the script asked for data, so hand it data. One retry
      // with the validation errors — models fix their own shape far more
      // reliably than a second model can guess what was meant.
      if (opts?.schema) {
        let outcome = readStructured(text, opts.schema);
        if (!outcome.ok) {
          run.logs.push(`${call.label}: schema mismatch, retrying (${outcome.errors[0] ?? "invalid"})`);
          renderWidget();
          await session.prompt(retryPrompt(outcome.errors, opts.schema), { source: "extension" } as never);
          ({ text } = lastAnswer());
          outcome = readStructured(text, opts.schema);
        }
        if (!outcome.ok) {
          call.status = "error";
          run.logs.push(`${call.label}: schema still unmet — ${outcome.errors.slice(0, 2).join("; ")}`);
          renderWidget();
          return null;
        }
        if (opts.gate) {
          const gate = runGate(opts.gate, workDir);
          if (!gate.ok) {
            call.status = "error";
            run.logs.push(`gate ${gate.outcome} for ${call.label}: ${gate.reason}${gate.output ? ` — ${gate.output.slice(0, 160)}` : ""}`);
            renderWidget();
            return null;
          }
        }
        call.status = "done";
        // Structured results cross the vm boundary as plain data.
        return JSON.parse(JSON.stringify(outcome.value)) as unknown;
      }

      // v0.2 gate: verify the child's work by running a command instead of
      // asking another model (tintinweb). Non-zero exit fails the call.
      if (opts?.gate) {
        const gate = runGate(opts.gate, workDir);
        if (!gate.ok) {
          call.status = "error";
          run.logs.push(`gate failed for ${call.label}: ${gate.output.slice(0, 200)}`);
          renderWidget();
          return null;
        }
        run.logs.push(`gate passed for ${call.label} (${gate.reason})`);
      }

      call.status = "done";
      return isolation ? `${text}\n\n${isolationNote(isolation)}` : text;
    } catch {
      call.status = "error";
      return null;
    } finally {
      release();
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // gone
        }
      }
      if (session) {
        try {
          session.dispose();
        } catch {
          // fine
        }
      }
      renderWidget();
    }
  }

  // ── Execution ────────────────────────────────────────────────────────

  async function execute(
    ctx: UiContext,
    run: WorkflowRun,
    script: string,
    args: unknown,
    cursor: ResumeCursor | null = null,
  ): Promise<void> {
    try {
      const value = await runScript(script, args, {
        agent: (prompt, opts) => runChildAgent(ctx, run, cursor, prompt, opts),
        log: (message) => {
          run.logs.push(message.slice(0, 500));
          renderWidget();
        },
        phase: (title) => {
          run.phases.push(title.slice(0, 100));
          renderWidget();
        },
      });
      run.result =
        typeof value === "string" ? value : value === undefined ? null : JSON.stringify(value, null, 2);
      if (run.result && run.result.length > MAX_PERSISTED_RESULT_CHARS) {
        run.result = `${run.result.slice(0, MAX_PERSISTED_RESULT_CHARS)}\n… (truncated)`;
      }
      run.status = "done";
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      pi.appendEntry(RUN_ENTRY, run);
      renderWidget();
    }
  }

  function savedWorkflows(cwd: string): string[] {
    try {
      return readdirSync(join(cwd, ".pi", "workflows"))
        .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
        .sort();
    } catch {
      return [];
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "workflow",
    label: "Run workflow",
    description:
      "Run a deterministic JavaScript orchestration script that fans work out across child agents. " +
      "Globals: agent(prompt, {agent?, label?, phase?, gate?, isolation?, schema?}) -> Promise<string|object|null> (agent types: " +
      "reviewer/scout/worker + .pi/agents custom; write prompts as self-contained briefs); " +
      "parallel(thunks) (barrier, failures resolve null); pipeline(items, ...stages) (no barrier " +
      "between stages); phase(title); log(msg); args. The script's return value is the tool result. " +
      "Date.now()/Math.random()/eval throw (determinism). Provide script XOR name " +
      "(name loads .pi/workflows/<name>.js). background=true returns a runId for workflow_status. " +
      "agent() extras: gate=shell command run after the child (non-zero exit fails the call), or " +
      "gate={command, expect, failure, timeoutMs} so a command that exits 0 without printing the " +
      "expected evidence fails as result_missing instead of passing; " +
      "isolation=worktree runs the child in its own git worktree for mutating steps; " +
      "schema=<JSON Schema> makes the child answer with data — agent() then resolves the validated object " +
      "(one retry on mismatch, null if it still fails), so scripts never parse prose. " +
      "resumeFromRunId replays a prior run's agent results for as long as the calls match, then runs live — " +
      "edit a script and re-run it without paying for the steps that did not change.",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "JavaScript orchestration script body" })),
      name: Type.Optional(Type.String({ description: "Saved workflow name in .pi/workflows/" })),
      args: Type.Optional(Type.Unknown({ description: "Value exposed to the script as `args`" })),
      background: Type.Optional(Type.Boolean()),
      resumeFromRunId: Type.Optional(
        Type.String({ description: "Reuse a prior run's agent results for the unchanged prefix" }),
      ),
    }),
    async execute(
      _id,
      params: {
        script?: string;
        name?: string;
        args?: unknown;
        background?: boolean;
        resumeFromRunId?: string;
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const uiCtx = ctx as UiContext;
      if (activeRun?.status === "running") {
        throw new Error(`Workflow ${activeRun.runId} is still running — wait or poll workflow_status.`);
      }

      let script = params.script ?? "";
      if (params.name) {
        if (script) throw new Error("Provide script OR name, not both.");
        const safe = params.name.trim().toLowerCase();
        if (!/^[a-z0-9._-]+$/.test(safe)) throw new Error(`Invalid workflow name "${params.name}".`);
        const dir = join(uiCtx.cwd, ".pi", "workflows");
        const file = ["", ".js", ".mjs"].map((ext) => join(dir, safe + ext)).find((f) => {
          try {
            return readFileSync(f, "utf8") !== undefined;
          } catch {
            return false;
          }
        });
        if (!file) {
          throw new Error(
            `No saved workflow "${safe}". Available: ${savedWorkflows(uiCtx.cwd).join(", ") || "(none)"}`,
          );
        }
        script = readFileSync(file, "utf8");
      }
      if (!script.trim()) throw new Error("workflow requires a script (or a saved name).");

      // v0.4 resume: rebuild the prior run's reusable prefix.
      let cursor: ResumeCursor | null = null;
      let cacheSize = 0;
      const resumeId = params.resumeFromRunId?.trim();
      if (resumeId) {
        const prior = runs.get(resumeId);
        if (!prior) {
          throw new Error(
            `No run "${resumeId}" in this session. Known runs: ${[...runs.keys()].join(", ") || "(none)"}`,
          );
        }
        const cache = buildCache(prior.agents);
        cacheSize = cache.length;
        cursor = new ResumeCursor(cache);
      }

      runCounter++;
      const run: WorkflowRun = {
        runId: `w${runCounter}`,
        ...(resumeId ? { resumedFrom: resumeId } : {}),
        background: params.background === true,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        phases: [],
        agents: [],
        logs: [],
        result: null,
        error: null,
      };
      runs.set(run.runId, run);
      activeRun = run;
      renderWidget(uiCtx);

      if (cursor) run.logs.push(`resume: ${cacheSize} cached agent result(s) available from ${resumeId}`);

      if (run.background) {
        void execute(uiCtx, run, script, params.args, cursor).then(() => {
          notify(uiCtx, `workflow ${run.runId}: ${run.status}`, run.status === "done" ? "info" : "warning");
        });
        return {
          content: [{ type: "text", text: `Workflow ${run.runId} started. Poll workflow_status runId="${run.runId}".` }],
          details: { runId: run.runId },
        };
      }

      await execute(uiCtx, run, script, params.args, cursor);
      const resumeNote = cursor ? `
${resumeSummary(cursor.reused, cacheSize)}` : "";
      return {
        content: [{ type: "text", text: `${formatResult(run)}${resumeNote}` }],
        details: {
          runId: run.runId,
          status: run.status,
          agents: run.agents.length,
          ...(cursor ? { resumedFrom: resumeId, reused: cursor.reused } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow status",
    description: "Progress of a workflow run (default: the latest). Returns the result when finished.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
    }),
    async execute(_id, params: { runId?: string }) {
      const run = params.runId ? runs.get(params.runId.trim()) : activeRun ?? [...runs.values()].pop();
      if (!run) throw new Error("No workflow runs this session.");
      const text = run.status === "running" ? formatStatus(run) : formatResult(run);
      return { content: [{ type: "text", text }], details: { runId: run.runId, status: run.status } };
    },
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    loadDefs(ctx.cwd);
    runs.clear();
    activeRun = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type !== "custom" || e.customType !== RUN_ENTRY || !isRecord(e.data)) continue;
      const run = e.data as unknown as WorkflowRun;
      if (typeof run.runId === "string" && run.status !== "running") {
        runs.set(run.runId, run);
        const n = Number.parseInt(run.runId.slice(1), 10);
        if (Number.isFinite(n) && n > runCounter) runCounter = n;
      }
    }
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget("workflow", undefined);
  });

  pi.registerCommand("workflows", {
    description: "List workflow runs and saved scripts (.pi/workflows/)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const saved = savedWorkflows(ctx.cwd);
      const runLines = [...runs.values()].map((r) => formatStatus(r)).join("\n") || "(no runs yet)";
      ctx.ui.notify(
        `Saved workflows\n${saved.length > 0 ? saved.join("\n") : "(none — add .pi/workflows/<name>.js)"}\n\nRuns\n${runLines}`,
        "info",
      );
    },
  });
}
