import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../extensions/workflow.ts";

// runGate shells out with spawnSync. spawnSync's default maxBuffer is 1 MiB; a
// real test suite or build easily prints past that, and the overflow surfaces
// as an ENOBUFS `error` — which runGate reads as a spawn failure and reports as
// `no_attestation`, i.e. passing work rejected as "the gate never ran". The fix
// raises maxBuffer to 16 MiB. This test prints ~2 MiB (over the old cap, under
// the new one) and asserts the gate is judged on its exit code, not silenced.

test("a gate whose output exceeds the 1 MiB spawnSync default still returns a real verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-wf-gate-"));
  const gen = join(dir, "gen.mjs");
  writeFileSync(gen, `process.stdout.write("x".repeat(2 * 1024 * 1024));\n`);
  try {
    // Quote both paths so a space in the runtime's install path survives the
    // shell on Windows and POSIX alike.
    const verdict = runGate(`"${execPath}" "${gen}"`, dir);
    assert.equal(
      verdict.outcome,
      "success",
      `chatty-but-passing gate must succeed, got ${verdict.outcome}: ${verdict.reason}`,
    );
    assert.equal(verdict.ok, true);
    assert.notEqual(verdict.outcome, "no_attestation", "large output must not read as a spawn failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate that fails loudly is still judged a failure, not a spawn error", () => {
  // Same large-output path, but the command exits non-zero: the verdict must be
  // an honest `failure` (the exit code), proving the buffer fix did not swallow
  // the real result.
  const dir = mkdtempSync(join(tmpdir(), "pify-wf-gate-"));
  const gen = join(dir, "gen.mjs");
  writeFileSync(gen, `process.stdout.write("x".repeat(2 * 1024 * 1024));\nprocess.exit(1);\n`);
  try {
    const verdict = runGate(`"${execPath}" "${gen}"`, dir);
    assert.equal(verdict.outcome, "failure", `expected failure, got ${verdict.outcome}: ${verdict.reason}`);
    assert.equal(verdict.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
