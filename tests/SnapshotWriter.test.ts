import { describe, it, expect, vi } from "vitest";
import { SnapshotWriter } from "../src/processors/snapshot-writer.js";
import type { OrderBook } from "../src/events/types.js";
import bookFixture from "./fixtures/book-event.json" assert { type: "json" };

// FROZEN: do not edit without updating consuming tests

function makeBook(): OrderBook {
  const tokenId = bookFixture.asset_id;
  return {
    tokenId,
    conditionId: bookFixture.market,
    bids: bookFixture.bids.map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price),
    asks: bookFixture.asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price),
    timestamp: parseInt(bookFixture.timestamp, 10),
    hash: bookFixture.hash,
    capturedAt: new Date(),
  };
}

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof SnapshotWriter>[0];
}

describe("SnapshotWriter (fixture-based)", () => {
  it("writes snapshot on timer (30s interval)", async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const book = makeBook();
    const clob = {
      batchGetBooks: vi.fn().mockResolvedValue([book]),
    } as unknown as Parameters<typeof SnapshotWriter>[1];

    const writer = new SnapshotWriter(db, clob, () => [book.tokenId], 30_000);
    writer.start();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).toHaveBeenCalledWith([book.tokenId]);

    writer.stop();
    vi.useRealTimers();
  });

  it("calls batchGetBooks correctly with watchlist token IDs", async () => {
    const db = makeDb();
    const book = makeBook();
    const watchlist = [book.tokenId, "extra-token"];
    const clob = {
      batchGetBooks: vi.fn().mockResolvedValue([book]),
    } as unknown as Parameters<typeof SnapshotWriter>[1];

    const writer = new SnapshotWriter(db, clob, () => watchlist, 30_000);
    await writer.snapshot();

    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(watchlist);
  });

  it("snapshot writes correct snapshotTrigger=rest_timer", async () => {
    const db = makeDb();
    const book = makeBook();
    const clob = {
      batchGetBooks: vi.fn().mockResolvedValue([book]),
    } as unknown as Parameters<typeof SnapshotWriter>[1];

    const writer = new SnapshotWriter(db, clob, () => [book.tokenId], 30_000);
    await writer.snapshot();

    const execArgs = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(execArgs);
    expect(qs).toContain("rest_timer");
  });
});
