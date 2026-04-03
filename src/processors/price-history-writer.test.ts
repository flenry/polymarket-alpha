import { describe, it, expect, vi } from "vitest";
import { PriceHistoryWriter } from "./price-history-writer.js";
import { TypedEventBus } from "../events/bus.js";

type MockDb = { execute: ReturnType<typeof vi.fn> };

function makeDb() {
  const m: MockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
  return m as unknown as ConstructorParameters<typeof PriceHistoryWriter>[1];
}

describe("PriceHistoryWriter", () => {
  it("last_trade_price event → eventType = 'last_trade'", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    bus.emit("last_trade_price", {
      type: "last_trade_price",
      tokenId: "tok1",
      price: 0.65,
      side: "BUY",
      timestamp: Date.now(),
    });

    // Force flush
    await writer.flush();

    const execArgs = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const queryStr = JSON.stringify(execArgs);
    expect(queryStr).toContain("last_trade");

    writer.stop();
  });

  it("best_bid_ask event → two rows: best_bid and best_ask", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    bus.emit("best_bid_ask", {
      type: "best_bid_ask",
      tokenId: "tok1",
      bid: 0.64,
      ask: 0.66,
      timestamp: Date.now(),
    });

    await writer.flush();

    // Two execute calls: best_bid and best_ask
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
    const qs1 = JSON.stringify(calls[0][0]);
    const qs2 = JSON.stringify(calls[1][0]);
    expect(qs1).toContain("best_bid");
    expect(qs2).toContain("best_ask");

    writer.stop();
  });

  it("batch flush triggered at batchSize rows", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 3, 5000); // batchSize=3
    writer.start();

    // Emit 3 events — should auto-flush at 3 (actually 3 batch items)
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.65, side: "BUY", timestamp: Date.now() });
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.66, side: "BUY", timestamp: Date.now() });
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.67, side: "BUY", timestamp: Date.now() });

    // Wait for async flush
    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    writer.stop();
  });

  it("batch flush triggered at flushMs timer", async () => {
    vi.useFakeTimers();
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500); // flushMs=500
    writer.start();

    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.65, side: "BUY", timestamp: Date.now() });

    expect(writer.getBatchSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(500);

    // After timer, batch should be flushed
    expect(writer.getBatchSize()).toBe(0);

    vi.useRealTimers();
    writer.stop();
  });

  it("flush() returns 0 when batch is empty", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();
    const count = await writer.flush();
    expect(count).toBe(0);
    writer.stop();
  });

  it("flush() catches and logs per-record errors, continues processing", async () => {
    const bus = new TypedEventBus();
    // First call throws, second succeeds
    const executeFn = vi.fn()
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValue({ rows: [] });
    const db = { execute: executeFn } as unknown as ConstructorParameters<typeof PriceHistoryWriter>[1];
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.65, side: "BUY", timestamp: Date.now() });
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok2", price: 0.66, side: "BUY", timestamp: Date.now() });

    // flush: first throws (caught), second succeeds
    const count = await writer.flush();
    expect(count).toBe(1); // only second insert succeeded
    expect(executeFn).toHaveBeenCalledTimes(2);

    writer.stop();
  });

  it("maybeFlush catch branch: flush error logged when batchSize hit and flush rejects (line 83)", async () => {
    const bus = new TypedEventBus();
    // DB that always rejects
    const executeFn = vi.fn().mockRejectedValue(new Error("DB error"));
    const db = { execute: executeFn } as unknown as ConstructorParameters<typeof PriceHistoryWriter>[1];
    // batchSize=2 — third event triggers maybeFlush
    const writer = new PriceHistoryWriter(bus, db, 2, 60_000);
    writer.start();

    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.65, side: "BUY", timestamp: Date.now() });
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok2", price: 0.66, side: "BUY", timestamp: Date.now() });

    // Allow the async .catch() to run
    await new Promise((r) => setTimeout(r, 50));

    // execute was called (the error path in flush was hit via maybeFlush)
    expect(executeFn).toHaveBeenCalled();

    writer.stop();
  });

  it("best_bid_ask with no timestamp: uses Date.now() fallback (lines 51, 59 ?? branch)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    // No timestamp field — exercises evt.timestamp ?? Date.now() fallback
    bus.emit("best_bid_ask", {
      type: "best_bid_ask",
      tokenId: "tok1",
      bid: 0.64,
      ask: 0.66,
      // timestamp intentionally omitted
    } as unknown as { type: "best_bid_ask"; tokenId: string; bid: number; ask: number; timestamp: number });

    await writer.flush();

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    writer.stop();
  });

  it("flush() handles null side (line 98 r.side ?? null branch)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    // Emit a last_trade_price with no side to get a record with side=undefined
    bus.emit("last_trade_price", {
      type: "last_trade_price",
      tokenId: "tok1",
      price: 0.65,
      side: undefined as unknown as "BUY",
      timestamp: Date.now(),
    });

    await writer.flush();

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toBeDefined(); // no throw
    writer.stop();
  });

  it("setInterval catch branch: flush error logged when timer fires and flush rejects (line 67)", async () => {
    vi.useFakeTimers();
    const bus = new TypedEventBus();
    const executeFn = vi.fn().mockRejectedValue(new Error("DB error"));
    const db = { execute: executeFn } as unknown as ConstructorParameters<typeof PriceHistoryWriter>[1];
    const writer = new PriceHistoryWriter(bus, db, 100, 500);
    writer.start();

    // Put an item in the batch without triggering batchSize flush
    bus.emit("last_trade_price", { type: "last_trade_price", tokenId: "tok1", price: 0.65, side: "BUY", timestamp: Date.now() });
    expect(writer.getBatchSize()).toBe(1);

    // Advance timer to trigger setInterval flush (which rejects via executeFn)
    await vi.advanceTimersByTimeAsync(500);

    // execute was called (the .catch error path in setInterval was hit)
    expect(executeFn).toHaveBeenCalled();

    vi.useRealTimers();
    writer.stop();
  });
});
