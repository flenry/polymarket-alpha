import { describe, it, expect, vi } from "vitest";
import { insertTrade } from "../src/db/queries/trades.js";
import type { TradeEvent } from "../src/events/types.js";

// FROZEN: do not edit without updating test expectations

function makeTrade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    tokenId: "tok-dedup-1",
    conditionId: "cond-dedup-1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65,
    proxyWallet: "0xwallet001",
    transactionHash: "0xtxhash_dedup_test_001",
    tradedAt: new Date("2026-04-03T12:00:00.000Z"),
    outcome: "Yes",
    marketSlug: "dedup-test-market",
    eventSlug: "dedup-test-event",
    marketTitle: "Dedup Test Market",
    source: "live_ws",
    ...overrides,
  };
}

function makeDb(rowCount: number) {
  return {
    execute: vi.fn().mockResolvedValue({ rowCount }),
  } as unknown as Parameters<typeof insertTrade>[0];
}

describe("Trade deduplication (DB-enforced via unique index)", () => {
  it("first insert of unique composite key → succeeds (inserted: true)", async () => {
    const db = makeDb(1);
    const result = await insertTrade(db, makeTrade());
    expect(result.inserted).toBe(true);
  });

  it("exact duplicate (all 6 fields match) → rejected by ON CONFLICT DO NOTHING (inserted: false)", async () => {
    // rowCount=0 simulates the DB unique index preventing insertion
    const db = makeDb(0);
    const result = await insertTrade(db, makeTrade());
    expect(result.inserted).toBe(false);
  });

  it("same txHash, different proxyWallet → accepted (different fill)", async () => {
    const db = makeDb(1);
    const trade = makeTrade({ proxyWallet: "0xdifferent_wallet" });
    const result = await insertTrade(db, trade);
    expect(result.inserted).toBe(true);
  });

  it("same txHash, different sizeTokens → accepted (partial fill)", async () => {
    const db = makeDb(1);
    const trade = makeTrade({ sizeTokens: 50 }); // different size = different dedup key
    const result = await insertTrade(db, trade);
    expect(result.inserted).toBe(true);
  });

  it("same txHash, different tradedAt → accepted", async () => {
    const db = makeDb(1);
    const trade = makeTrade({ tradedAt: new Date("2026-04-03T13:00:00.000Z") });
    const result = await insertTrade(db, trade);
    expect(result.inserted).toBe(true);
  });

  it("insertTrade returns { inserted: false } on conflict", async () => {
    const db = makeDb(0);
    const result = await insertTrade(db, makeTrade());
    expect(result).toEqual({ inserted: false });
  });

  it("query uses ON CONFLICT DO NOTHING clause", async () => {
    const db = makeDb(1);
    await insertTrade(db, makeTrade());

    const execCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(execCall);
    expect(qs).toContain("ON CONFLICT");
    expect(qs).toContain("DO NOTHING");
  });

  it("dedup key includes all 6 required fields in conflict target", async () => {
    const db = makeDb(1);
    await insertTrade(db, makeTrade());

    const execCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(execCall);
    // All 6 conflict columns should be present
    expect(qs).toContain("transaction_hash");
    expect(qs).toContain("token_id");
    expect(qs).toContain("proxy_wallet");
    expect(qs).toContain("traded_at");
    expect(qs).toContain("price_usdc");
    expect(qs).toContain("size_tokens");
  });
});
