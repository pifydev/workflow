# @pify/workflow

Deterministic multi-step agent orchestration for [pi](https://github.com/earendil-works/pi). The model writes a small JavaScript script that fans work out across child agents, cross-checks the results, and returns one synthesised answer. Intermediate work stays in script variables rather than your chat context.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install workflow`](https://github.com/pifydev/cli) or `pi install npm:@pify/workflow`.

## Why

Fan-out is easy; *structured* fan-out is not. As soon as one step's output feeds the next, or findings need verifying by someone who did not produce them, the orchestration itself becomes the interesting part — and asking a model to hold that shape in its head across twenty tool calls is how steps get skipped.

A script holds it instead. Control flow is ordinary JavaScript, results are variables, and the model's job shrinks to writing the script and reading the answer.

## Example

```js
export const meta = { name: "review", phases: [{ title: "Find" }, { title: "Verify" }] };
phase("Find");
const findings = await parallel([
  () => agent("Review src/auth for security issues. Report file:line + why.", { agent: "reviewer", label: "auth" }),
  () => agent("Review src/api for correctness. Report file:line + why.", { agent: "reviewer", label: "api" }),
]);
phase("Verify");
const verified = await pipeline(findings.filter(Boolean),
  (finding) => agent(`Adversarially verify this finding — is it real?\n${finding}`, { agent: "scout" }));
return { findings: verified.filter(Boolean) };
```

## Tools

### `workflow`

| Parameter | Type | Notes |
|---|---|---|
| `script` | string | The orchestration script. Provide this **or** `name` |
| `name` | string | Run a saved script from `.pi/workflows/<name>.js` |
| `args` | any, optional | Exposed to the script as the global `args` |
| `background` | boolean, optional | Return a `runId` immediately |
| `resumeFromRunId` | string, optional | Reuse a prior run's results for the unchanged prefix |

### `workflow_status`

| Parameter | Type | Notes |
|---|---|---|
| `runId` | string, optional | Defaults to the most recent run |

## Script globals

| Global | Returns |
|---|---|
| `agent(prompt, opts?)` | The child's report, a validated object with `schema`, or `null` on failure |
| `parallel(thunks)` | All results — a barrier; failures resolve to `null` rather than rejecting |
| `pipeline(items, ...stages)` | Each item through every stage, with **no barrier between stages** |
| `phase(title)` | — groups the agents that follow, for the widget and the log |
| `log(msg)` | — a progress line |
| `args` | Whatever the tool call passed |

`agent()` options: `agent`, `label`, `phase`, `gate`, `isolation`, `schema`. The script's return value becomes the tool result.

`pipeline` is the one worth understanding: item A can be in stage three while item B is still in stage one. Reach for `parallel` only when a stage genuinely needs every previous result at once — deduplicating across the whole set, say — because a barrier makes every fast item wait for the slowest.

## Structured output

`agent(prompt, { schema })` makes the child answer with data and resolves the **validated object** instead of prose, so scripts stop parsing reports:

```js
const REVIEW = { type: "object", required: ["findings"], properties: {
  findings: { type: "array", maxItems: 3, items: { type: "object",
    required: ["file", "severity"],
    properties: { file: { type: "string" }, severity: { type: "string", enum: ["low", "high"] } } } } } };
const review = await agent("Review src/auth for security issues.", { schema: REVIEW });
const high = review.findings.filter((f) => f.severity === "high");   // a real array
```

A mismatch buys exactly one retry, and what goes back is a diagnostic rather than a complaint: each failure names the **subject** (the path that is wrong), the **evidence** (what the validator saw), and the **supported fixes** — plus the instruction that turns out to matter most, *keep every field that already validates unchanged*.

That last line is load-bearing. Measured against a near-miss answer on openrouter/qwen3-235b, four runs out of four: a bare error list produced a valid object that had also rewritten the summary and other fields nobody had complained about; the diagnostic form changed only the invalid field and left the rest byte-identical. If it still fails, the call returns `null` like any other failure.

The supported subset is the part of JSON Schema workflow authors actually write — `type` (including `integer` and `null`), `properties`, `required`, `items`, `enum`, `minItems`/`maxItems`, `minimum`/`maximum`, `minLength`/`maxLength`. Keywords outside it are ignored rather than rejected, so a richer schema still works, just with less checking.

## Gates that say what success looks like

`gate: "bun test"` passes on exit 0. A contract also requires the evidence:

```js
await agent("Fix the failing test.", {
  gate: { command: "bun test", expect: "0 fail", failure: "error TS", timeoutMs: 120000 },
})
```

A command that never ran the check — a mistyped script under `sh -c`, a runner that matched no tests, a stray `|| true` — exits 0 and fails as **`result_missing`** instead of certifying the step. A `failure` pattern beats a zero exit. A killed run reports `timeout` rather than a generic failure. Four outcomes, so the log says which of them happened.

## Resume

`workflow({ script, resumeFromRunId: "w3" })` replays the previous run's agent results for as long as the calls match — same prompt, same options, same position — and runs live from the first difference onward. Editing the last stage of a five-stage workflow costs one stage, not five.

It is a prefix, not a lookup table, and that is deliberate: a workflow's later prompts are built from earlier results, so once one step's answer changes, every downstream call is potentially different even when its text happens to match. Only calls that finished with a recorded result are reusable; a failed or aborted step always runs again. Runs are replayed from the session file, so resume still works after `/reload`.

## Behaviour

- **Determinism is enforced.** Scripts run in a poisoned `node:vm` context where `Date.now()`, `Math.random()`, argless `new Date()`, `eval` and `Function` throw, so control flow stays reproducible and resume means something. This is cooperative discipline, not a security boundary — scripts run at the same trust level as the bash tool.
- **Stopping stops the children.** Pressing Esc, or switching away from the session, aborts every live child. The script is ordinary JavaScript and cannot be interrupted mid-statement, so a cancelled run instead refuses to start anything new: the next `agent()` returns `null` rather than spawning. A run that reaches the end of its script after being cancelled keeps the cancelled verdict — reporting it as done would claim a result nobody produced.
- **One agent catalog.** `agent()` uses the same `reviewer` / `scout` / `worker` builtins and `.pi/agents/*.md` custom types as [`@pify/subagent`](https://github.com/pifydev/subagent) and [`@pify/swarm`](https://github.com/pifydev/swarm).
- **Isolated steps clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch; anything uncommitted, and any commit the child made, is kept and reported.
- **Limits.** 20 agents per run, 4 concurrent behind a shared semaphore, and a 10-minute script timeout.
- **Saved workflows.** `.pi/workflows/<name>.js` runs by name. An `export const meta = {…}` prefix is tolerated, so scripts written for other harnesses mostly run unchanged.
- **Background runs.** `background: true` returns a `runId` to poll with `workflow_status`. A live widget shows the current phase and its agents; finished runs survive `/reload`.

## Command

`/workflows` — saved scripts in `.pi/workflows/`, and this session's runs.

## The Pify agent stack

`agent_run` (one child) → `swarm_run` (independent parallel items) → `workflow` (scripted control flow). Use the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
