import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript, ScriptTimeoutError, UnsettledAgentsError, stripExports, type SandboxHooks } from "../src/sandbox.ts";
import { BudgetExceededError, budgetView, formatBudget, parseBudget } from "../src/budget.ts";
import { buildWidgetLines, formatResult, formatStatus } from "../src/report.ts";
import type { ThemeLike, WorkflowRun } from "../src/types.ts";

const theme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function hooks(overrides: Partial<SandboxHooks> = {}): SandboxHooks & { logs: string[]; phases: string[]; prompts: string[] } {
  const logs: string[] = [];
  const phases: string[] = [];
  const prompts: string[] = [];
  return {
    logs,
    phases,
    prompts,
    agent: async (prompt) => {
      prompts.push(prompt);
      return `report for: ${prompt}`;
    },
    log: (m) => logs.push(m),
    phase: (t) => phases.push(t),
    ...overrides,
  };
}

test("script return value comes back; args pass through", async () => {
  const h = hooks();
  const result = await runScript("return args.x + 1;", { x: 41 }, h);
  assert.equal(result, 42);
});

test("agent() resolves to text; prompts arrive verbatim", async () => {
  const h = hooks();
  const result = await runScript('return await agent("check the auth module");', undefined, h);
  assert.equal(result, "report for: check the auth module");
  assert.deepEqual(h.prompts, ["check the auth module"]);
});

test("parallel() is a barrier and maps failures to null", async () => {
  const h = hooks({
    agent: async (prompt) => {
      if (prompt.includes("bad")) throw new Error("boom");
      return prompt;
    },
  });
  const result = await runScript(
    'return await parallel([() => agent("a"), () => agent("bad"), () => agent("c")]);',
    undefined,
    h,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), ["a", null, "c"]);
});

test("pipeline() runs stages per item without a barrier; stage errors drop to null", async () => {
  const h = hooks();
  const result = await runScript(
    `return await pipeline([1, 2, 3],
       (item) => item * 10,
       (prev, item, index) => { if (item === 2) throw new Error("skip"); return prev + index; });`,
    undefined,
    h,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [10, null, 32]);
});

test("phase() and log()/console.log reach the hooks", async () => {
  const h = hooks();
  await runScript('phase("Review"); log("hello"); console.log("world"); return 1;', undefined, h);
  assert.deepEqual(h.phases, ["Review"]);
  assert.deepEqual(h.logs, ["hello", "world"]);
});

test("determinism poisons: Date.now, Math.random, argless new Date throw", async () => {
  const h = hooks();
  await assert.rejects(() => runScript("return Date.now();", undefined, h), /Date\.now/);
  await assert.rejects(() => runScript("return Math.random();", undefined, h), /Math\.random/);
  await assert.rejects(() => runScript("return new Date();", undefined, h), /new Date\(\)/);
  // Called as a plain function, Date() is the same live clock through the apply trap.
  await assert.rejects(() => runScript("return Date();", undefined, h), /Date\(\)/);
  // Date WITH args still works (timestamps passed via args).
  const ok = await runScript("return new Date(args.ts).getFullYear();", { ts: Date.UTC(2026, 0, 1) }, h);
  assert.equal(ok, 2026);
});

test("eval and Function are unavailable", async () => {
  const h = hooks();
  await assert.rejects(() => runScript('return eval("1+1");', undefined, h));
  await assert.rejects(() => runScript('return Function("return 2")();', undefined, h));
});

test("agent cap enforced", async () => {
  const h = hooks();
  await assert.rejects(
    () =>
      runScript(
        "for (let i = 0; i < 25; i++) await agent(`task ${i}`); return 1;",
        undefined,
        h,
        { maxAgents: 5 },
      ),
    /Agent cap/,
  );
});

test("timeout rejects long-running scripts", async () => {
  const h = hooks({ agent: () => new Promise(() => {}) }); // never resolves
  await assert.rejects(
    () => runScript('return await agent("hang");', undefined, h, { timeoutMs: 200 }),
    /timed out/,
  );
});

