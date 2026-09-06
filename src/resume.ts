/**
 * Resume: re-run a workflow and reuse the previous run's agent results for
 * the part of the script that did not change.
 *
 * The rule is a PREFIX, not a lookup table. Agent calls are cached by their
 * position in the run and the exact (prompt, options) they were made with;
 * the first call that differs ends the cache for the rest of the run. That
 * is the only version of this that stays correct: a workflow's later calls
 * are built from earlier results, so once one step's answer changes, every
 * downstream prompt is potentially different even when its text happens to
 * match.
 */
import type { AgentCallState } from "./types.ts";

export interface CachedCall {
  key: string;
  result: unknown;
}

/** Stable key for one agent call: same prompt, same options, same key. */
export function callKey(prompt: string, opts: Record<string, unknown> | undefined): string {
  const normalized: Record<string, unknown> = {};
  for (const name of Object.keys(opts ?? {}).sort()) {
    const value = (opts as Record<string, unknown>)[name];
    if (value !== undefined) normalized[name] = value;
  }
  return JSON.stringify([prompt, normalized]);
}

/** The reusable calls from a finished run, in the order they were made. */
export function buildCache(agents: readonly AgentCallState[]): CachedCall[] {
  const cache: CachedCall[] = [];
  for (const call of agents) {
    // Only calls that finished with a recorded result can be replayed; a
    // failed or aborted step must run again.
    if (call.status !== "done" || typeof call.key !== "string" || call.result === undefined) break;
    cache.push({ key: call.key, result: call.result });
  }
  return cache;
}

export interface CacheHit {
  hit: boolean;
  value?: unknown;
}

/**
 * Track how far the cache still matches. Once `broken` is set, every
 * subsequent call runs live regardless of what it looks like.
 */
export class ResumeCursor {
  private index = 0;
  private broken = false;
  private readonly cache: readonly CachedCall[];

  constructor(cache: readonly CachedCall[]) {
    this.cache = cache;
  }

  get reused(): number {
    return this.index;
  }

  get exhausted(): boolean {
    return this.broken || this.index >= this.cache.length;
  }

  /** Consume the next cached result if this call is the same one. */
  next(key: string): CacheHit {
    if (this.broken) return { hit: false };
    const entry = this.cache[this.index];
    if (!entry || entry.key !== key) {
      this.broken = true;
      return { hit: false };
    }
    this.index++;
    return { hit: true, value: entry.result };
  }
}

export function resumeSummary(reused: number, total: number): string {
  if (total === 0) return "nothing to resume from — the prior run recorded no reusable agent results";
  if (reused === 0) return `resumed from 0 of ${total} cached results (the first call already differs)`;
  if (reused === total) return `reused all ${total} cached results, then continued live`;
  return `reused ${reused} of ${total} cached results, then continued live`;
}
