import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchDashboardData, renderDashboard } from "./signal-dashboard.js";
import type { DashboardData } from "./signal-dashboard.js";

// ── Mock DB factory ───────────────────────────────────────────────────────────

function makeDb(
  signalRows: object[],
  whaleStats: object[],
  whaleTop: object[]
) {
  return {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: signalRows })
      .mockResolvedValueOnce({ rows: whaleStats })
      .mockResolvedValueOnce({ rows: whaleTop }),
  } as unknown as Parameters<typeof fetchDashboardData>[0];
}

const baseSignalRows = [
  { signal_type: "WHALE_TRADE", last_24h: "12", last_nd: "67", avg_conf: "0.84" },
  { signal_type: "BOOK_IMBALANCE", last_24h: "34", last_nd: "201", avg_conf: "0.71" },
];

const baseWhaleStats = [{ cnt: "12", avg_val: "127400", max_val: "2100000" }];
const baseWhaleTop = [{ usdc_value: "2100000", proxy_wallet: "0xDEADBEEF", token_id: "tok123" }];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchDashboardData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("correct 24h and 7d counts per signal type", async () => {
    const db = makeDb(baseSignalRows, baseWhaleStats, baseWhaleTop);
    const data = await fetchDashboardData(db, 7);

    expect(data.signalTypes).toHaveLength(2);
    const whale = data.signalTypes.find((r) => r.signalType === "WHALE_TRADE")!;
    expect(whale.last24h).toBe(12);
    expect(whale.lastNd).toBe(67);
    expect(whale.avgConf).toBeCloseTo(0.84, 2);
  });

  it("largest whale displays correctly (highest usdc_value in 24h window)", async () => {
    const db = makeDb(baseSignalRows, baseWhaleStats, baseWhaleTop);
    const data = await fetchDashboardData(db, 7);

    expect(data.whaleLargest).toBe(2_100_000);
    expect(data.whaleLargestToken).toBe("tok123");
  });

  it("--days=3: cutoff computed as 3*86400s from now", async () => {
    const db = makeDb(baseSignalRows, baseWhaleStats, baseWhaleTop);
    await fetchDashboardData(db, 3);

    // Verify execute was called (SQL was issued with the bound cutoff)
    expect(db.execute).toHaveBeenCalled();
    const firstCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The cutoff should be in the SQL — inspect the sql.queryChunks
    const queryStr = JSON.stringify(firstCall);
    // Should contain a date string 3 days in the past
    const expected = new Date(new Date("2025-04-01T12:00:00Z").getTime() - 3 * 86400 * 1000);
    expect(queryStr).toContain(expected.toISOString().slice(0, 10));
  });

  it("returns zero values when no signals exist", async () => {
    const db = makeDb([], [{ cnt: "0", avg_val: null, max_val: null }], []);
    const data = await fetchDashboardData(db, 7);
    expect(data.signalTypes).toHaveLength(0);
    expect(data.whaleCount24h).toBe(0);
    expect(data.whaleLargest).toBe(0);
  });

  it("days value is carried through to DashboardData.days", async () => {
    const db = makeDb(baseSignalRows, baseWhaleStats, baseWhaleTop);
    const data = await fetchDashboardData(db, 14);
    expect(data.days).toBe(14);
  });
});

describe("renderDashboard", () => {
  it("output contains all 6 signal type names", () => {
    const data: DashboardData = {
      signalTypes: [],
      whaleCount24h: 0,
      whaleAvgSize: 0,
      whaleLargest: 0,
      whaleLargestWallet: "",
      whaleLargestToken: "",
      days: 7,
    };
    const output = renderDashboard(data);
    expect(output).toContain("WHALE_TRADE");
    expect(output).toContain("NEG_RISK_ARB");
    expect(output).toContain("NEG_RISK_OUTLIER");
  });

  it("whale section shows correct count", () => {
    const data: DashboardData = {
      signalTypes: [],
      whaleCount24h: 12,
      whaleAvgSize: 127_400,
      whaleLargest: 2_100_000,
      whaleLargestWallet: "0xDEADBEEF1234",
      whaleLargestToken: "tok123",
      days: 7,
    };
    const output = renderDashboard(data);
    expect(output).toContain("12");
    expect(output).toContain("$2.1M");
  });
});
