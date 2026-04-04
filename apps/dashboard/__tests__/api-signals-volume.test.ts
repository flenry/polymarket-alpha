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

import { GET } from "../app/api/signals/volume/route";

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/signals/volume");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: { searchParams: url.searchParams } } as Parameters<typeof GET>[0];
}

describe("GET /api/signals/volume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty buckets when no signals in window", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buckets: [] });
  });

  it("returns correctly shaped buckets", async () => {
    const dbRows = [
      { hour: new Date("2024-01-01T10:00:00Z"), type: "WHALE_TRADE", count: 3 },
      { hour: new Date("2024-01-01T11:00:00Z"), type: "ORDER_BOOK_IMBALANCE", count: 5 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: dbRows });

    const req = makeRequest({ hours: "24" });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const { buckets } = res.body as unknown as { buckets: { hour: string; type: string; count: number }[] };
    expect(buckets).toHaveLength(2);
    expect(buckets[0].type).toBe("WHALE_TRADE");
    expect(buckets[0].count).toBe(3);
    expect(typeof buckets[0].hour).toBe("string"); // ISO string
  });

  it("passes hours param through to query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

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

  it("uses date_trunc('hour') in query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await GET(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery).toContain("date_trunc('hour'");
  });

  it("groups by signal_type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest();
    await GET(req);

    const callQuery = mockQuery.mock.calls[0][0] as string;
    expect(callQuery.toLowerCase()).toContain("group by");
    expect(callQuery).toContain("signal_type");
  });

  it("returns 400 for invalid hours (<1)", async () => {
    const req = makeRequest({ hours: "0" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("converts Date objects from pg to ISO strings", async () => {
    const rows = [
      { hour: new Date("2024-01-01T10:00:00Z"), type: "WHALE_TRADE", count: 2 },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const req = makeRequest();
    const res = await GET(req);
    const { buckets } = res.body as unknown as { buckets: { hour: string }[] };
    expect(buckets[0].hour).toBe("2024-01-01T10:00:00.000Z");
  });
});
