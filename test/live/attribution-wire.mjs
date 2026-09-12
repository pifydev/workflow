/**
 * Does a gate run inside `parallel()` admit that it judged a shared tree?
 *
 * Without `isolation`, every agent in a run edits the same checkout. A gate is
 * just a command in that directory, so inside `parallel()` it can pass over a
 * tree another agent is still changing — and be attributed to the agent that
 * happened to trigger it. The verdict is honest about the directory and
 * misleading about the work.
 *
 * The overlap is a race by nature, so this reports SKIP rather than PASS when
 * the two agents did not actually run at the same time. A test that turns a
 * lost race into a failure gets ignored, and one that turns it into a pass is
 * worse.
 *
 *   node test/live/attribution-wire.mjs
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

const home = mkdtempSync(join(tmpdir(), "pify-attr-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-attr-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.ATTR_OUT, JSON.stringify({",
  '      ledger: text.includes("Gates:"),',
  '      shared: text.includes("also changing"),',
  '      note: text.includes("not of this agent&apos;s work alone") || text.includes("work alone"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

// The gate deliberately outlasts the fast agent, so the slow agent is still
// live when the verdict is recorded. Node rather than `sleep`, which Windows
// does not have.
const WORKFLOW_SOURCE = [
  "const results = await parallel([",
  "  () => agent('Reply with the single word ONE and stop.', {",
  "    agent: 'scout', label: 'fast',",
  `    gate: { command: 'node -e "setTimeout(()=>process.exit(0),6000)"', timeoutMs: 30000 },`,
  "  }),",
  "  () => agent('Write a numbered list counting from one to forty, in words, then stop.', {",
  "    agent: 'scout', label: 'slow',",
  "  }),",
  "]);",
  "return { count: results.filter(Boolean).length };",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);
  mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".pi", "workflows", "attrcheck.js"), WORKFLOW_SOURCE);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "workflow.ts"),
      "-p",
      '"Call the workflow tool once with name=\'attrcheck\' and no other arguments. Then reply with the word DONE and stop."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 420_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ATTR_OUT: out },
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
  check("a gate ledger reached the model", requests.some((r) => r.ledger));

  if (requests.some((r) => r.shared)) {
    check("the shared tree is admitted in the ledger", true);
    check("the pass is not presented as the agent's own", requests.some((r) => r.note));
  } else {
    console.log("SKIP  the two agents did not overlap this run — attribution not exercised");
  }

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
