import { describe, it, expect, vi } from "vitest";
import { insertBookSnapshot, getLatestBook } from "./snapshots.js";

function makeDb(rows: object[] = []) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return { select, execute } as unknown as Parameters<typeof insertBookSnapshot>[0];
}

describe("insertBookSnapshot", () => {
  it("calls db.execute with the snapshot data", async () => {
    const db = makeDb();
    await insertBookSnapshot(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [{ price: "0.65", size: "100" }],
      asks: [{ price: "0.66", size: "50" }],
      bidDepthUsdc: 65,
      askDepthUsdc: 33,
      imbalanceRatio: 1.97,
      mid: 0.655,
      spread: 0.01,
      bookHash: "abc123",
      snapshotTrigger: "rest_timer",
      capturedAt: new Date("2026-04-03T12:00:00Z"),
    });

    expect(db.execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(call);
    expect(qs).toContain("rest_timer");
    expect(qs).toContain("tok1");
  });

  it("defaults snapshotTrigger to rest_timer when not provided", async () => {
    const db = makeDb();
    await insertBookSnapshot(db, {
      tokenId: "tok2",
      conditionId: "cond2",
      bids: [],
      asks: [],
      capturedAt: new Date(),
    });

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(call)).toContain("rest_timer");
  });
});

describe("getLatestBook", () => {
  it("returns null when no rows found", async () => {
    const db = makeDb([]);
    const result = await getLatestBook(db, "tok1");
    expect(result).toBeNull();
  });

  it("returns mapped snapshot when row found", async () => {
    const row = {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [{ price: "0.65", size: "100" }],
      asks: [{ price: "0.66", size: "50" }],
      bidDepthUsdc: "65.00",
      askDepthUsdc: "33.00",
      imbalanceRatio: "1.9700",
      mid: "0.655000",
      spread: "0.010000",
      bookHash: "abc",
      snapshotTrigger: "rest_timer",
      capturedAt: new Date("2026-04-03T12:00:00Z"),
    };
    const db = makeDb([row]);
    const result = await getLatestBook(db, "tok1");
    expect(result).not.toBeNull();
    expect(result!.tokenId).toBe("tok1");
    expect(result!.bidDepthUsdc).toBe(65);
    expect(result!.snapshotTrigger).toBe("rest_timer");
  });

  it("handles null optional fields gracefully", async () => {
    const row = {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [],
      asks: [],
      bidDepthUsdc: null,
      askDepthUsdc: null,
      imbalanceRatio: null,
      mid: null,
      spread: null,
      bookHash: null,
      snapshotTrigger: null,
      capturedAt: new Date(),
    };
    const db = makeDb([row]);
    const result = await getLatestBook(db, "tok1");
    expect(result).not.toBeNull();
    expect(result!.bidDepthUsdc).toBeNull();
    expect(result!.bookHash).toBeNull();
  });
});
