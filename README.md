# @pify/workflow

[![CI](https://github.com/pifydev/workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/workflow/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/workflow)](https://www.npmjs.com/package/@pify/workflow) [![npm downloads](https://img.shields.io/npm/dm/@pify/workflow)](https://www.npmjs.com/package/@pify/workflow)

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
| `budget` | string or number, optional | Total-token ceiling for the run: `"500k"`, `"1.5m"`, a number, or `"off"`. Defaults to `/workflows budget` |
| `background` | boolean, optional | Return a `runId` immediately |
| `resumeFromRunId` | string, optional | Reuse a prior run's results for the unchanged prefix |

### `workflow_status`

| Parameter | Type | Notes |
|---|---|---|
| `runId` | string, optional | Defaults to the most recent run |
| `wait` | number, optional | Seconds (0–120) to hold the call open until the run finishes before answering. Esc ends the wait |

## Script globals

| Global | Returns |
|---|---|
| `agent(prompt, opts?)` | The child's report, a validated object with `schema`, or `null` on failure |
| `parallel(thunks)` | All results — a barrier; failures resolve to `null` rather than rejecting |
| `pipeline(items, ...stages)` | Each item through every stage, with **no barrier between stages** |
| `phase(title)` | — groups the agents that follow, for the widget and the log |
| `log(msg)` | — a progress line |
| `args` | Whatever the tool call passed |
| `budget` | `{ total, spent(), remaining() }` — the run's token ceiling (`total` is `null` and `remaining()` is `Infinity` when there is none) |
| `workflow(name, args?)` | A saved workflow run inline as one step, returning whatever it returns — one level of nesting |

A budget is a hard ceiling on the run's total tokens (input and output — the figure this package already tracks per call): once it is reached the next `agent()` throws, children already running finish, and the run ends as an error that says so. Scripts scale themselves with it — `while (budget.total && budget.remaining() > 50_000) { … }` — guarding on `total` so a run with no ceiling does not loop to the agent cap.

`workflow(name, args)` runs `.pi/workflows/<name>.js` as a stage of the current script, so a reusable saved workflow composes instead of being pasted. Its agents are this run's agents: same list, same 20-agent cap, same concurrency semaphore, same cancel, same budget and same resume journal, so it can neither escape the limits nor hide from the record. A saved workflow cannot itself call `workflow()`.

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

A command that never ran the check — a mistyped script under `sh -c`, a runner that matched no tests, a stray `|| true` — exits 0 and fails as **`result_missing`** instead of certifying the step. A `failure` pattern beats a zero exit. A killed run reports `timeout` rather than a generic failure.

One step further: a check that **ran and said no** is evidence, and a check that **could not run at all** is not evidence of anything. A command that will not spawn, a runner that is not installed, a gate whose own regex does not compile — none of those are the code failing, and calling them `failure` sends the reader debugging the work instead of fixing the gate. That is **`no_attestation`**: still not a pass, but honest about having proved nothing either way. A timeout stays a real verdict, because the check was given its deadline and did not clear it.

Five outcomes, so the result says which of them happened.

### A verdict names what it judged

`agent()` without `isolation` runs in your checkout — and so does its gate. Inside `parallel()` that means a gate can pass over a tree another agent is still editing. The exit code is honest about the directory and misleading about the agent it gets attributed to.

So a verdict is recorded with its subject, and a run that cannot attribute one says so:

```
Gates: 1 success, 1 no_attestation
  ✓ fast — success: gate exited 0
      judged a directory slow was also changing — true of the tree, not of this agent's work alone
  ✗ probe — no_attestation: gate expect is not a valid regular expression
```

`isolation: "worktree"` is the fix rather than the warning: an isolated agent has its own checkout, nobody else can reach it, and its verdict is its own.

Gates run asynchronously: pi is not frozen while a two-minute test suite runs, and a gate that overruns its deadline has its whole process tree killed rather than a parent shell alone.

### Gate results reach the model

A rejected step makes `agent()` return `null`, and a script's own `.filter(Boolean)` then drops it — leaving the model a shorter array with no hint that anything was rejected or why, which is the one thing a gate exists to say. The ledger above travels with the run result, so the reasons arrive in bytes. A clean, attributable pass costs one word in the tally and no line; only verdicts that change what the reader should do spend one.

The same goes for every other way a step can come back `null`. A child that threw, a provider error, an empty answer, a schema still unmet after its retry, a call cancelled before it started — each is listed under `Failures:` in the result with its reason, so a shorter array never arrives unexplained:

```
Failures: 1 error, 1 aborted
  ✗ scout-1 — error: No model available
  ✗ worker-3 — aborted: cancelled while queued for a slot
```

A gate rejection is told once, by the gate ledger, not repeated here.

Verified where it has to be true rather than in a fixture — `test/live/gate-wire.mjs` and `test/live/attribution-wire.mjs` read pi's own provider requests and confirm the ledger, the outcome and the reason reach the model, including the shared-tree note from a real `parallel()` race.

## Resume

`workflow({ script, resumeFromRunId: "w3" })` replays the previous run's agent results for as long as the calls match — same prompt, same options, same position — and runs live from the first difference onward. Editing the last stage of a five-stage workflow costs one stage, not five.

It is a prefix, not a lookup table, and that is deliberate: a workflow's later prompts are built from earlier results, so once one step's answer changes, every downstream call is potentially different even when its text happens to match. Only calls that finished with a recorded result are reusable; a failed or aborted step always runs again. Runs are replayed from the session file, so resume still works after `/reload`.

## Behaviour

- **Determinism is enforced.** Scripts run in a poisoned `node:vm` context where `Date.now()`, `Math.random()`, argless `new Date()`, plain `Date()`, `eval` and `Function` throw, so control flow stays reproducible and resume means something. This is cooperative discipline, not a security boundary — scripts run at the same trust level as the bash tool.
- **Every `agent()` must settle before the script returns.** A forgotten `await` in a loop, or an early `return`, used to record the run as done with those results silently dropped while the children kept spending. Now the run fails loudly (`Workflow returned before N agent() call(s) settled`) and the orphaned children are stopped.
- **Stopping stops the children.** A foreground run stops on Esc; a background run outlives its tool call by design, so Esc does not reach it — `/workflows stop [runId]` does. Switching away from the session stops everything. Either way every live child is aborted, and a child still queued behind the concurrency cap, or between getting a session and sending its first prompt, is refused before it starts rather than left to run to completion on a run nobody wants. The script is ordinary JavaScript and cannot be interrupted mid-statement, so a cancelled run instead refuses to start anything new: the next `agent()` returns `null` rather than spawning. A run that reaches the end of its script after being cancelled keeps the cancelled verdict — reporting it as done would claim a result nobody produced — and its result says who stopped it and what that cost (user, timeout or session switch) instead of hiding the cause.
- **One agent catalog.** `agent()` uses the same `reviewer` / `scout` / `worker` builtins and `.pi/agents/*.md` custom types as [`@pify/subagent`](https://github.com/pifydev/subagent) and [`@pify/swarm`](https://github.com/pifydev/swarm).
- **Isolated steps clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch; anything uncommitted, and any commit the child made, is kept and reported.
- **Limits.** 20 agents per run, 4 concurrent behind a shared semaphore, a 10-minute script timeout, and an optional total-token budget (`budget=` on the call, or `/workflows budget 500k` as the default) that stops new `agent()` calls once reached. A stalled provider stream is pi's to end — its HTTP idle timeout (5 minutes by default) aborts a request that stops sending — so this package adds no watchdog of its own on top of the script timeout.
- **Saved workflows.** `.pi/workflows/<name>.js` runs by name — after you approve the repository's scripts, once per project. These are repo-shipped *executable code*: the script fans out paid child-agent calls and its `gate` option runs shell commands, and the vm it executes in is cooperative discipline, not a security boundary. So the first `name=` run asks, the answer is remembered in `pify-project-consent.json` (scope `workflows`), and a headless run needs `PIFY_TRUST_PROJECT=1`. Project agent definitions under `.pi/agents/` are gated the same way, under the same `agents` answer subagent records. An `export const meta = {…}` prefix is tolerated, so scripts written for other harnesses mostly run unchanged.
- **Background runs come back to you.** `background: true` returns a `runId`, and when the run finishes its result is **delivered** into the conversation — measured in `test/live/delivery-wire.mjs` (3/3: the background run finished and its result reached the model unasked), which also measures the consent gate in both directions: an unapproved repository's saved workflow is refused with directions, and `PIFY_TRUST_PROJECT=1` lets a trusted headless run proceed. Delivery is a property of sessions that outlive their runs — interactive sessions do, `pi -p` does not, so the test holds the session open the way a real one naturally stays open. `workflow_status` still shows the live phase and agent lines, but no longer ends in "poll me again": it returns a structured result with `retryable`, the elapsed time and `pollRequired: false`. Answering "not yet" with a tool *error* would be worse than useless — it invites the model's own retry machinery into a loop over a condition only time resolves. Where collecting within the turn is the only option — a headless `pi -p` run — `wait` turns the collect loop into one call: `workflow_status` holds open for up to 120 seconds until the run finishes, and Esc ends the wait. A live widget shows the current phase and its agents, lingers 15 seconds after the run ends so the verdict is seen, then clears; finished runs survive `/reload`.

## Command

`/workflows` — saved scripts in `.pi/workflows/`, and this session's runs.

`/workflows stop [runId]` — cancel a run (default: the active one). This is how a background run is stopped; a foreground run also stops on Esc.

`/workflows budget [500k|1.5m|off]` — show or set the default token ceiling for runs that do not pass `budget=` themselves. Stored in `pify-workflow-budget.json` next to the consent file.

## The Pify agent stack

`agent_run` (one child) → `swarm_run` (independent parallel items) → `workflow` (scripted control flow). Use the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
