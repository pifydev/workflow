---
name: workflow
description: Use when a task needs deterministic multi-agent orchestration - fan out, verify, synthesize across many child agents with loops/conditionals - explains the workflow tool's script contract and when NOT to use it
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
