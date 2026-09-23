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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";


import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { admitChild } from "../src/admit.ts";
import { waitUntil } from "../src/wait.ts";
import { withUiLock } from "../src/ui-lock.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  persistConsent,
  readConsent,
} from "../src/consent.ts";
import { LiveChildren, cancelNote, type CancelReason } from "../src/cancel.ts";
import { DELIVERY_TYPE, deliveryMessage, pendingResult } from "../src/pending.ts";
import {
  createIsolationWorktree,
  settleWorktree,
  type Isolation,
} from "../src/isolate.ts";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildWidgetLines, formatResult, formatStatus } from "../src/report.ts";
import { runScript, ScriptTimeoutError, UnsettledAgentsError, type AgentOptions, type SandboxHooks } from "../src/sandbox.ts";
import { BudgetExceededError, budgetView, formatBudget, parseBudget } from "../src/budget.ts";
import { readStructured, retryPrompt, schemaInstruction } from "../src/schema.ts";
import {
  AGENT_CONCURRENCY,
  MAX_PERSISTED_RESULT_CHARS,
  isRecord,
  type AgentCallState,
  type AgentDef,
  type WorkflowRun,
  SCRIPT_TIMEOUT_MS,
} from "../src/types.ts";
import { attributionNote, normalizeGate, runGate, sharedWith, type GateContract } from "../src/gate.ts";

// The gate runner lives in src/gate.ts — vendored, byte-identical across
// subagent / swarm / workflow — and is re-exported here so the gate tests
// keep their import.
export { runGate };
import { ResumeCursor, buildCache, callKey, resumeSummary } from "../src/resume.ts";

const RUN_ENTRY = "workflow-run";
const FALLBACK_AGENT = "scout";

/**
 * Run a gate, record what it judged, and return whether the call may proceed.
 * The verdict is kept on the call whether it passed or failed: a run that only
 * remembers its failures cannot tell you that a pass was earned over a tree
 * somebody else was editing.
 */
async function applyGate(
  gate: string | GateContract,
  call: AgentCallState,
  workDir: string,
  run: WorkflowRun,
): Promise<boolean> {
  const verdict = await runGate(gate, workDir);
  const shared = sharedWith(call, workDir, run.agents);
  call.gate = {
    command: normalizeGate(gate).command,
    outcome: verdict.outcome,
    ok: verdict.ok,
    reason: verdict.reason,
    subject: workDir,
    sharedWith: shared,
  };
  const note = attributionNote({ ok: verdict.ok, sharedWith: shared });
  run.logs.push(
    `gate ${verdict.outcome} for ${call.label}: ${verdict.reason}` +
      (note ? ` — ${note}` : "") +
      (!verdict.ok && verdict.output ? ` — ${verdict.output.slice(0, 160)}` : ""),
  );
  return verdict.ok;
}

type UiContext = ExtensionContext;

