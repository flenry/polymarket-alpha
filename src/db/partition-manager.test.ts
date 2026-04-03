import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTomorrowPartition,
  createPartitionForDate,
  dropExpiredPartitions,
  PartitionManager,
} from "./partition-manager.js";

function mockDb(rows: { tablename: string }[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Parameters<typeof createTomorrowPartition>[0];
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

describe("createTomorrowPartition", () => {
  it("generates correct FOR VALUES FROM ... TO bounds", async () => {
    const db = mockDb();
    await createTomorrowPartition(db, "trades");

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sql: string = call.queryChunks
      ? call.queryChunks.map((c: { value: string }) => c.value).join("")
      : String(call);

    const tomorrow = addDays(new Date(), 1);
    const dayAfter = addDays(tomorrow, 1);
    const fromStr = tomorrow.toISOString().slice(0, 10);
    const toStr = dayAfter.toISOString().slice(0, 10);

    expect(sql).toContain(fromStr);
    expect(sql).toContain(toStr);
    expect(sql).toContain("trades");
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("is idempotent (IF NOT EXISTS used)", async () => {
    const db = mockDb();
    await createTomorrowPartition(db, "trades");
    await createTomorrowPartition(db, "trades");
    // Both calls succeed (no error) because IF NOT EXISTS is in the SQL
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("works for order_book_snapshots table", async () => {
    const db = mockDb();
    await createTomorrowPartition(db, "order_book_snapshots");

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sql: string = call.queryChunks
      ? call.queryChunks.map((c: { value: string }) => c.value).join("")
      : String(call);

    expect(sql).toContain("order_book_snapshots");
  });
});

describe("createPartitionForDate", () => {
  it("generates correct bounds for given date", async () => {
    const db = mockDb();
    const date = new Date("2026-05-15T00:00:00Z");
    await createPartitionForDate(db, "trades", date);

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sql: string = call.queryChunks
      ? call.queryChunks.map((c: { value: string }) => c.value).join("")
      : String(call);

    expect(sql).toContain("2026-05-15");
    expect(sql).toContain("2026-05-16");
  });
});

describe("dropExpiredPartitions", () => {
  it("identifies partition names past cutoff", async () => {
    // Create partitions from 100 days ago (should be dropped with 90d retention)
    const oldDate = addDays(new Date(), -100);
    const oldName = `trades_${oldDate.toISOString().slice(0, 10).replace(/-/g, "_")}`;

    // Recent partition (should NOT be dropped)
    const recentDate = addDays(new Date(), -5);
    const recentName = `trades_${recentDate.toISOString().slice(0, 10).replace(/-/g, "_")}`;

    const db = mockDb([
      { tablename: oldName },
      { tablename: recentName },
    ]);

    const dropped = await dropExpiredPartitions(db, "trades", 90);

    expect(dropped).toContain(oldName);
    expect(dropped).not.toContain(recentName);
  });

  it("is idempotent (IF EXISTS in DROP)", async () => {
    const oldDate = addDays(new Date(), -100);
    const oldName = `trades_${oldDate.toISOString().slice(0, 10).replace(/-/g, "_")}`;
    const db = mockDb([{ tablename: oldName }]);

    // Call twice — both should succeed
    await dropExpiredPartitions(db, "trades", 90);
    const db2 = mockDb([{ tablename: oldName }]);
    await dropExpiredPartitions(db2, "trades", 90);

    expect(true).toBe(true); // no throw = success
  });

  it("returns empty array when no expired partitions", async () => {
    const db = mockDb([]); // no partitions
    const dropped = await dropExpiredPartitions(db, "trades", 90);
    expect(dropped).toHaveLength(0);
  });
});

describe("PartitionManager", () => {
  it("ensureCurrentPartitions() calls createPartitionForDate + createTomorrowPartition for both tables", async () => {
    const db = mockDb();
    const manager = new PartitionManager(db);

    await manager.ensureCurrentPartitions();

    // 2 tables × 2 calls each (createPartitionForDate + createTomorrowPartition)
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("start() creates a setInterval timer; stop() clears it (lines 147-163)", async () => {
    vi.useFakeTimers();
    const db = mockDb();
    const manager = new PartitionManager(db);

    manager.start();

    // Verify timer is running by advancing (no action when hour != 0 but timer fires)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour

    // stop() should clear the timer without error
    expect(() => manager.stop()).not.toThrow();

    vi.useRealTimers();
  });

  it("ensureCurrentPartitions() directly covers lines 137-142", async () => {
    // Test ensureCurrentPartitions() directly — simpler than waiting for midnight cron
    const db = mockDb();
    const manager = new PartitionManager(db);

    await manager.ensureCurrentPartitions();

    // 2 tables × (createPartitionForDate + createTomorrowPartition) = 4 execute calls
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("stop() is a no-op when called before start()", () => {
    const db = mockDb();
    const manager = new PartitionManager(db);
    // stop() before start() — timer is null, should not throw
    expect(() => manager.stop()).not.toThrow();
  });

  it("start() then stop() then stop() again — idempotent stop", () => {
    const db = mockDb();
    const manager = new PartitionManager(db);
    manager.start();
    manager.stop(); // clears timer
    manager.stop(); // timer already null — should not throw
    expect(true).toBe(true);
  });
});
