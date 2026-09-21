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

function isTimestamp(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(new Date(value).getTime());
}

/**
 * Project usage at its observed rate within an explicit quota window (epoch ms).
 * Returns `null` for missing/invalid inputs, inactive windows, or samples shorter
 * than one minute or 1% of the window. Exhausted quotas are reported immediately.
 * Supply the actual quota start; a reset timestamp alone cannot establish pace.
 */
export function calculateUsagePace(
  window: UsagePaceWindow,
  { now = Date.now() }: { now?: number } = {},
): UsagePace | null {
  const { used, limit, startsAt, resetsAt } = window;
  if (
    used === null ||
    !Number.isFinite(used) ||
    used < 0 ||
    limit === null ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !isTimestamp(startsAt) ||
    !isTimestamp(resetsAt) ||
    !isTimestamp(now) ||
    resetsAt <= startsAt ||
    now < startsAt ||
    now >= resetsAt
  )
    return null;

  const duration = resetsAt - startsAt;
  const elapsed = now - startsAt;
  const elapsedRatio = elapsed / duration;
  const sampled = elapsed >= Math.max(60_000, duration * 0.01);
  const projectedUsed = sampled ? used / elapsedRatio : null;
  if (used >= limit) {
    return {
      status: "exhausted",
      elapsedRatio,
      projectedUsed: Number.isFinite(projectedUsed) ? projectedUsed : null,
      exhaustsAt: now,
    };
  }
  if (projectedUsed === null || !Number.isFinite(projectedUsed)) return null;
  const status =
    projectedUsed <= limit * 0.9 ? "ahead" : projectedUsed <= limit ? "on-track" : "over-pace";
  const exhaustsAt = status === "over-pace" ? now + ((limit - used) / used) * elapsed : null;
  if (exhaustsAt !== null && !isTimestamp(exhaustsAt)) return null;
  return { status, elapsedRatio, projectedUsed, exhaustsAt };
}

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
export function aggregateUsageHistory(
  rows: readonly UsageHistoryRow[] | null | undefined,
  { now = Date.now(), days = 7 }: { now?: number; days?: number } = {},
): UsageHistory | null {
  if (!isTimestamp(now) || !Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError("Expected a valid timestamp and 1–366 calendar days");
  }
  if (rows == null) return null;
  const history: UsageHistory = { days: [], tokens: 0, byModel: Object.create(null) };
  const buckets = new Map<number, UsageHistoryDay>();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    date.setHours(0, 0, 0, 0);
    const startsAt = date.getTime();
    if (!isTimestamp(startsAt)) throw new RangeError("Calendar day is outside the date range");
    const year = date.getFullYear();
    const yearLabel =
      year >= 0 && year <= 9999
        ? String(year).padStart(4, "0")
        : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
    const day: UsageHistoryDay = {
      date: `${yearLabel}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      startsAt,
      tokens: 0,
      byModel: Object.create(null),
    };
    history.days.push(day);
    buckets.set(startsAt, day);
  }
  for (const row of rows) {
    if (
      !row ||
      !isTimestamp(row.timestamp) ||
      !Number.isFinite(row.tokens) ||
      row.tokens < 0 ||
      typeof row.model !== "string" ||
      row.model.length === 0
    )
      throw new TypeError("Expected a valid timestamp, model name, and nonnegative token count");
    if (row.timestamp > now) continue;
    const date = new Date(row.timestamp);
    date.setHours(0, 0, 0, 0);
    const day = buckets.get(date.getTime());
    if (!day) continue;
    history.tokens += row.tokens;
    if (!Number.isFinite(history.tokens)) throw new RangeError("Usage token total overflow");
    day.tokens += row.tokens;
    day.byModel[row.model] = (day.byModel[row.model] ?? 0) + row.tokens;
    history.byModel[row.model] = (history.byModel[row.model] ?? 0) + row.tokens;
  }
  return history;
}
