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

import { GET } from "../app/api/markets/route";

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/markets");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: { searchParams: url.searchParams } } as Parameters<typeof GET>[0];
}

const TOP_20_ROWS = [
  {
    token_id: "token1",
    signal_count: 10,
    whale_count: 3,
    question: "Will X happen?",
    slug: "will-x-happen",
    volume_24h: "1000000",
  },
  {
    token_id: "token2",
    signal_count: 5,
    whale_count: 1,
    question: "Will Y happen?",
    slug: null,
    volume_24h: null,
  },
];

describe("GET /api/markets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty markets when no signals", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // top20 query

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markets: [] });
  });

  it("returns market rows with top signal type", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: TOP_20_ROWS }) // top20
      .mockResolvedValueOnce({
        rows: [
          { token_id: "token1", top_signal_type: "WHALE_TRADE" },
          { token_id: "token2", top_signal_type: "ORDER_BOOK_IMBALANCE" },
        ],
      }); // topType

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);

    const { markets } = res.body as unknown as {
      markets: { token_id: string; top_signal_type: string | null }[];
    };
    expect(markets).toHaveLength(2);
    expect(markets[0].top_signal_type).toBe("WHALE_TRADE");
    expect(markets[1].top_signal_type).toBe("ORDER_BOOK_IMBALANCE");
  });

  it("handles market with no matching top_signal_type (null)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TOP_20_ROWS[0]!] }) // only token1
      .mockResolvedValueOnce({ rows: [] }); // no type result

    const req = makeRequest();
    const res = await GET(req);
    const { markets } = res.body as unknown as {
      markets: { token_id: string; top_signal_type: string | null }[];
    };
    expect(markets[0].top_signal_type).toBeNull();
  });

  it("applies hours filter to query params", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ hours: "6" });
    await GET(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[0]).toBe(6);
  });

  it("clamps hours to max 168", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({ hours: "9999" });
    await GET(req);

    const callParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(callParams[0]).toBe(168);
  });

  it("returns 400 for hours < 1", async () => {
    const req = makeRequest({ hours: "0" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric hours", async () => {
    const req = makeRequest({ hours: "abc" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("tie-breaking: same count, lower lexical signal_type wins", async () => {
    // Two signal types with equal count for same token
    // Lexical order: ORDER_BOOK_IMBALANCE < WHALE_TRADE
    // The deterministic rule (COUNT DESC → MAX(confidence) DESC → signal_type ASC)
    // means ORDER_BOOK_IMBALANCE (lexically first) wins when count and confidence are tied
    //
    // In this test, we simulate what the DB returns based on the ORDER BY
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ token_id: "tokenTie", signal_count: 3, whale_count: 0, question: null, slug: null, volume_24h: null }],
      })
      .mockResolvedValueOnce({
        rows: [{ token_id: "tokenTie", top_signal_type: "ORDER_BOOK_IMBALANCE" }],
      }); // DB returns ORDER_BOOK_IMBALANCE (lexically first) for tied count

    const req = makeRequest();
    const res = await GET(req);
    const { markets } = res.body as unknown as { markets: { top_signal_type: string | null }[] };
    // The API correctly returns whatever the DB returns from deterministic ORDER BY
    expect(markets[0].top_signal_type).toBe("ORDER_BOOK_IMBALANCE");
  });

  it("uses DISTINCT ON for top signal type query", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: TOP_20_ROWS })
      .mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await GET(req);

    // Second call is the topType query
    const callQuery = mockQuery.mock.calls[1]![0] as string;
    expect(callQuery).toContain("DISTINCT ON");
  });

  it("orders topType query by COUNT DESC then signal_type ASC for determinism", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: TOP_20_ROWS })
      .mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await GET(req);

    const callQuery = mockQuery.mock.calls[1]![0] as string;
    expect(callQuery).toContain("COUNT(*) DESC");
    expect(callQuery).toContain("signal_type ASC");
  });

  it("returns empty markets on DB error (graceful degradation)", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect((res.body as unknown as { markets: unknown[] }).markets).toEqual([]);
  });
});
