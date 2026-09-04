import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript, stripExports, type SandboxHooks } from "../src/sandbox.ts";
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