export default function workflow(pi: ExtensionAPI) {
  let defs = new Map<string, AgentDef>();
  const runs = new Map<string, WorkflowRun>();
  let activeRun: WorkflowRun | null = null;
  let runCounter = 0;
  let lastUiCtx: UiContext | null = null;
  /**
   * Live child sessions per run. A run is a tree of provider connections, and
   * both "stop" signals — the tool's AbortSignal and session teardown — have
   * to reach every one of them.
   */
  const live = new LiveChildren();

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /** The default token ceiling for runs that do not name one; `/workflows budget` sets it. */
  function budgetFile(): string {
    return join(getAgentDir(), "pify-workflow-budget.json");
  }
  function readDefaultBudget(): number | null {
    try {
      const raw = JSON.parse(readFileSync(budgetFile(), "utf8")) as { total?: unknown };
      return parseBudget(raw?.total ?? null);
    } catch {
      return null;
    }
  }
  function writeDefaultBudget(total: number | null): void {
    writeFileSync(budgetFile(), JSON.stringify({ total }));
  }

  /**
   * A saved workflow, by name, after the project's scripts were approved.
   * Shared by the tool's name= path and a script's nested workflow() call, so
   * both go through the same name check and the same consent gate.
   */
  async function loadSavedScript(uiCtx: UiContext, name: string): Promise<string> {
    const safe = name.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(safe)) throw new Error(`Invalid workflow name "${name}".`);
    const dir = join(uiCtx.cwd, ".pi", "workflows");
    // Saved workflows are repo-shipped EXECUTABLE CODE: the script fans
    // out paid child-agent calls and its gate option runs arbitrary shell
    // commands. The vm it runs in is cooperative discipline, not
    // a security boundary — the code's old comment that a gate has "the
    // same trust level as the bash tool in this session" is only true
    // when the model wrote the script this session, and the name= path
    // loads whatever a cloned repository put on disk. memory asks consent
    // before injecting mere TEXT from a repo; code gets at least that.
    const allowed = await projectConsent(
      uiCtx,
      "workflows",
      "its own saved workflow scripts, which execute as code with shell-capable gates",
      dir,
    );
    if (!allowed) {
      throw new Error(
        `Saved workflows from this repository are not approved. Approve when prompted in the TUI, or set PIFY_TRUST_PROJECT=1 for a headless run you trust.`,
      );
    }
    const file = ["", ".js", ".mjs"].map((ext) => join(dir, safe + ext)).find((f) => {
      try {
        return readFileSync(f, "utf8") !== undefined;
      } catch {
        return false;
      }
    });
    if (!file) {
      throw new Error(`No saved workflow "${safe}". Available: ${savedWorkflows(uiCtx.cwd).join(", ") || "(none)"}`);
    }
    return readFileSync(file, "utf8");
  }

  async function projectConsent(ctx: UiContext, scope: string, what: string, dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    let raw: string | null = null;
    try {
      raw = readFileSync(consentFile(), "utf8");
    } catch {
      raw = null;
    }
    const store = parseConsent(raw);
    const verdict = decideConsent({
      projectTrusted: (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false,
      remembered: readConsent(store, ctx.cwd, scope),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await withUiLock(() => ctx.ui.confirm(`Load this project's ${scope}?`, consentQuestion(what, dir)));
    try {
      persistConsent(consentFile(), ctx.cwd, scope, approved);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  function loadDefs(cwd: string, projectAllowed: boolean): void {
    defs = new Map();
    for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
      const def = parseAgentFile(name, content, "builtin");
      if (def) defs.set(def.name, def);
    }
    // The project directory is consent-gated with the same "agents" scope
    // subagent records: a def's body becomes a child system prompt, and a
    // user who answered "no" to subagent must not have the same defs loaded
    // here the moment a workflow runs.
    const sources: Array<readonly [string, "global" | "project"]> = [
      [join(getAgentDir(), "agents"), "global"] as const,
      ...(projectAllowed ? [[join(cwd, ".pi", "agents"), "project"] as const] : []),
    ];
    for (const [dir, source] of sources) {
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

  /** Grace period a finished run stays on screen, so the verdict is seen. */
  const WIDGET_GRACE_MS = 15_000;
  /**
   * The one timer that re-renders after the grace period. Nothing else calls
   * renderWidget once a run is over — the children are gone and the script has
   * returned — so without it the finished widget stayed up until the next run.
   */
  let widgetTimer: ReturnType<typeof setTimeout> | null = null;

  function clearWidgetTimer(): void {
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = null;
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const run = activeRun;
    const now = Date.now();
    clearWidgetTimer();
    if (!run || (run.status !== "running" && (run.finishedAt ?? 0) < now - WIDGET_GRACE_MS)) {
      ctx.ui.setWidget("workflow", undefined);
      return;
    }
    if (run.status !== "running") {
      // One re-check just past the grace edge. The callback is guarded: after
      // a session switch the captured ctx throws "ctx is stale", and a timer
      // callback has nobody to catch for it.
      widgetTimer = setTimeout(
        () => {
          widgetTimer = null;
          try {
            renderWidget();
          } catch {
            // stale ctx — the widget went away with its session
          }
        },
        Math.max(0, (run.finishedAt ?? now) + WIDGET_GRACE_MS - now) + 50,
      );
      widgetTimer.unref?.();
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

  /**
   * Stop a run and everything it started. Called from the tool's AbortSignal
   * and from session teardown; both need the children to actually stop, not
   * just the record to say so.
   */
  function cancelRun(run: WorkflowRun, reason: CancelReason): void {
    const stopped = live.abortRun(run.runId);
    if (run.status === "running") {
      run.status = "cancelled";
      run.finishedAt = Date.now();
      run.error = cancelNote(reason, stopped);
      run.logs.push(run.error);
    }
    for (const call of run.agents) {
      if (call.status === "running") {
        call.status = "aborted";
        call.error ??= "stopped with the run";
      }
    }
    renderWidget();
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
    // The script keeps running inside the vm after a cancel — it is ordinary
    // JavaScript and nothing can interrupt it mid-statement. What we can do is
    // refuse to start anything new, so a stopped run stops costing money at
    // the next agent() instead of finishing its whole fan-out. Any terminal
    // status counts, not just "cancelled": a timeout marks the run cancelled,
    // but an error or completion mid-fan-out must also refuse new children.
    if (run.status !== "running") return null;

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
    let releaseLive: (() => void) | null = null;
    // Declared outside the try so the finally can ALWAYS close the worktree,
    // and settled at most once (the prose path settles inline to fold the note
    // into its text; every other path — schema, gate failure, abort, error,
    // thrown — leaves it to the finally).
    let isolation: Isolation | null = null;
    let worktreeSettled = false;
    try {
      // Second look at the flag: the slot may have arrived long after Esc.
      // cancelRun only aborts sessions in `live`, and this call has none yet.
      // Inside the try on purpose — the finally is what gives the slot back.
      if (!admitChild(run, call, "slot")) return null;

      let model = ctx.model ?? null;
      if (def.model) {
        const [provider, ...rest] = def.model.split("/");
        const found =
          provider && rest.length > 0 ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
        if (found) model = found;
      }
      if (!model) throw new Error("No model available");

      // v0.2: worktree isolation for mutating steps.
      if (opts?.isolation === "worktree") {
        isolation = createIsolationWorktree(ctx.cwd, `${run.runId}-${call.label}`);
      }
      const workDir = isolation?.path ?? ctx.cwd;
      call.workDir = workDir;

      const promptHost = ctx as unknown as {
        getSystemPromptOptions?: () => { customPrompt?: string; appendSystemPrompt?: string };
      };
      const promptOptions = promptHost.getSystemPromptOptions?.() ?? {};

      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
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
      });
      await loader.reload();
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        tools: def.tools,
        resourceLoader: loader,
      });
      session = created.session;
      releaseLive = live.register(run.runId, session);

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
          call.turns++;
          const usage = (event as { message?: { usage?: { totalTokens?: number } } }).message?.usage;
          if (usage && typeof usage.totalTokens === "number") call.tokens += usage.totalTokens;
          renderWidget();
          if (call.turns >= def.maxTurns) {
            call.error = `hit the ${def.maxTurns}-turn limit; partial answer kept`;
            void session?.abort().catch(() => {});
          }
        }
      });

      // Third look, after the session exists and is registered: a cancel that
      // landed during createAgentSession found nothing in `live` to abort, so
      // nothing would stop this prompt from going out.
      if (!admitChild(run, call, "prompt")) return null;

      await session.prompt(prompt, { source: "extension" } as never);

      /** Text of the newest assistant message, with its stop reason. */
      const lastAnswer = () => {
        const messages = session!.messages as Array<{
          role?: string;
          stopReason?: unknown;
          errorMessage?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        return {
          stopReason: last?.stopReason,
          errorMessage: typeof last?.errorMessage === "string" ? last.errorMessage : undefined,
          text: (last?.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
            .trim(),
        };
      };

      let { stopReason, errorMessage, text } = lastAnswer();

      if (stopReason === "aborted") {
        call.status = "aborted";
        return text || null;
      }
      if (stopReason === "error" || !text) {
        call.status = "error";
        call.error =
          stopReason === "error"
            ? `provider error${errorMessage ? `: ${errorMessage.slice(0, 200)}` : ""}`
            : "the child answered with no text";
        run.logs.push(`${call.label}: ${call.error}`);
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
          call.error = `schema still unmet — ${outcome.errors.slice(0, 2).join("; ")}`;
          run.logs.push(`${call.label}: ${call.error}`);
          renderWidget();
          return null;
        }
        if (opts.gate && !(await applyGate(opts.gate, call, workDir, run))) {
          call.status = "error";
          renderWidget();
          return null;
        }
        call.status = "done";
        // Structured results cross the vm boundary as plain data.
        return JSON.parse(JSON.stringify(outcome.value)) as unknown;
      }

      // v0.2 gate: verify the child's work by running a command instead of
      // asking another model (tintinweb). Non-zero exit fails the call.
      if (opts?.gate && !(await applyGate(opts.gate, call, workDir, run))) {
        call.status = "error";
        renderWidget();
        return null;
      }

      call.status = "done";
      if (!isolation) return text;
      // Prose success is the only path that folds the worktree note into its
      // returned text, so it settles inline. Every other exit — schema, gate
      // failure, abort, error, thrown — leaves the worktree to the finally,
      // which is what stopped it leaking on those paths before.
      worktreeSettled = true;
      const { note } = settleWorktree(ctx.cwd, isolation, call);
      return `${text}\n\n${note}`;
    } catch (err) {
      // "No model available", a worktree that would not create, a session
      // that would not start: each used to become a bare null. The message is
      // the only thing the model can act on.
      call.status = "error";
      call.error = err instanceof Error ? err.message : String(err);
      run.logs.push(`${call.label}: ${call.error.slice(0, 200)}`);
      return null;
    } finally {
      release();
      if (releaseLive) releaseLive();
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
      // Close out the worktree on EVERY path that did not already (schema,
      // gate failure, abort, error, thrown): removeIfUnchanged runs, and a
      // worktree kept because it holds work records its {worktree, branch} on
      // the call so the edit location is never orphaned. Dispose the session
      // first so its files are not in the tree we are inspecting.
      if (isolation && !worktreeSettled) {
        worktreeSettled = true;
        settleWorktree(ctx.cwd, isolation, call);
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
    // One ceiling and one call counter for the run, shared with anything a
    // nested workflow() starts: the nested script's agent() calls are simply
    // more calls on this run — same agents list, same semaphore, same cancel,
    // same resume journal — so it cannot escape the limits or the record.
    const budget = budgetView(run.budget ?? null, () => run.agents.reduce((n, c) => n + c.tokens, 0));
    const counter = { calls: 0 };
    const hooks = (nested: boolean): SandboxHooks => ({
      agent: (prompt, opts) => runChildAgent(ctx, run, cursor, prompt, opts),
      log: (message) => {
        run.logs.push(message.slice(0, 500));
        renderWidget();
      },
      phase: (title) => {
        run.phases.push(title.slice(0, 100));
        renderWidget();
      },
      ...(nested
        ? {}
        : {
            workflow: async (name: string, nestedArgs: unknown) => {
              const nestedScript = await loadSavedScript(ctx, name);
              run.logs.push(`workflow(${name}): nested run`);
              renderWidget();
              return runScript(nestedScript, nestedArgs, hooks(true), {
                budget,
                counter,
                // The parent's clock keeps running; the nested run gets what is left of it.
                timeoutMs: Math.max(1_000, SCRIPT_TIMEOUT_MS - (Date.now() - run.startedAt)),
              });
            },
          }),
    });
    if (run.budget) run.logs.push(`budget: ${formatBudget(run.budget)} tokens`);
    try {
      const value = await runScript(script, args, hooks(false), { budget, counter });
      run.result =
        typeof value === "string" ? value : value === undefined ? null : JSON.stringify(value, null, 2);
      if (run.result && run.result.length > MAX_PERSISTED_RESULT_CHARS) {
        run.result = `${run.result.slice(0, MAX_PERSISTED_RESULT_CHARS)}\n… (truncated)`;
      }
      // A cancelled run keeps its verdict: the script may have run to the end
      // of its own code after the children were stopped, and calling that
      // "done" would report a result nobody produced.
      if (run.status !== "cancelled") run.status = "done";
    } catch (err) {
      // A script timeout is not just an error to record: the vm keeps running
      // after the deadline (ordinary JS, uninterruptible mid-statement) and
      // would spawn more paid child agents at every remaining agent() call.
      // cancelRun aborts the live children and, with the loosened guard in
      // spawnChildAgent, refuses any the zombie script still tries to start.
      if (err instanceof ScriptTimeoutError && run.status === "running") {
        cancelRun(run, "timeout");
      } else if ((err instanceof UnsettledAgentsError || err instanceof BudgetExceededError) && run.status === "running") {
        // The body returned with children still running, or the budget ran
        // out mid-fan-out: their results have no one to receive them, so
        // stop them rather than let them finish as paid work nobody reads.
        // The run is an error, not a cancellation — the script (or its
        // budget) is what ended it, and the message says how.
        const stopped = live.abortRun(run.runId);
        for (const call of run.agents) {
          if (call.status === "running") {
            call.status = "aborted";
            call.error ??= "the script returned before this call settled";
          }
        }
        run.status = "error";
        run.error = `${err.message} ${stopped === 0 ? "" : `(${stopped} child agent${stopped === 1 ? "" : "s"} stopped)`}`.trim();
        run.logs.push(run.error);
      } else if (run.status !== "cancelled") {
        run.status = "error";
        run.error = err instanceof Error ? err.message : String(err);
      }
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
    promptSnippet: "Run a script that fans work across child agents and returns one answer",
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
      "expected evidence fails as result_missing instead of passing. A gate that could not run at " +
      "all (command will not spawn, expect/failure is not a valid regex) is no_attestation, not " +
      "failure — fix the gate, not the code. Gate verdicts are reported with the run; a gate that " +
      "judged a directory another agent was still editing says so, and isolation=worktree is the fix; " +
      "isolation=worktree runs the child in its own git worktree for mutating steps; " +
      "schema=<JSON Schema> makes the child answer with data — agent() then resolves the validated object " +
      "(one retry on mismatch, null if it still fails), so scripts never parse prose. " +
      "resumeFromRunId replays a prior run's agent results for as long as the calls match, then runs live — " +
      "edit a script and re-run it without paying for the steps that did not change. " +
      "budget=\"500k\" caps the run's total tokens (hard: agent() refuses once reached); the script sees " +
      "budget.total/spent()/remaining() and can scale itself with it. " +
      "workflow(name, args?) inside a script runs a saved workflow inline as one step (one level of nesting), " +
      "sharing this run's agents, cap, cancel and budget.",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "JavaScript orchestration script body" })),
      name: Type.Optional(Type.String({ description: "Saved workflow name in .pi/workflows/" })),
      args: Type.Optional(Type.Unknown({ description: "Value exposed to the script as `args`" })),
      budget: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description: 'Total-token ceiling for this run: "500k", "1.5m", a number, or "off" (default: /workflows budget)',
        }),
      ),
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
        budget?: string | number;
        background?: boolean;
        resumeFromRunId?: string;
      },
      signal,
      _onUpdate,
      ctx,
    ) {
      const uiCtx = ctx as UiContext;
      if (activeRun?.status === "running") {
        throw new Error(`Workflow ${activeRun.runId} is still running — its result is delivered when it finishes; workflow_status shows progress.`);
      }

      let script = params.script ?? "";
      if (params.name) {
        if (script) throw new Error("Provide script OR name, not both.");
        script = await loadSavedScript(uiCtx, params.name);
      }
      if (!script.trim()) throw new Error("workflow requires a script (or a saved name).");
      // A bad budget is a caller error before anything is spent, not after.
      const budget = params.budget !== undefined ? parseBudget(params.budget) : readDefaultBudget();

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
        ...(budget !== null ? { budget } : {}),
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

      // Esc has to reach the children, not just this record. A foreground run
      // stops with the turn; a background one outlives the tool call by
      // design, so its signal is not its cancel button.
      let stopListening: (() => void) | null = null;
      if (signal && !run.background) {
        const onAbort = () => cancelRun(run, "user-abort");
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          stopListening = () => signal.removeEventListener("abort", onAbort);
        }
      }

      if (cursor) run.logs.push(`resume: ${cacheSize} cached agent result(s) available from ${resumeId}`);

      if (run.background) {
        void execute(uiCtx, run, script, params.args, cursor)
          .then(() => {
            notify(uiCtx, `workflow ${run.runId}: ${run.status}`, run.status === "done" ? "info" : "warning");
            // The result goes to the agent, not only to the screen — otherwise
            // asking again was its only way to find out.
            pi.sendMessage(
              {
                customType: DELIVERY_TYPE,
                content: deliveryMessage(run.runId, "workflow", formatResult(run)),
                display: true,
                details: { runId: run.runId, status: run.status, agents: run.agents.length },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          })
          .catch(() => {
            // The whole chain, not just sendMessage: a /reload or session
            // switch mid-run makes every captured pi/ctx handle throw "ctx is
            // stale" on next use, and an uncaught rejection here would take
            // the process down. Delivery is a convenience; workflow_status
            // still works.
          });
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow ${run.runId} started in the background. Its result is delivered to you when it finishes — ` +
                `do not poll. workflow_status runId="${run.runId}" shows progress if you need it early. ` +
                `Esc does not reach a background run; the user stops it with /workflows stop ${run.runId}.`,
            },
          ],
          details: { runId: run.runId },
        };
      }

      try {
        await execute(uiCtx, run, script, params.args, cursor);
      } finally {
        if (stopListening) stopListening();
      }
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
    promptSnippet: "Progress of a running workflow",
    description:
      "Progress of a workflow run (default: the latest). Returns the result when finished. " +
      "wait=<seconds> (0–120) holds this call open until the run finishes or the time is up, " +
      "instead of answering 'still running' at once — useful in a headless session, where nothing is delivered later.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
      wait: Type.Optional(
        Type.Number({ description: "Seconds to wait for the run to finish before answering (0–120, default 0)" }),
      ),
    }),
    async execute(_id, params: { runId?: string; wait?: number }, signal, _onUpdate, ctx) {
      const run = params.runId ? runs.get(params.runId.trim()) : activeRun ?? [...runs.values()].pop();
      if (!run) throw new Error("No workflow runs this session.");
      // Clamped, not rejected: a model that asks for 300 gets the ceiling, not
      // a tool error to retry its way around.
      const waitMs = Math.min(120, Math.max(0, Number(params.wait) || 0)) * 1000;
      if (run.status === "running" && waitMs > 0) {
        await waitUntil(() => run.status !== "running", waitMs, 250, signal);
      }
      if (run.status === "running") {
        const pending = pendingResult({
          id: run.runId,
          kind: "running",
          startedAt: run.startedAt,
          now: Date.now(),
          collectWith: "workflow_status",
          // A headless `pi -p` run ends with this turn: "it will be delivered"
          // is a promise nothing can keep there, so the text says to collect.
          interactive: (ctx as { hasUI?: boolean }).hasUI !== false,
        });
        // The live phase/agent lines are still worth having; what changes is
        // that they no longer end in "poll me again". Headless, the collect
        // loop is the only option — so name the parameter that makes it one
        // call instead of many.
        const waitHint = pending.details.pollRequired
          ? `\nPass wait=120 to hold a single workflow_status call open until the run finishes instead of calling repeatedly.`
          : "";
        return {
          content: [{ type: "text", text: `${formatStatus(run)}

${pending.text}${waitHint}` }],
          details: pending.details as never,
        };
      }
      return { content: [{ type: "text", text: formatResult(run) }], details: { runId: run.runId, status: run.status } };
    },
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    loadDefs(
      ctx.cwd,
      await projectConsent(
        ctx as UiContext,
        "agents",
        "its own agent definitions, which override the builtins of the same name",
        join(ctx.cwd, ".pi", "agents"),
      ),
    );
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
    // A run cannot outlive the session that owns it: the conversation it was
    // writing into is gone, and nobody will ever read the result.
    for (const run of runs.values()) {
      if (run.status === "running") cancelRun(run, "session-switch");
    }
    // cancelRun just re-armed the grace timer; its callback would render into
    // a ctx that is about to go stale.
    clearWidgetTimer();
    if (ctx.hasUI) ctx.ui.setWidget("workflow", undefined);
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs and saved scripts (.pi/workflows/); `stop [runId]` cancels a run; `budget [500k|off]` shows or sets the default token ceiling",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "budget") {
        if (target === undefined) {
          notify(ctx, `Default workflow budget: ${formatBudget(readDefaultBudget())} tokens (per run; a tool call's budget= overrides it).`, "info");
          return;
        }
        let total: number | null;
        try {
          total = parseBudget(target);
        } catch (err) {
          notify(ctx, err instanceof Error ? err.message : String(err), "warning");
          return;
        }
        try {
          writeDefaultBudget(total);
        } catch (err) {
          notify(ctx, `Could not save the budget: ${err instanceof Error ? err.message : String(err)}`, "warning");
          return;
        }
        notify(ctx, `Default workflow budget set to ${formatBudget(total)} tokens.`, "info");
        return;
      }
      if (verb === "stop") {
        // A foreground run stops on Esc through the tool's AbortSignal. A
        // background run outlives its tool call by design, so that signal is
        // not its cancel button — this is.
        const run = target ? runs.get(target) : activeRun;
        if (!run) {
          notify(ctx, target ? `No workflow run "${target}" this session.` : "No workflow run to stop.", "warning");
          return;
        }
        if (run.status !== "running") {
          notify(ctx, `Workflow ${run.runId} already finished (${run.status}).`, "info");
          return;
        }
        cancelRun(run, "user-abort");
        notify(ctx, `Workflow ${run.runId} stopped — ${run.error ?? "cancelled"}`, "info");
        return;
      }
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
