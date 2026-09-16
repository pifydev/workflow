import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "../src/wait.ts";

test("resolves true as soon as the condition holds", async () => {
  let ready = false;
  setTimeout(() => (ready = true), 30);
  const t0 = Date.now();
  assert.equal(await waitUntil(() => ready, 2_000, 10), true);
  assert.ok(Date.now() - t0 < 1_000, "did not wait for the full deadline");
});

test("resolves false at the deadline when the condition never holds", async () => {
  const t0 = Date.now();
  assert.equal(await waitUntil(() => false, 60, 10), false);
  assert.ok(Date.now() - t0 >= 50, "waited roughly the deadline");
});

test("an aborted signal ends the wait early, as false", async () => {
  // The tool's AbortSignal is Esc. A 120s wait that ignored it would keep the
  // turn hostage after the user asked to stop.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const t0 = Date.now();
  assert.equal(await waitUntil(() => false, 5_000, 10, ac.signal), false);
  assert.ok(Date.now() - t0 < 1_000, "returned on abort, not at the deadline");
});

test("an already-aborted signal and a zero wait both answer immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await waitUntil(() => true, 5_000, 10, ac.signal), true, "a true condition is still true");
  assert.equal(await waitUntil(() => false, 5_000, 10, ac.signal), false);
  assert.equal(await waitUntil(() => false, 0, 10), false);
  assert.equal(await waitUntil(() => true, 0, 10), true);
});
