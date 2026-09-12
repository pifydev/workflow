/**
 * Does a gate's verdict actually reach the model?
 *
 * A gate that rejects a step makes `agent()` return null. The script's own
 * `.filter(Boolean)` then drops it, and the model is handed a shorter array
 * with no hint that anything was rejected or why — which is the one thing the
 * gate existed to say. The run result now carries a gate ledger, and this
 * checks that claim where it has to be true: in the bytes pi sends back.
 *
 * Print mode reports only the final text and never tool results, so stdout
 * cannot settle this. The probe reads every provider request instead.
 *
 *   node test/live/gate-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const home = mkdtempSync(join(tmpdir(), "pify-gate-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-gate-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.GATE_OUT, JSON.stringify({",
  '      ledger: text.includes("Gates:"),',
  '      outcome: text.includes("no_attestation"),',
  '      reason: text.includes("not a valid regular expression"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

// A gate whose own regex does not compile: the check can never run, so the
// honest verdict is "nothing was proved", not "your code failed". Chosen over
// a missing command because a missing command's exit code varies by shell.
const WORKFLOW_SOURCE = [
  "const answer = await agent('Reply with the single word OK and stop.', {",
  "  agent: 'scout',",
  "  label: 'probe',",
  "  gate: { command: 'echo checked', expect: '([' },",
  "});",
  "return { answer };",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);
  mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
  // Saved by name so the script does not have to survive shell quoting.
  writeFileSync(join(repo, ".pi", "workflows", "gatecheck.js"), WORKFLOW_SOURCE);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "workflow.ts"),
      // Quoted: with shell:true on Windows an unquoted sentence arrives as
      // one prompt per word.
      "-p",
      '"Call the workflow tool once with name=\'gatecheck\' and no other arguments. Then reply with the word DONE and stop."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, GATE_OUT: out },
    },
  );

  const requests = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  console.log(`requests: ${requests.length}`);
  check("requests were captured", requests.length > 0, `${requests.length}`);
  check(
    "the gate ledger reached the model",
    requests.some((r) => r.ledger),
    `${requests.filter((r) => r.ledger).length} carried it`,
  );
  check(
    "it is reported as no_attestation, not as a failure",
    requests.some((r) => r.outcome),
  );
  check(
    "the reason travels with it, in bytes",
    requests.some((r) => r.reason),
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
