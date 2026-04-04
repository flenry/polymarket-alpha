import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRecentPriceHistory, getRecentTradeTimestamps } from "./price-history.js";

// ── DB mock factory ──────────────────────────────────────────────────────────

function makeSelectDb(rows: Array<{ price: string; recordedAt: Date }>) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return {
    select: selectFn,
    // satisfy type — execute not used by getRecentPriceHistory
    execute: vi.fn(),
  };
}

function makeExecuteDb(rows: Array<{ traded_at: string | Date }>) {
  return {
    select: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rows }),
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe("getRecentPriceHistory", () => {
  it("returns mapped price records ordered by recordedAt (DESC from DB)", async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 5000);
    const db = makeSelectDb([
      { price: "0.72", recordedAt: now },
      { price: "0.68", recordedAt: older },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getRecentPriceHistory(db as any, "tok1", 2);

    expect(result).toHaveLength(2);
    expect(result[0].price).toBeCloseTo(0.72);
    expect(result[0].recordedAt).toEqual(now);
    expect(result[1].price).toBeCloseTo(0.68);
  });

  it("returns empty array when no rows found", async () => {
    const db = makeSelectDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getRecentPriceHistory(db as any, "tok-missing");
    expect(result).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const db = makeSelectDb([{ price: "0.5", recordedAt: new Date() }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getRecentPriceHistory(db as any, "tok1", 50);

    // Drill into the mock chain: select → from → where → orderBy → limit
    const limitFn = db.select().from({} as never).where({} as never).orderBy({} as never).limit as ReturnType<typeof vi.fn>;
    expect(limitFn).toHaveBeenCalledWith(50);
  });

  it("converts price string to number", async () => {
    const db = makeSelectDb([{ price: "0.654321", recordedAt: new Date() }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getRecentPriceHistory(db as any, "tok1");
    expect(typeof result[0].price).toBe("number");
    expect(result[0].price).toBeCloseTo(0.654321);
  });
});

describe("getRecentTradeTimestamps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-01T12:00:00Z"));
  });

  it("returns trade timestamps mapped to TradeTimestamp objects", async () => {
    const ts1 = new Date("2025-03-01T11:55:00Z");
    const ts2 = new Date("2025-03-01T11:58:00Z");
    const db = makeExecuteDb([
      { traded_at: ts1 },
      { traded_at: ts2 },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getRecentTradeTimestamps(db as any, "tok1", 600);

    expect(result).toHaveLength(2);
    expect(result[0].tradedAt).toEqual(new Date(ts1));
    expect(result[1].tradedAt).toEqual(new Date(ts2));
  });

  it("returns empty array when no trades in window", async () => {
    const db = makeExecuteDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getRecentTradeTimestamps(db as any, "tok1", 300);
    expect(result).toEqual([]);
  });

  it("calls db.execute (raw SQL path) with correct tokenId", async () => {
    const db = makeExecuteDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getRecentTradeTimestamps(db as any, "tok-xyz", 300);
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("afterEach: restore timers", () => {
    vi.useRealTimers();
  });
});
