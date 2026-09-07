# @pify/workflow

Deterministic multi-step agent orchestration for [pi](https://github.com/earendil-works/pi) — a Claude Code-style `workflow` tool: the model writes a small JavaScript script that fans work out across child agents, cross-checks, and returns one synthesized answer. Intermediate work stays in script variables, not your chat context.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install workflow`](https://github.com/pifydev/cli) or `pi install npm:@pify/workflow`.

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

## The contract

- **Structured output** (v0.3): `agent(prompt, { schema })` makes the child answer with data and resolves the **validated object** instead of prose — no more parsing reports in the script. A mismatch buys exactly one retry, and what goes back is a diagnostic rather than a complaint: each failure names the **subject** (the path that is wrong), the **evidence** (what the validator saw), and the **supported fixes** — plus the one instruction that turns out to matter most, *keep every field that already validates unchanged*. Measured against a near-miss answer on openrouter/qwen3-235b, four runs out of four: the old bare error list produced a valid object that had also rewritten the summary and fields nobody complained about; the diagnostic form changed only the invalid field and left the rest byte-identical. If it still fails, the call returns `null` like any other failure. (The subject/evidence/supportedFixes shape is from [`archify`](https://github.com/tt-a1i/archify).) This is load-bearing rather than decorative: in a live run against GPT-5.6 the first answer was prose and the retry produced a clean object.

```js
const REVIEW = { type: "object", required: ["findings"], properties: {
  findings: { type: "array", maxItems: 3, items: { type: "object",
    required: ["file", "severity"],
    properties: { file: { type: "string" }, severity: { type: "string", enum: ["low", "high"] } } } } } };
const review = await agent("Review src/auth for security issues.", { schema: REVIEW });
const high = review.findings.filter((f) => f.severity === "high");   // a real array
```

The supported subset is the part of JSON Schema workflow authors actually write — `type` (incl. `integer`/`null`), `properties`, `required`, `items`, `enum`, `minItems`/`maxItems`, `minimum`/`maximum`, `minLength`/`maxLength`. Keywords outside it are ignored rather than rejected, so a richer schema still works, just with less checking.

- **Resume** (v0.4): `workflow_run({ script, resumeFromRunId: "w3" })` replays the previous run's agent results for as long as the calls match — same prompt, same options, same position — and runs live from the first difference onward. Editing the last stage of a five-stage workflow costs one stage, not five.

  It is a prefix, not a lookup table, and that is deliberate: a workflow's later prompts are built from earlier results, so once one step's answer changes, every downstream call is potentially different even when its text happens to match. Only calls that finished with a recorded result are reusable; a failed or aborted step always runs again. Runs are replayed from the session file, so a resume still works after `/reload`.

- **Globals**: `agent(prompt, {agent?, label?, phase?, gate?, isolation?, schema?})` → child's report, structured object, or `null`; `parallel(thunks)` (barrier, failures → null); `pipeline(items, ...stages)` (no barrier between stages); `phase(title)`; `log(msg)`; `args`. The script's return value is the tool result.
- **Determinism enforced** in a poisoned `node:vm` context: `Date.now()`, `Math.random()`, argless `new Date()`, `eval`, and `Function` throw — control flow stays reproducible. (Cooperative discipline, not a security boundary: scripts run at the same trust level as the bash tool.)
- **One agent catalog**: `agent()` uses the same `reviewer`/`scout`/`worker` builtins and `.pi/agents/*.md` custom types as [`@pify/subagent`](https://github.com/pifydev/subagent) and [`@pify/swarm`](https://github.com/pifydev/swarm).
- **Limits**: 20 agents per run, 4 concurrent (shared semaphore), 10-minute script timeout.
- **Saved workflows**: `.pi/workflows/<name>.js` runs by name. `export const meta = {…}` prefixes are tolerated, so Claude Code-style scripts mostly run unchanged.
- **Background runs**: `background: true` returns a `runId`; poll with `workflow_status`. A live widget shows the current phase and agents; finished runs survive `/reload`. `/workflows` lists saved scripts and runs.

## The Pify agent stack

`agent_run` (one child) → `swarm_run` (independent parallel items) → `workflow` (scripted control flow). Use the smallest tool that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)

**Isolated runs clean up after themselves** (v0.4): a worktree whose child changed nothing is removed along with its branch — otherwise a read-only step left one of each behind, per run. Anything uncommitted, or any commit the child made, is kept and reported.
