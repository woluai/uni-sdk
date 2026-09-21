export interface UsagePaceWindow {
    used: number | null;
    limit: number | null;
    startsAt: number | null;
    resetsAt: number | null;
}
export interface UsagePace {
    status: "ahead" | "on-track" | "over-pace" | "exhausted";
    elapsedRatio: number;
    projectedUsed: number | null;
    exhaustsAt: number | null;
}
/**
 * Project usage at its observed rate within an explicit quota window (epoch ms).
 * Returns `null` for missing/invalid inputs, inactive windows, or samples shorter
 * than one minute or 1% of the window. Exhausted quotas are reported immediately.
 * Supply the actual quota start; a reset timestamp alone cannot establish pace.
 */
export declare function calculateUsagePace(window: UsagePaceWindow, { now }?: {
    now?: number;
}): UsagePace | null;
export interface UsageHistoryRow {
    /** Epoch milliseconds; normalize source timestamps before aggregation. */
    timestamp: number;
    model: string;
    tokens: number;
}
export interface UsageHistoryDay {
    /** Local calendar date, formatted as YYYY-MM-DD (extended years use ISO signs). */
    date: string;
    startsAt: number;
    tokens: number;
    byModel: Record<string, number>;
}
export interface UsageHistory {
    /** Oldest first, including today and zero-filled days without rows. */
    days: UsageHistoryDay[];
    tokens: number;
    byModel: Record<string, number>;
}
/**
 * Aggregate normalized, additive rows into local calendar days (seven by default).
 * Missing history returns `null`; an empty array returns zero-filled history.
 * The caller handles source parsing, cumulative counters, and deduplication.
 * Valid rows after `now` or before the window are ignored. Invalid rows throw
 * TypeError; invalid options, unrepresentable day bounds, or overflow throw
 * RangeError. Model dictionaries have no prototype and accept arbitrary names.
 */
export declare function aggregateUsageHistory(rows: readonly UsageHistoryRow[] | null | undefined, { now, days }?: {
    now?: number;
    days?: number;
}): UsageHistory | null;
//# sourceMappingURL=usage-analytics.d.ts.map