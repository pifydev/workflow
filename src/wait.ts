/**
 * Wait for a condition, for a while, unless told to stop.
 *
 * workflow_status can hold the turn open instead of answering "not yet": the
 * model passes `wait` seconds and the tool polls the run until it finishes or
 * the deadline passes. Polling here is cheap — a status field, not a request —
 * and it is what lets a headless `pi -p` session, which has no follow-up
 * delivery, collect a result without spending a turn per check.
 *
 * The signal is Esc. A 120-second wait that ignored it would keep the turn
 * hostage after the user asked for it back, so an abort ends the wait at once.
 */
export function waitUntil(
  check: () => boolean,
  ms: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  if (ms <= 0 || signal?.aborted) return Promise.resolve(false);
  const deadline = Date.now() + ms;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(check());
    const tick = () => {
      if (check()) return finish(true);
      if (Date.now() >= deadline) return finish(false);
      timer = setTimeout(tick, Math.max(1, Math.min(intervalMs, deadline - Date.now())));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}
