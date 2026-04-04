import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  pool: { query: mockQuery },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

import { GET } from "../app/api/health/route";
import type { HealthResponse } from "../app/api/health/route";

const NOW = new Date("2024-01-01T12:00:00Z");

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct shape with all 6 DB queries fired", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })                          // lastTrade
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })                          // lastSnapshot
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })                          // lastMarketRefresh
      .mockResolvedValueOnce({ rows: [{ cnt: 34 }] })                          // trades5Min
      .mockResolvedValueOnce({ rows: [{ cnt: 312 }] })                         // marketsTracked
      .mockResolvedValueOnce({ rows: [{ cnt: 48 }] });                         // negRisk

    const res = await GET();
    expect(res.status).toBe(200);

    // All 6 queries should have been called
    expect(mockQuery).toHaveBeenCalledTimes(6);

    const body = res.body as unknown as HealthResponse;
    expect(body.lastTradeAt).toBe(NOW.toISOString());
    expect(body.lastSnapshotAt).toBe(NOW.toISOString());
    expect(body.lastMarketRefreshAt).toBe(NOW.toISOString());
    expect(body.tradesLast5Min).toBe(34);
    expect(body.marketsTracked).toBe(312);
    expect(body.negRiskMarketsTracked).toBe(48);
    expect(body.shardsConnected).toBeNull();
  });

  it("shardsConnected is always null", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })
      .mockResolvedValueOnce({ rows: [{ ts: NOW }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const res = await GET();
    expect((res.body as unknown as HealthResponse).shardsConnected).toBeNull();
  });

  it("handles null MAX timestamps (no data in tables)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ts: null }] })   // lastTrade = null
      .mockResolvedValueOnce({ rows: [{ ts: null }] })   // lastSnapshot = null
      .mockResolvedValueOnce({ rows: [{ ts: null }] })   // lastMarketRefresh = null
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const res = await GET();
    const body = res.body as unknown as HealthResponse;
    expect(body.lastTradeAt).toBeNull();
    expect(body.lastSnapshotAt).toBeNull();
    expect(body.lastMarketRefreshAt).toBeNull();
    // tradesLast5Min should be 0 when no trade data
    expect(body.tradesLast5Min).toBe(0);
  });

  it("returns null-filled HealthResponse on DB error (graceful degradation)", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = res.body as unknown as Record<string, unknown>;
    expect(body.lastTradeAt).toBeNull();
    expect(body.lastSnapshotAt).toBeNull();
    expect(body.lastMarketRefreshAt).toBeNull();
    expect(body.tradesLast5Min).toBe(0);
    expect(body.marketsTracked).toBe(0);
  });

  it("queries MAX(traded_at) from trades", async () => {
    mockQuery
      .mockResolvedValue({ rows: [{ ts: null, cnt: 0 }] });

    await GET();

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queries.some((q) => q.includes("MAX(traded_at)") && q.includes("trades"))).toBe(true);
  });

  it("queries MAX(captured_at) from order_book_snapshots", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ts: null, cnt: 0 }] });

    await GET();

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queries.some((q) => q.includes("MAX(captured_at)") && q.includes("order_book_snapshots"))).toBe(true);
  });

  it("queries MAX(refreshed_at) from market_stats", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ts: null, cnt: 0 }] });

    await GET();

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queries.some((q) => q.includes("MAX(refreshed_at)") && q.includes("market_stats"))).toBe(true);
  });

  it("queries neg_risk markets", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ts: null, cnt: 0 }] });

    await GET();

    const queries = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(queries.some((q) => q.includes("neg_risk"))).toBe(true);
  });
});