test("a timeout rejects with ScriptTimeoutError so the run can be cancelled, not just logged", async () => {
  // The extension keys on this type to call cancelRun(run, "timeout"): a bare
  // Error would only be recorded as run.error while the zombie vm kept spawning
  // paid child agents. A distinct type lets the timeout be told apart from an
  // ordinary script throw.
  const h = hooks({ agent: () => new Promise(() => {}) });
  await assert.rejects(
    () => runScript('return await agent("hang");', undefined, h, { timeoutMs: 100 }),
    (err: unknown) => {
      assert.ok(err instanceof ScriptTimeoutError, "timeout is a ScriptTimeoutError");
      assert.match((err as Error).message, /timed out/);
      return true;
    },
  );
  // An ordinary throw from the script is NOT a timeout — the discriminator must
  // not over-match, or a real error would be silently treated as a deadline.
  await assert.rejects(
    () => runScript('throw new Error("boom");', undefined, h),
    (err: unknown) => !(err instanceof ScriptTimeoutError) && /boom/.test((err as Error).message),
  );
});

test("stripExports removes CC-style export prefixes only", () => {
  const script = 'export const meta = { name: "x" };\nconst a = 1;\nreturn a;';
  const stripped = stripExports(script);
  assert.ok(stripped.startsWith("const meta"));
  assert.ok(stripped.includes("const a = 1;"));
  assert.equal(stripExports("const exportCount = 1;"), "const exportCount = 1;");
});

test("CC-style script with meta runs", async () => {
  const h = hooks();
  const result = await runScript(
    `export const meta = { name: "review", phases: [{ title: "Find" }] };
     phase("Find");
     const reports = await parallel([() => agent("a"), () => agent("b")]);
     return { count: reports.length };`,
    undefined,
    h,
  );
  // Objects returned from the vm belong to another realm (different
  // Object.prototype) — JSON-normalize before comparing, exactly like the
  // extension does before persisting results.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { count: 2 });
});

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "w1",
    background: false,
    status: "done",
    startedAt: 0,
    finishedAt: 1000,
    phases: ["Review"],
    agents: [
      { id: 1, label: "review:auth", agent: "reviewer", phase: "Review", status: "done", turns: 3, tokens: 900 },
    ],
    logs: ["3 findings"],
    result: "final synthesis",
    error: null,
    ...overrides,
  };
}

test("formatResult and formatStatus", () => {
  assert.ok(formatResult(run()).includes("final synthesis"));
  assert.ok(formatResult(run({ status: "error", error: "boom" })).includes("Error: boom"));
  assert.ok(formatResult(run({ status: "running" })).includes("Still running"));
  const status = formatStatus(run({ status: "running" }));
  assert.ok(status.includes("phase: Review"));
  assert.ok(status.includes("1:review:auth=done(3t)"));
});

test("widget shows phase, agents, and last log; stale hides", () => {
  const lines = buildWidgetLines(run({ status: "running" }), theme, 5_000);
  const text = lines.join("\n");
  assert.ok(text.includes("⚙ workflow w1"));
  assert.ok(text.includes("Review"));
  assert.ok(text.includes("✓ review:auth"));
  assert.ok(text.includes("3 findings"));
  assert.deepEqual(buildWidgetLines(run(), theme, 100_000), []);
  assert.deepEqual(buildWidgetLines(null, theme, 0), []);
});

test("a script that returns before its agent() calls settle fails loudly instead of dropping their results", async () => {
  let resolveChild: (v: unknown) => void = () => {};
  const h: SandboxHooks = {
    agent: () => new Promise((resolve) => (resolveChild = resolve)),
    log: () => {},
    phase: () => {},
  };
  // The forgotten-await shape: the agent() promise is created and abandoned.
  const run = runScript('agent("slow child"); return "early";', undefined, h);
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof UnsettledAgentsError);
    assert.equal(err.count, 1);
    assert.match(err.message, /returned before 1 agent\(\) call settled/);
    return true;
  });
  resolveChild("late");
});

