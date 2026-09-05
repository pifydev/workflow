import vm from "node:vm";
import { MAX_AGENTS_PER_RUN, SCRIPT_TIMEOUT_MS } from "./types.ts";

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
  /** Shell command run after the child finishes; non-zero exit → result null (v0.2). */
  gate?: string;
  /** "worktree": run the child in an isolated git worktree (v0.2). */
  isolation?: string;
}

export interface SandboxHooks {
  /** Spawn one child agent; resolves to its report text or null on failure. */
  agent(prompt: string, opts?: AgentOptions): Promise<string | null>;
  log(message: string): void;
  phase(title: string): void;
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
}

export async function runScript(
  script: string,
  args: unknown,
  hooks: SandboxHooks,
  options: RunScriptOptions = {},
): Promise<unknown> {
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  let agentCalls = 0;

  const agent = (prompt: unknown, opts?: AgentOptions): Promise<string | null> => {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent() requires a non-empty prompt string.");
    }
    agentCalls++;
    if (agentCalls > maxAgents) {
      throw new Error(`Agent cap reached (${maxAgents} per run).`);
    }
    return hooks.agent(prompt, opts);
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

  const context = vm.createContext(
    {
      agent,
      parallel,
      pipeline,
      phase: (title: unknown) => hooks.phase(String(title)),
      log: (message: unknown) => hooks.log(String(message)),
      args,
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
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Workflow script timed out after ${Math.round(timeoutMs / 1000)}s.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
