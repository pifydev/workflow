import vm from "node:vm";
import { MAX_AGENTS_PER_RUN, SCRIPT_TIMEOUT_MS } from "./types.ts";
import { assertBudget, budgetView, type BudgetView } from "./budget.ts";

/**
 * Deterministic script sandbox (tintinweb's discipline, Claude Code's
 * contract): a fresh vm context exposing exactly the orchestration globals —
 * agent / parallel / pipeline / phase / log / args — with Date.now(),
 * Math.random(), argless new Date(), and string code generation poisoned so
 * a script's control flow is reproducible. This is cooperative determinism,
 * not a security boundary: the script runs at the same trust level as the
 * bash tool in the same session.
 */

export interface AgentOptions {
  agent?: string;
  label?: string;
  phase?: string;
  /**
   * Verification run after the child finishes. A string is the command and
   * the contract is its exit code; an object may also state what success has
   * to look like, so a command that exits 0 without doing the check fails as
   * `result_missing` instead of passing (v0.6).
   */
  gate?: string | { command: string; expect?: string; failure?: string; timeoutMs?: number };
  /** "worktree": run the child in an isolated git worktree (v0.2). */
  isolation?: string;
  /** JSON Schema: the child answers with data, agent() resolves an object (v0.3). */
  schema?: Record<string, unknown>;
}

export interface SandboxHooks {
  /**
   * Spawn one child agent. Resolves to its report text, or — when a schema
   * was given — the validated object; null on failure.
   */
  agent(prompt: string, opts?: AgentOptions): Promise<unknown>;
  log(message: string): void;
  phase(title: string): void;
  /**
   * Run a saved workflow inline as one step of this script, sharing the
   * run's agents, cap, semaphore, cancel and budget. Absent inside a nested
   * script: nesting is one level, so a saved workflow cannot call another.
   */
  workflow?(name: string, args: unknown): Promise<unknown>;
}

function poisonedMath(): Math {
  const clone = Object.create(Math) as Math;
  Object.defineProperty(clone, "random", {
    value: () => {
      throw new Error("Math.random() is unavailable in workflow scripts (determinism).");
    },
  });
  return clone;
}

function poisonedDate(): DateConstructor {
  return new Proxy(Date, {
    // `Date()` called as a plain function returns the live time as a string —
    // the same nondeterminism as `new Date()`, through a different trap.
    apply() {
      throw new Error("Date() without arguments is unavailable in workflow scripts (determinism).");
    },
    construct(target, args: unknown[]) {
      if (args.length === 0) {
        throw new Error("new Date() without arguments is unavailable in workflow scripts (determinism).");
      }
      return new (target as DateConstructor)(...(args as [number]));
    },
    get(target, prop) {
      if (prop === "now") {
        return () => {
          throw new Error("Date.now() is unavailable in workflow scripts (determinism).");
        };
      }
      return Reflect.get(target, prop);
    },
  }) as DateConstructor;
}

/**
 * CC-style scripts may start with `export const meta = {...}`; vm scripts
 * are not modules, so export prefixes are stripped (the binding remains).
 */
export function stripExports(script: string): string {
  return script.replace(/^\s*export\s+(?=const|let|var|function|async)/gm, "");
}

export interface RunScriptOptions {
  timeoutMs?: number;
  maxAgents?: number;
  /** The run's ceiling; shared with a nested workflow() so it cannot escape it. */
  budget?: BudgetView;
  /** The run's agent() count; shared with a nested workflow() for the same reason. */
  counter?: { calls: number };
}

/**
 * Thrown when the wall-clock deadline fires. A distinct type so the caller can
 * tell a timeout apart from a script error and cancel the run — aborting the
 * child agents the zombie vm would otherwise keep spawning — rather than only
 * marking the record "error" while paid children run on.
 */
export class ScriptTimeoutError extends Error {}

/**
 * Thrown when the script body returned while agent() calls it started were
 * still running: a forgotten `await` in a loop, or an early `return`. Without
 * this the run is recorded done with those results silently dropped while the
 * children keep spending. Distinct so the caller can stop the orphans.
 */
export class UnsettledAgentsError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(
      `Workflow returned before ${count} agent() call${count === 1 ? "" : "s"} settled — every agent() must be awaited (directly, or through parallel()/pipeline()) before the script returns.`,
    );
    this.count = count;
  }
}

export async function runScript(
  script: string,
  args: unknown,
  hooks: SandboxHooks,
  options: RunScriptOptions = {},
): Promise<unknown> {
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const counter = options.counter ?? { calls: 0 };
  const budget = options.budget ?? budgetView(null, () => 0);
  // Every agent() promise still in flight; whatever is left when the body
  // returns was never awaited.
  const inFlight = new Set<Promise<unknown>>();

  const agent = (prompt: unknown, opts?: AgentOptions): Promise<unknown> => {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent() requires a non-empty prompt string.");
    }
    counter.calls++;
    if (counter.calls > maxAgents) {
      throw new Error(`Agent cap reached (${maxAgents} per run).`);
    }
    assertBudget(budget);
    const call = hooks.agent(prompt, opts);
    inFlight.add(call);
    const settled = () => inFlight.delete(call);
    call.then(settled, settled);
    return call;
  };

  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) throw new Error("parallel() takes an array of thunks.");
    return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  };

  const pipeline = (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new Error("pipeline() takes an items array.");
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, index);
          } catch {
            return null;
          }
        }
        return value;
      }),
    );
  };

  const workflow = (name: unknown, nestedArgs?: unknown): Promise<unknown> => {
    if (typeof name !== "string" || !name.trim()) {
      return Promise.reject(new Error("workflow() requires a saved workflow name."));
    }
    if (!hooks.workflow) {
      return Promise.reject(new Error("workflow() nests one level only: a saved workflow cannot call another."));
    }
    return hooks.workflow(name, nestedArgs);
  };

  const context = vm.createContext(
    {
      agent,
      parallel,
      pipeline,
      workflow,
      phase: (title: unknown) => hooks.phase(String(title)),
      log: (message: unknown) => hooks.log(String(message)),
      args,
      // Read-only view; the ceiling is fixed for the run, the counters live.
      budget: Object.freeze({
        total: budget.total,
        spent: () => budget.spent(),
        remaining: () => budget.remaining(),
      }),
      JSON,
      Math: poisonedMath(),
      Date: poisonedDate(),
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Set,
      Map,
      console: { log: (message: unknown) => hooks.log(String(message)) },
      eval: undefined,
      Function: undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );

  const body = stripExports(script);
  const promise = vm.runInContext(
    `(async () => {\n${body}\n})()`,
    context,
    { timeout: 30_000 }, // guards synchronous runaway loops only
  ) as Promise<unknown>;

  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ScriptTimeoutError(`Workflow script timed out after ${Math.round(timeoutMs / 1000)}s.`)),
          timeoutMs,
        );
      }),
    ]);
    if (inFlight.size > 0) throw new UnsettledAgentsError(inFlight.size);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
