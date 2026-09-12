/**
 * Two claims, one file: a repo's saved workflow needs consent, and a
 * finished background run's result reaches the model unasked.
 *
 * Both were unmeasured until the suite review. Delivery uses the same
 * sendMessage follow-up subagent proved (with the held-turn technique that
 * keeps `pi -p` from tearing the session down under the run). The consent
 * gate is this package's newest promise, so it is measured in both
 * directions: without PIFY_TRUST_PROJECT the saved script must be REFUSED
 * with an error that names the way forward, and with it the same script
 * must load, run in the background, and deliver.
 *
 *   node test/live/delivery-wire.mjs
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

const home = mkdtempSync(join(tmpdir(), "pify-wf-delivery-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-wf-delivery-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({",
  '      delivered: text.includes("you started in the background"),',
  '      refused: text.includes("are not approved"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "  let held = false;",
  '  pi.on("agent_end", async (_event, ctx) => {',
  "    if (held) return;",
  "    held = true;",
  '    if (process.env.WF_EXPECT !== "delivery") return;',
  "    const deadline = Date.now() + 180000;",
  "    for (;;) {",
  "      const finished = ctx.sessionManager.getBranch().some((e) => {",
  "        const entry = e || {};",
  '        return entry.customType === "workflow-run" && entry.data && entry.data.status && entry.data.status !== "running";',
  "      });",
  "      if (finished || Date.now() > deadline) {",
  '        appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({ waited: true, finished }) + String.fromCharCode(10));',
  "        return;",
  "      }",
  "      await new Promise((r) => setTimeout(r, 1500));",
  "    }",
  "  });",
  "}",
].join(NL);

const WORKFLOW_SOURCE = [
  "const answer = await agent('Reply with the single word PING and stop.', { agent: 'scout', label: 'one' });",
  "return { answer };",
].join(NL);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

function drive(expect, prompt, extraEnv) {
  try {
    rmSync(out, { force: true });
  } catch {
    // first run
  }
  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "workflow.ts"),
      // Wrapped in literal double quotes: unquoted sentences reach pi one
      // prompt per word on Windows under shell:true (see
      // task/test/live/sweep-wire.mjs).
      "-p", prompt,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 420_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, DELIVERY_OUT: out, WF_EXPECT: expect, ...extraEnv },
    },
  );
  return existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);
  mkdirSync(join(repo, ".pi", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".pi", "workflows", "hello.js"), WORKFLOW_SOURCE);

  // ── 1. Unapproved: the repo's script must be refused, with directions. ──
  // Headless, no PIFY_TRUST_PROJECT, no recorded answer: fail closed.
  const refusal = drive(
    "refusal",
    '"Call the workflow tool once with name=\'hello\' and no other arguments. Then reply DONE and stop."',
    { PIFY_TRUST_PROJECT: "" },
  );
  check("refusal run captured requests", refusal.length > 0, `${refusal.length}`);
  check(
    "an unapproved repo's saved workflow is refused, and the error says how to approve",
    refusal.some((r) => r.refused),
  );
  check("nothing was delivered from the refused run", !refusal.some((r) => r.delivered));

  // ── 2. Approved headlessly: load, run in background, deliver. ──────────
  const delivery = drive(
    "delivery",
    '"Call the workflow tool once with name=\'hello\' and background=true. Then reply with the word STARTED and stop. Do not call workflow_status."',
    { PIFY_TRUST_PROJECT: "1" },
  );
  const requests = delivery.filter((l) => l.delivered !== undefined);
  const wait = delivery.find((l) => l.waited);
  const delivered = requests.filter((r) => r.delivered).length;
  console.log(
    `delivery run: requests=${requests.length}, delivered=${delivered}, run finished: ${wait ? wait.finished : "unknown"}`,
  );
  check("approved run captured requests", requests.length > 0, `${requests.length}`);
  check("the background run actually finished while the session lived", wait !== undefined && wait.finished === true);
  check("the run's result reached the model unasked", delivered > 0, `${delivered} request(s)`);

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
