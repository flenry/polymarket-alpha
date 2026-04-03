import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnapshotWriter, computeDepth } from "./snapshot-writer.js";
import type { OrderBook } from "../events/types.js";

function makeBook(tokenId: string): OrderBook {
  return {
    tokenId,
    conditionId: "cond1",
    bids: [
      { price: 0.65, size: 100 },
      { price: 0.64, size: 200 },
      { price: 0.63, size: 300 },
    ],
    asks: [
      { price: 0.66, size: 150 },
      { price: 0.67, size: 100 },
    ],
    timestamp: Date.now(),
    hash: "abc123",
    capturedAt: new Date(),
  };
}

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof SnapshotWriter>[0];
}

function makeClobClient(books: OrderBook[]) {
  return {
    batchGetBooks: vi.fn().mockResolvedValue(books),
  } as unknown as Parameters<typeof SnapshotWriter>[1];
}

describe("SnapshotWriter", () => {
  it("timer fires at correct interval (mock setInterval)", async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const clob = makeClobClient([makeBook("tok1")]);
    const writer = new SnapshotWriter(db, clob, () => ["tok1"], 30000);

    writer.start();

    // No call yet
    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    // Advance timer
    await vi.advanceTimersByTimeAsync(30000);

    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    writer.stop();
    vi.useRealTimers();
  });

  it("batchGetBooks called with current watchlist token IDs", async () => {
    const db = makeDb();
    const clob = makeClobClient([makeBook("tok1"), makeBook("tok2")]);
    const writer = new SnapshotWriter(db, clob, () => ["tok1", "tok2"], 30000);

    await writer.snapshot();

    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(["tok1", "tok2"]);
  });

  it("computed aggregates: bidDepth = sum(price × size) for top-20 bids", async () => {
    const book = makeBook("tok1");
    // bidDepth = 0.65*100 + 0.64*200 + 0.63*300 = 65 + 128 + 189 = 382
    const expected = 0.65 * 100 + 0.64 * 200 + 0.63 * 300;

    const db = makeDb();
    const clob = makeClobClient([book]);
    const writer = new SnapshotWriter(db, clob, () => ["tok1"], 30000);

    await writer.snapshot();

    const execCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const queryStr = JSON.stringify(execCall);
    // The bidDepthUsdc value should be in the query
    expect(queryStr).toContain(expected.toString());
  });

  it("in-memory cache updated after each snapshot", async () => {
    const db = makeDb();
    const book = makeBook("tok1");
    const clob = makeClobClient([book]);
    const writer = new SnapshotWriter(db, clob, () => ["tok1"], 30000);

    expect(writer.getLatestBook("tok1")).toBeNull();

    await writer.snapshot();

    const cached = writer.getLatestBook("tok1");
    expect(cached).not.toBeNull();
    expect(cached?.book.tokenId).toBe("tok1");
  });

  it("getLatestBook returns null for unseen token ID", () => {
    const db = makeDb();
    const clob = makeClobClient([]);
    const writer = new SnapshotWriter(db, clob, () => [], 30000);

    expect(writer.getLatestBook("unknown-token")).toBeNull();
  });

  it("snapshot with empty watchlist: skips batchGetBooks", async () => {
    const db = makeDb();
    const clob = makeClobClient([]);
    const writer = new SnapshotWriter(db, clob, () => [], 30000);

    await writer.snapshot();

    expect(clob.batchGetBooks as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("computeDepth", () => {
  it("sums price × size for top-N levels", () => {
    const levels = [
      { price: 0.65, size: 100 },
      { price: 0.64, size: 200 },
      { price: 0.63, size: 300 },
    ];
    const depth = computeDepth(levels, 3);
    expect(depth).toBeCloseTo(0.65 * 100 + 0.64 * 200 + 0.63 * 300, 6);
  });

  it("respects topN limit", () => {
    const levels = Array.from({ length: 30 }, (_, i) => ({ price: 0.5, size: 100 }));
    const depth = computeDepth(levels, 10);
    expect(depth).toBeCloseTo(0.5 * 100 * 10, 6);
  });
});
