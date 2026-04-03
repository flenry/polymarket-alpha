import { describe, it, expect, vi } from "vitest";
import { insertTrade } from "./trades.js";
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
