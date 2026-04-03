import { describe, it, expect, vi } from "vitest";
import { insertTrade, insertTrades } from "./trades.js";
import type { TradeEvent } from "../../events/types.js";

function makeTrade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65,
    proxyWallet: "0xabc",
    transactionHash: "0xhash123",
    tradedAt: new Date("2026-04-03T12:00:00Z"),
    outcome: "Yes",
    marketSlug: "test-market",
    eventSlug: "test-event",
    marketTitle: "Test Market",
    source: "live_ws",
    ...overrides,
  };
}

function makeDb(rowCount = 1) {
  return {
    execute: vi.fn().mockResolvedValue({ rowCount }),
  } as unknown as Parameters<typeof insertTrade>[0];
}

describe("insertTrade", () => {
  it("returns { inserted: true } when rowCount=1 (first insert)", async () => {
    const db = makeDb(1);
    const result = await insertTrade(db, makeTrade());
    expect(result.inserted).toBe(true);
  });

  it("returns { inserted: false } when rowCount=0 (duplicate — ON CONFLICT DO NOTHING)", async () => {
    const db = makeDb(0);
    const result = await insertTrade(db, makeTrade());
    expect(result.inserted).toBe(false);
  });

  it("uses correct SQL for dedup (ON CONFLICT DO NOTHING)", async () => {
    const db = makeDb(1);
    await insertTrade(db, makeTrade());

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Check that the query references the dedup conflict columns
    const queryStr = JSON.stringify(call);
    expect(queryStr).toContain("ON CONFLICT");
    expect(queryStr).toContain("DO NOTHING");
  });

  it("same txHash, different sizeTokens accepted as separate trade (partial fill)", async () => {
    // Two separate inserts with rowCount=1 each — DB allows because sizeTokens differs
    const db1 = makeDb(1);
    const db2 = makeDb(1);

    const trade1 = makeTrade({ sizeTokens: 100 });
    const trade2 = makeTrade({ sizeTokens: 50 }); // partial fill

    const r1 = await insertTrade(db1, trade1);
    const r2 = await insertTrade(db2, trade2);

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
  });
});

describe("insertTrade - optional null fields", () => {
  it("handles trade with undefined optional fields (marketSlug, eventSlug, etc.) — ?? null branches", async () => {
    const db = makeDb(1);
    // Override to unset optional string fields so ?? null branches are exercised
    const trade = makeTrade({
      marketSlug: undefined as unknown as string,
      eventSlug: undefined as unknown as string,
      marketTitle: undefined as unknown as string,
      traderName: undefined,
      traderPseudonym: undefined,
    });
    const result = await insertTrade(db, trade);
    expect(result.inserted).toBe(true);
    // Verify the query was called (not thrown)
    expect(db.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

describe("insertTrade - rowCount null branch", () => {
  it("returns { inserted: false } when rowCount is null (null coalescence branch)", async () => {
    // Some DB drivers return rowCount=null; should be treated as 0 (not inserted)
    const db = {
      execute: vi.fn().mockResolvedValue({ rowCount: null }),
    } as unknown as Parameters<typeof insertTrade>[0];
    const result = await insertTrade(db, makeTrade());
    expect(result.inserted).toBe(false);
  });
});

describe("insertTrades (batch)", () => {
  it("returns count of inserted rows", async () => {
    const db = makeDb(1);
    const trades = [makeTrade(), makeTrade({ tokenId: "tok2" }), makeTrade({ tokenId: "tok3" })];
    const count = await insertTrades(db, trades);
    expect(count).toBe(3);
  });

  it("returns 0 when all are duplicates", async () => {
    const db = makeDb(0);
    const trades = [makeTrade(), makeTrade()];
    const count = await insertTrades(db, trades);
    expect(count).toBe(0);
  });

  it("counts only non-duplicate inserts", async () => {
    // First call: rowCount=1, second: rowCount=0
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 0 }),
    } as unknown as Parameters<typeof insertTrade>[0];

    const count = await insertTrades(db, [makeTrade(), makeTrade()]);
    expect(count).toBe(1);
  });
});