test("awaited agent() calls — directly or through parallel()/pipeline() — never trip the unsettled check", async () => {
  const h: SandboxHooks = {
    agent: async (prompt) => `done:${prompt}`,
    log: () => {},
    phase: () => {},
  };
  assert.equal(await runScript('return await agent("a");', undefined, h), "done:a");
  assert.deepEqual(
    await runScript('return await parallel([() => agent("a"), () => agent("b")]);', undefined, h),
    ["done:a", "done:b"],
  );
  assert.deepEqual(
    await runScript('return await pipeline(["x"], (item) => agent(item));', undefined, h),
    ["done:x"],
  );
  // A rejected agent() that was awaited (and caught) also counts as settled.
  const failing: SandboxHooks = { ...h, agent: async () => { throw new Error("boom"); } };
  assert.equal(await runScript('try { await agent("a"); } catch { return "caught"; }', undefined, failing), "caught");
});

test("parseBudget reads k/m suffixes, numbers and off; rejects nonsense", () => {
  assert.equal(parseBudget("500k"), 500_000);
  assert.equal(parseBudget("1.5m"), 1_500_000);
  assert.equal(parseBudget("250000"), 250_000);
  assert.equal(parseBudget(250_000), 250_000);
  assert.equal(parseBudget("off"), null);
  assert.equal(parseBudget(undefined), null);
  assert.throws(() => parseBudget("lots"), /Invalid budget/);
  assert.throws(() => parseBudget(-5), /Invalid budget/);
  assert.equal(formatBudget(500_000), "500k");
  assert.equal(formatBudget(1_500_000), "1.5m");
  assert.equal(formatBudget(null), "off");
});

test("budget: the script sees total/spent/remaining, and agent() refuses once the ceiling is reached", async () => {
  let spent = 0;
  const h = hooks({
    agent: async () => {
      spent += 40_000;
      return "r";
    },
  });
  const budget = budgetView(100_000, () => spent);
  // Two calls fit (0 and 40k spent at entry); the third finds 80k < 100k and
  // runs; the fourth finds 120k >= 100k and is refused.
  const result = await runScript(
    'const seen = [budget.total, budget.remaining()]; await agent("a"); await agent("b"); await agent("c"); seen.push(budget.spent(), budget.remaining()); return seen;',
    undefined,
    h,
    { budget },
  );
  assert.deepEqual(result, [100_000, 100_000, 120_000, 0]);
  await assert.rejects(() => runScript('await agent("d"); return 1;', undefined, h, { budget }), (err: unknown) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.match(err.message, /Token budget of 100k exhausted/);
    return true;
  });
  // No ceiling: remaining() is Infinity and nothing is refused.
  const free = await runScript("return [budget.total, budget.remaining()];", undefined, hooks());
  assert.deepEqual(free, [null, Number.POSITIVE_INFINITY]);
  // The loop-until-budget pattern from the README terminates on its own.
  spent = 0;
  const loops = await runScript(
    'let n = 0; while (budget.total && budget.remaining() > 50_000) { await agent("x"); n++; } return n;',
    undefined,
    h,
    { budget: budgetView(100_000, () => spent) },
  );
  assert.equal(loops, 2);
});

test("workflow(): a nested saved workflow runs through the hook, shares the agent cap, and cannot nest twice", async () => {
  const counter = { calls: 0 };
  const inner = 'return [await agent("inner-1"), await agent("inner-2"), args];';
  const h = hooks({
    workflow: (name, nestedArgs) =>
      runScript(inner, nestedArgs, { ...hooks(), agent: h.agent, workflow: undefined }, { counter, maxAgents: 3 }),
  });
  const result = await runScript(
    'const a = await agent("outer"); const b = await workflow("child", { k: 1 }); return [a, b];',
    undefined,
    h,
    { counter, maxAgents: 3 },
  );
  assert.deepEqual(result, ["report for: outer", ["report for: inner-1", "report for: inner-2", { k: 1 }]]);
  assert.equal(counter.calls, 3, "outer + two inner calls share one counter");
  // One more anywhere trips the shared cap.
  await assert.rejects(() => runScript('return await agent("over");', undefined, h, { counter, maxAgents: 3 }), /Agent cap reached/);
  // Without the hook (a nested script), workflow() is refused.
  await assert.rejects(() => runScript('return await workflow("x");', undefined, hooks()), /nests one level only/);
  await assert.rejects(() => runScript("return await workflow();", undefined, h), /requires a saved workflow name/);
});
