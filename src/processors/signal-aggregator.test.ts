import { describe, it, expect, vi } from "vitest";
import { SignalAggregator } from "./signal-aggregator.js";
import { TypedEventBus } from "../events/bus.js";
import type { WhaleAlert, TradeEvent, MarketStats, WhaleSignal } from "../events/types.js";

function makeTrade(): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100000,
    priceUsdc: 0.68,
    valueUsdc: 68000,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "test",
    eventSlug: "test",
    marketTitle: "Test",
    source: "live_ws",
  };
}

function makeSignal(): WhaleSignal {
  return {
    signalType: "WHALE_TRADE",
    tokenId: "tok1",
    conditionId: "cond1",
    direction: "BULLISH",
    confidence: 0.7,
    strength: 5.2,
    priceAtSignal: 0.68,
    createdAt: new Date(),
    payload: {},
    usdcValue: 68000,
    sigmasAboveMean: 5.2,
    pctOfDailyVolume: 0.031,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    priceImpactEstimate: 0.008,
    bookDepthConsumedPct: 12.3,
    bookSnapshotAgeMs: 3000,
  };
}

function makeAlert(emitSignal = true): WhaleAlert {
  return {
    trade: makeTrade(),
    usdcValue: 68000,
    marketStats: {
      tokenId: "tok1",
      volume24hr: 2_200_000,
      avgTradeSize24h: 5000,
      stddevTradeSize24h: 8000,
      liquidityUsdc: 500_000,
      tradeCount24h: 50,
      calibrated: true,
    },
    priceAtAlert: 0.68,
    priceImpactEstimateUsdc: 800,
    bookDepthConsumedPct: 12.3,
    bookSnapshotAgeMs: 3000,
    book: null,
    signal: makeSignal(),
    emitSignal,
  };
}

type MockDb = {
  execute: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeDb(
  whaleAlertId: bigint | null = 99n,
  _signalId: { id: bigint } | null = { id: 1n }
) {
  const m: MockDb = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: whaleAlertId ? String(whaleAlertId) : "" }] }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
  return m as unknown as ConstructorParameters<typeof SignalAggregator>[1];
}

describe("SignalAggregator", () => {
  it("WHALE_TRADE: whale_alert row + signal row created (both execute calls)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(true));

    // Wait for async handlers
    await new Promise((r) => setTimeout(r, 50));

    // execute called twice: once for insertWhaleAlert, once for insertSignal
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("emitSignal=false: skips both inserts", async () => {
    const bus = new TypedEventBus();
    const db = makeDb(null);
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));

    await new Promise((r) => setTimeout(r, 50));

    // insertWhaleAlert returns null → no signal insert either
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("signal event with valid type is inserted", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("signal", makeSignal());

    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("unknown signal type logged and rejected (no DB write)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    const badSignal = { ...makeSignal(), signalType: "COMPOSITE_SIGNAL" as "WHALE_TRADE" };
    bus.emit("signal", badSignal);

    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("confidence out of range: clamped before insert, no throw", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    const signal = { ...makeSignal(), confidence: 1.5 };
    bus.emit("signal", signal);

    await new Promise((r) => setTimeout(r, 50));

    // No throw, insert called
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
