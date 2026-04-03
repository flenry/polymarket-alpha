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

  it("uses DB transaction when db.transaction() is available", async () => {
    const bus = new TypedEventBus();

    // Provide a mock that has a transaction() method
    const txMock = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: "42" }] }),
    };
    const transactionFn = vi.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    });
    const db = {
      ...makeDb(),
      transaction: transactionFn,
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(true));
    await new Promise((r) => setTimeout(r, 50));

    // transaction() should have been called
    expect(transactionFn).toHaveBeenCalledTimes(1);
    // Both insertWhaleAlert and insertSignal ran inside the tx
    expect(txMock.execute).toHaveBeenCalledTimes(2);
  });

  it("transaction: emitSignal=false skips both inserts inside tx", async () => {
    const bus = new TypedEventBus();

    const txMock = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const transactionFn = vi.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    });
    const db = {
      ...makeDb(null),
      transaction: transactionFn,
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));
    await new Promise((r) => setTimeout(r, 50));

    expect(transactionFn).toHaveBeenCalledTimes(1);
    // insertWhaleAlert returns null (emitSignal=false) → 0 execute calls inside tx
    expect(txMock.execute).toHaveBeenCalledTimes(0);
  });
});

describe("SignalAggregator error handling", () => {
  it("signalHandler catches and logs errors when insertSignal throws", async () => {
    const bus = new TypedEventBus();
    // DB that throws on execute
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("DB error")),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    // Should not throw — error is caught and logged
    expect(() => bus.emit("signal", makeSignal())).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    // execute was called (the error path was hit)
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});

describe("SignalAggregator.stop()", () => {
  it("removes bus listeners so no further inserts happen after stop()", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    // Verify listener is active
    bus.emit("signal", makeSignal());
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = (db.execute as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Stop — listeners removed
    aggregator.stop();

    // Emit again — should be ignored
    bus.emit("signal", makeSignal());
    await new Promise((r) => setTimeout(r, 50));

    const callsAfter = (db.execute as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no new calls
  });
});

describe("SignalAggregator — onWhaleInserted callback", () => {
  it("onWhaleInserted called with (alert, id) after successful whale insert", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const onWhaleInserted = vi.fn();
    const aggregator = new SignalAggregator(bus, db, onWhaleInserted);
    aggregator.start();

    const alert = makeAlert(true);
    bus.emit("whale_alert", alert);
    await new Promise((r) => setTimeout(r, 50));

    expect(onWhaleInserted).toHaveBeenCalledOnce();
    const [callAlert, callId] = onWhaleInserted.mock.calls[0];
    expect(callAlert).toBe(alert);
    expect(typeof callId).toBe("bigint");

    aggregator.stop();
  });

  it("onWhaleInserted NOT called when emitSignal=false", async () => {
    const bus = new TypedEventBus();
    const db = makeDb(null); // null → insertWhaleAlert returns null (emitSignal=false)
    const onWhaleInserted = vi.fn();
    const aggregator = new SignalAggregator(bus, db, onWhaleInserted);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));
    await new Promise((r) => setTimeout(r, 50));

    expect(onWhaleInserted).not.toHaveBeenCalled();
    aggregator.stop();
  });

  it("no onWhaleInserted provided: backward compatible, no error", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db); // no callback
    aggregator.start();

    expect(() => bus.emit("whale_alert", makeAlert(true))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    aggregator.stop();
  });
});
