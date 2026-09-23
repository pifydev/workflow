/**
 * A token ceiling for one run, and the `budget` global a script sees.
 *
 * The 20-agent cap bounds a run by count, which says nothing about cost: one
 * child can spend more than ten. A budget is denominated in the tokens this
 * package already tracks per call (usage.totalTokens — input and output
 * together, so the ceiling is a TOTAL-token one, not output-only). It is a
 * hard ceiling: once spent >= total, the next agent() refuses; children
 * already running finish. Scripts read it to scale their own depth:
 *
 *   while (budget.total && budget.remaining() > 50_000) { ... }
 *
 * Zero dependencies; pure.
 */

export interface BudgetView {
  /** Ceiling in tokens, or null for unlimited. Fixed for the run. */
  total: number | null;
  /** Tokens spent so far across every agent() of the run (nested calls included). */
  spent(): number;
  /** total - spent, floored at 0; Infinity when there is no ceiling. */
  remaining(): number;
}

export class BudgetExceededError extends Error {}

/**
 * "500k", "1.5m", "250000", 250000 → tokens; "off" / "none" / "unlimited" /
 * "" / undefined / null → null. Anything else is a caller error.
 */
export function parseBudget(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) throw new Error(`Invalid budget ${raw} — use a positive number of tokens, "500k", "1.5m" or "off".`);
    return Math.round(raw);
  }
  if (typeof raw !== "string") throw new Error(`Invalid budget — use a number of tokens, "500k", "1.5m" or "off".`);
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "off" || text === "none" || text === "unlimited") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text);
  if (!m) throw new Error(`Invalid budget "${raw}" — use a number of tokens, "500k", "1.5m" or "off".`);
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid budget "${raw}" — it must be positive.`);
  return Math.round(n);
}

export function formatBudget(total: number | null): string {
  if (total === null) return "off";
  if (total >= 1_000_000 && total % 100_000 === 0) return `${(total / 1_000_000).toString()}m`;
  if (total >= 1_000 && total % 1_000 === 0) return `${total / 1_000}k`;
  return String(total);
}

export function budgetView(total: number | null, spent: () => number): BudgetView {
  return {
    total,
    spent: () => Math.max(0, spent()),
    remaining: () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent())),
  };
}

/** Throws when the ceiling is reached; call before starting anything paid. */
export function assertBudget(view: BudgetView): void {
  if (view.total !== null && view.spent() >= view.total) {
    throw new BudgetExceededError(
      `Token budget of ${formatBudget(view.total)} exhausted (${view.spent()} spent) — agent() refused. Children already running finish; nothing new starts.`,
    );
  }
}
