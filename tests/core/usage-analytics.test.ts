import { expect, test } from "bun:test";
import { aggregateUsageHistory, calculateUsagePace } from "../../src/app";

test("usage pace projects explicit quota windows and distinguishes unknown from zero", () => {
  const startsAt = new Date("2026-09-19T00:00:00Z").getTime();
  const resetsAt = startsAt + 100 * 60_000;
  const now = startsAt + 50 * 60_000;
  const window = { used: 20, limit: 100, startsAt, resetsAt };
  expect(calculateUsagePace(window, { now })).toEqual({
    status: "ahead",
    elapsedRatio: 0.5,
    projectedUsed: 40,
    exhaustsAt: null,
  });
  expect(calculateUsagePace({ ...window, used: 48 }, { now })?.projectedUsed).toBe(96);
  expect(calculateUsagePace({ ...window, used: 48 }, { now })?.status).toBe("on-track");
  const over = calculateUsagePace({ ...window, used: 60 }, { now });
  expect(over?.status).toBe("over-pace");
  expect(over?.projectedUsed).toBe(120);
  expect(over?.exhaustsAt).toBeCloseTo(now + (40 / 60) * 50 * 60_000, 0);
  const exhaustedNow = startsAt + 20 * 60_000;
  expect(calculateUsagePace({ ...window, used: 110 }, { now: exhaustedNow })).toEqual({
    status: "exhausted",
    elapsedRatio: 0.2,
    projectedUsed: 550,
    exhaustsAt: exhaustedNow,
  });
  expect(calculateUsagePace({ ...window, used: 100 }, { now: startsAt })).toEqual({
    status: "exhausted",
    elapsedRatio: 0,
    projectedUsed: null,
    exhaustsAt: startsAt,
  });
  expect(calculateUsagePace({ ...window, used: 0 }, { now })?.projectedUsed).toBe(0);
  expect(calculateUsagePace({ ...window, used: 0 }, { now })?.status).toBe("ahead");
  expect(calculateUsagePace(window, { now: startsAt + 59_999 })).toBeNull();
  expect(calculateUsagePace(window, { now: startsAt + 60_000 })).not.toBeNull();
  expect(
    calculateUsagePace(
      { ...window, resetsAt: startsAt + 86_400_000 },
      {
        now: startsAt + 60_000,
      },
    ),
  ).toBeNull();
  for (const patch of [
    { used: null },
    { used: -1 },
    { used: Number.NaN },
    { limit: null },
    { limit: 0 },
    { startsAt: null },
    { resetsAt: startsAt },
    { resetsAt: 9e15 },
  ])
    expect(calculateUsagePace({ ...window, ...patch }, { now })).toBeNull();
  for (const time of [startsAt - 1, resetsAt, Number.NaN, 9e15]) {
    expect(calculateUsagePace(window, { now: time })).toBeNull();
  }
  expect(
    calculateUsagePace(
      { ...window, used: Number.MAX_VALUE, limit: Number.MAX_VALUE },
      {
        now,
      },
    )?.projectedUsed,
  ).toBeNull();
  expect(
    calculateUsagePace(
      { ...window, used: Number.MAX_VALUE / 2, limit: Number.MAX_VALUE },
      {
        now: exhaustedNow,
      },
    ),
  ).toBeNull();
});

test("history pads local calendar days and safely aggregates additive model rows", () => {
  const now = new Date(2026, 8, 19, 12).getTime();
  expect(aggregateUsageHistory(null, { now })).toBeNull();
  expect(aggregateUsageHistory(undefined, { now })).toBeNull();
  const empty = aggregateUsageHistory([], { now });
  expect(empty?.days.map((day) => day.date)).toEqual([
    "2026-09-13",
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-19",
  ]);
  expect(empty?.tokens).toBe(0);
  expect(empty?.days.every((day) => day.tokens === 0)).toBe(true);
  const row = { timestamp: now, model: "__proto__", tokens: 3 };
  const result = aggregateUsageHistory(
    [
      row,
      row,
      { ...row, model: "constructor", tokens: 2 },
      { ...row, timestamp: new Date(2026, 8, 13).getTime(), model: "model-a", tokens: 5 },
      { ...row, timestamp: now + 1, tokens: 100 },
      { ...row, timestamp: new Date(2026, 8, 12, 23, 59).getTime(), tokens: 100 },
    ],
    { now },
  );
  expect(result?.tokens).toBe(13);
  expect(result?.days[0]?.tokens).toBe(5);
  expect(result?.days[6]?.tokens).toBe(8);
  expect(result?.byModel.__proto__).toBe(6);
  expect(Object.entries(result?.byModel ?? {})).toContainEqual(["constructor", 2]);
  expect(Object.getPrototypeOf(result?.byModel)).toBeNull();
  expect(Object.getPrototypeOf(result?.days[6]?.byModel)).toBeNull();
  for (const patch of [
    { timestamp: Number.NaN },
    { timestamp: 9e15 },
    { tokens: -1 },
    { tokens: Number.POSITIVE_INFINITY },
    { model: "" },
  ])
    expect(() => aggregateUsageHistory([{ ...row, ...patch }], { now })).toThrow(TypeError);
  for (const days of [0, 367, 1.5, Number.NaN]) {
    expect(() => aggregateUsageHistory([], { now, days })).toThrow(RangeError);
  }
  expect(() => aggregateUsageHistory([], { now: 9e15 })).toThrow(RangeError);
  expect(() =>
    aggregateUsageHistory(
      [
        { ...row, tokens: Number.MAX_VALUE },
        { ...row, tokens: Number.MAX_VALUE },
      ],
      { now },
    ),
  ).toThrow(RangeError);
});

test("history follows local calendar boundaries through spring and fall DST", () => {
  for (const [month, day] of [
    [2, 9],
    [10, 2],
  ] as const) {
    const now = new Date(2026, month, day, 12).getTime();
    const yesterday = new Date(2026, month, day - 1);
    const today = new Date(2026, month, day);
    const result = aggregateUsageHistory(
      [
        { timestamp: yesterday.getTime(), model: "model", tokens: 2 },
        { timestamp: today.getTime() - 1, model: "model", tokens: 3 },
        { timestamp: today.getTime(), model: "model", tokens: 7 },
      ],
      { now, days: 3 },
    );
    expect(result?.days.map((bucket) => bucket.tokens)).toEqual([0, 5, 7]);
    expect(result?.days[1]?.startsAt).toBe(yesterday.getTime());
    expect(result?.days[2]?.startsAt).toBe(today.getTime());
    if (process.env.TZ === "America/New_York") {
      expect(today.getTime() - yesterday.getTime()).toBe((month === 2 ? 23 : 25) * 3_600_000);
    }
  }
});
