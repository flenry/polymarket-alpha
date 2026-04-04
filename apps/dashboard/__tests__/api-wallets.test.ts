import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  pool: { query: mockQuery },
  db: {},
}));

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

import { GET as getWallets } from "../app/api/wallets/route";
import { GET as getWalletAlerts } from "../app/api/wallets/[address]/alerts/route";

function makeRequest(
  params: Record<string, string> = {},
  base = "http://localhost/api/wallets"
) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: { searchParams: url.searchParams } } as Parameters<typeof getWallets>[0];
}

const FIXTURE_WALLET = {
  proxy_wallet: "0x1234567890abcdef1234567890abcdef12345678",
  total_volume_usdc: "250000",
  trade_count: 50,
  whale_trade_count: 5,
  first_seen_at: "2023-01-01T00:00:00Z",
  last_seen_at: "2024-01-01T00:00:00Z",
  resolved_trade_count: 10,
  win_count: 8,
  win_ratio: "0.800",
  display_name: null,
  pseudonym: "DegenKing",
  last_enriched_at: "2024-01-01T00:00:00Z",
  enrichment_version: 1,
};

describe("GET /api/wallets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns wallets ordered by win_ratio DESC", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FIXTURE_WALLET] });

    const req = makeRequest();
    const res = await getWallets(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wallets: [FIXTURE_WALLET] });
  });

  it("LAW-MAJOR-2: SQL uses resolved_trade_count (not trade_count)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ minTrades: "3" });
    await getWallets(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("resolved_trade_count");
    // Ensure it does NOT filter on trade_count in WHERE
    // trade_count may appear in SELECT * but not as a filter
    const whereSection = callQuery.split("WHERE")[1] ?? "";
    // resolved_trade_count is allowed; bare trade_count (without resolved_ prefix) is not
    expect(whereSection).not.toMatch(/(?<!resolved_)trade_count >=/);
    expect(whereSection).toContain("resolved_trade_count >=");
  });

  it("applies minTrades param to resolved_trade_count filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ minTrades: "5" });
    await getWallets(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[0]).toBe(5);
  });

  it("applies minVolume param", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ minVolume: "10000" });
    await getWallets(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[1]).toBe(10000);
  });

  it("uses ORDER BY win_ratio DESC NULLS LAST", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await getWallets(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("win_ratio DESC NULLS LAST");
  });

  it("returns empty wallets for no results", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    const res = await getWallets(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wallets: [] });
  });

  it("clamps limit to max 200", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ limit: "9999" });
    await getWallets(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[2]).toBe(200);
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const req = makeRequest();
    const res = await getWallets(req);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/wallets/[address]/alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns alerts for a valid address", async () => {
    const FIXTURE_ALERT = {
      id: "1",
      usdc_value: "50000",
      alerted_at: "2024-01-01T12:00:00Z",
      side: "BUY",
      proxy_wallet: "0x1234",
      question: "Will X happen?",
      slug: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [FIXTURE_ALERT] });

    const req = makeRequest(
      {},
      "http://localhost/api/wallets/0x1234/alerts"
    ) as Parameters<typeof getWalletAlerts>[0];
    const params = { params: { address: "0x1234" } };

    const res = await getWalletAlerts(req, params as { params: { address: string } });
    expect(res.status).toBe(200);
    expect((res.body as { alerts: unknown[] }).alerts).toHaveLength(1);
  });

  it("returns empty alerts for unknown address", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest(
      {},
      "http://localhost/api/wallets/0xunknown/alerts"
    ) as Parameters<typeof getWalletAlerts>[0];
    const params = { params: { address: "0xunknown" } };

    const res = await getWalletAlerts(req, params as { params: { address: string } });
    expect(res.status).toBe(200);
    expect((res.body as { alerts: unknown[] }).alerts).toHaveLength(0);
  });

  it("uses ALERT_TRADE_JOIN_SQL (full-tuple join)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest(
      {},
      "http://localhost/api/wallets/0x1234/alerts"
    ) as Parameters<typeof getWalletAlerts>[0];
    const params = { params: { address: "0x1234" } };

    await getWalletAlerts(req, params as { params: { address: string } });

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("split_part(wa.trade_lookup_key, '|', 3)");
  });

  it("limits results to 20", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest(
      {},
      "http://localhost/api/wallets/0x1234/alerts"
    ) as Parameters<typeof getWalletAlerts>[0];
    const params = { params: { address: "0x1234" } };

    await getWalletAlerts(req, params as { params: { address: string } });

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("LIMIT 20");
  });
});
