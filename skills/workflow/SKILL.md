---
name: workflow
description: Use when a task needs deterministic multi-agent orchestration - fan out, verify, synthesize across many child agents with loops/conditionals
---

# Workflows

This project has the `@pify/workflow` extension installed: the `workflow`
tool runs a JavaScript orchestration script over child agents.

## When to reach for it

- The work decomposes into many agent calls with real control flow
  (loops, conditionals, staged verification) — audits, migrations,
  multi-perspective reviews with cross-checking.
- Intermediate results should stay in script variables instead of
  flooding this conversation's context.

Use the smaller primitives when they fit: one task → agent_run
(@pify/subagent); independent parallel items → swarm_run (@pify/swarm).
Only orchestrate when the structure earns it.

## Script contract

- `agent(prompt, {agent?, label?, phase?})` → the child's report (or null
  on failure). Agent types: reviewer / scout / worker / .pi/agents custom.
  Prompts must be self-contained briefs — children see nothing else.
- `parallel(thunks)` is a barrier; failed thunks resolve null —
  `.filter(Boolean)` before use. `pipeline(items, ...stages)` has no
  barrier between stages; a throwing stage drops that item to null.
- `phase(title)` groups progress; `log(msg)` narrates; `args` carries the
  input value; the script's `return` value is the tool result.
- Determinism is enforced: `Date.now()`, `Math.random()`, argless
  `new Date()`, and `eval` throw. Pass timestamps in via `args`.
- Caps: 20 agents per run, 4 concurrent, 10-minute timeout.

## Saved workflows

Reusable scripts live in `.pi/workflows/<name>.js` and run with
`workflow name="<name>" args={...}`. Prefer a saved script when the user
runs the same orchestration repeatedly.

## Reporting a run honestly

- A workflow's result is what the script returned, not what you hoped it
  would do. `status: "error"` and a non-zero `gate` are failures; a non-zero
  exit can never be described as success.
- Count before you claim. "3 of 5 agents returned null" is a result the user
  can act on; "the workflow ran" is not.
- When a run keeps failing the same way, stop re-running it. Keep iterating
  only while each attempt reduces the failure count; if two consecutive
  attempts do not beat the best so far, report the remaining failures.
