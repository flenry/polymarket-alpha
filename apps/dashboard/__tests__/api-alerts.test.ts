import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

// Mock the db module before importing route
vi.mock("../lib/db", () => ({
  pool: { query: mockQuery },
  db: {},
}));

// Mock next/server
vi.mock("next/server", () => ({
  NextRequest: class {
    nextUrl: { searchParams: URLSearchParams };
    constructor(url: string) {
      this.nextUrl = { searchParams: new URLSearchParams(new URL(url).search) };
    }
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

import { GET } from "../app/api/alerts/route";
import { ALERT_TRADE_JOIN_SQL } from "../lib/alert-hydration";

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/alerts");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: { searchParams: url.searchParams } } as Parameters<typeof GET>[0];
}

const FIXTURE_ALERT = {
  id: "1",
  trade_lookup_key: "0xabc|token1|0xwallet|2024-01-01T00:00:00Z|0.5|100",
  token_id: "token1",
  condition_id: "cond1",
  usdc_value: "50000",
  absolute_min_usdc: 10000,
  avg_trade_size_24h_at_alert: "5000",
  stddev_24h_at_alert: "1000",
  volume_24h_at_alert: "1000000",
  sigmas_above_mean: "4.5",
  pct_of_daily_volume: "0.05",
  price_at_alert: "0.50",
  price_impact_estimate_usdc: null,
  book_depth_consumed_pct: null,
  book_snapshot_age_ms: null,
  wallet_total_volume_usdc: null,
  wallet_trade_count: null,
  wallet_first_seen_at: null,
  wallet_win_ratio: null,
  enriched_at: null,
  alerted_at: "2024-01-01T12:00:00Z",
  side: "BUY",
  proxy_wallet: "0xwallet",
  question: "Will X happen?",
  slug: "will-x-happen",
};

describe("GET /api/alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns alerts with default params (limit=100, hours=24)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [FIXTURE_ALERT] }) // data
      .mockResolvedValueOnce({ rows: [{ total: "1" }] }); // count

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alerts: [FIXTURE_ALERT], total: 1 });
  });

  it("uses full-tuple join SQL (contains split_part field 3)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const req = makeRequest();
    await GET(req);

    // The data query should include the full-tuple join SQL
    const callArg = mockQuery.mock.calls[0][0] as string;
    expect(callArg).toContain("split_part(wa.trade_lookup_key, '|', 3)");
  });

  it("returns empty result with total=0 when no alerts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alerts: [], total: 0 });
  });

  it("returns 400 for invalid hours (0)", async () => {
    const req = makeRequest({ hours: "0" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid hours (>168)", async () => {
    const req = makeRequest({ hours: "999" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric hours", async () => {
    const req = makeRequest({ hours: "abc" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("clamps limit to max 500", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const req = makeRequest({ limit: "9999" });
    await GET(req);

    // Second positional param to data query should be 500 (clamped)
    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[1]).toBe(500);
  });

  it("passes hours filter to WHERE clause via query param", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const req = makeRequest({ hours: "6" });
    await GET(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[0]).toBe(6); // hours is first param
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
    expect((res.body as unknown as { error: string }).error).toBeTruthy();
  });

  it("ALERT_TRADE_JOIN_SQL is used in query (not partial join)", () => {
    // Structural test: confirm the SQL constant contains the expected join parts
    // This guarantees full-tuple join is in place
    const parts = [1, 2, 3, 4, 5, 6];
    for (const n of parts) {
      expect(ALERT_TRADE_JOIN_SQL).toContain(`split_part(wa.trade_lookup_key, '|', ${n})`);
    }
  });
});
