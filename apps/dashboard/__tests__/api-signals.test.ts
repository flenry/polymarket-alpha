import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  pool: { query: mockQuery },
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

import { GET } from "../app/api/signals/route";

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/signals");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: { searchParams: url.searchParams } } as Parameters<typeof GET>[0];
}

const FIXTURE_SIGNAL = {
  id: "1",
  token_id: "token1",
  condition_id: "cond1",
  signal_type: "WHALE_TRADE",
  direction: "BULLISH",
  confidence: "0.85",
  strength: "12345.00",
  price_at_signal: "0.55",
  spread_at_signal: null,
  volume_at_signal: null,
  whale_alert_id: "5",
  order_book_snapshot_id: null,
  payload: { compositeScore: 0.75 },
  created_at: "2024-01-01T12:00:00Z",
  question: "Will X happen?",
  slug: null,
};

describe("GET /api/signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns signals with default params", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FIXTURE_SIGNAL] });

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signals: [FIXTURE_SIGNAL] });
  });

  it("returns 400 for unknown signal type", async () => {
    const req = makeRequest({ types: "INVALID_TYPE" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for partially invalid types", async () => {
    const req = makeRequest({ types: "WHALE_TRADE,BOGUS_TYPE" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("accepts valid signal types filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ types: "WHALE_TRADE,ORDER_BOOK_IMBALANCE" });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("clamps minConfidence to 0 if negative", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ minConfidence: "-0.5" });
    await GET(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[1]).toBe(0); // clamped to 0
  });

  it("clamps minConfidence to 1 if >1", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ minConfidence: "2.0" });
    await GET(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[1]).toBe(1); // clamped to 1
  });

  it("filters by tokenId when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ tokenId: "token123" });
    await GET(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("s.token_id =");
  });

  it("returns 400 for invalid hours (>168)", async () => {
    const req = makeRequest({ hours: "999" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("enforces LIMIT 200 in query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await GET(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("LIMIT 200");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
  });

  it("accepts NEG_RISK_ARB and NEG_RISK_OUTLIER types", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ types: "NEG_RISK_ARB,NEG_RISK_OUTLIER" });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});
