import { describe, it, expect, vi } from "vitest";
import { ClobRestClient } from "./clob-rest-client.js";

function makeBookResponse(tokenId: string) {
  return {
    asset_id: tokenId,
    market: "0xcond",
    timestamp: "1700000000000",
    hash: "abc123",
    bids: [
      { price: "0.65", size: "100" },
      { price: "0.64", size: "200" },
    ],
    asks: [
      { price: "0.66", size: "150" },
      { price: "0.67", size: "100" },
    ],
  };
}

function makeFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callCount = 0;
  return vi.fn().mockImplementation(async () => {
    const resp = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.body,
    };
  });
}

describe("ClobRestClient.batchGetBooks", () => {
  it("sends POST with correct token_ids array body", async () => {
    const fetchFn = makeFetch([
      { ok: true, status: 200, body: [makeBookResponse("tok1"), makeBookResponse("tok2")] },
    ]);

    const client = new ClobRestClient(fetchFn as unknown as typeof fetch);
    const books = await client.batchGetBooks(["tok1", "tok2"]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/books");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string) as Array<{ token_id: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].token_id).toBe("tok1");
    expect(body[1].token_id).toBe("tok2");

    expect(books).toHaveLength(2);
    expect(books[0].tokenId).toBe("tok1");
  });

  it("returns empty array when tokenIds is empty", async () => {
    const fetchFn = makeFetch([{ ok: true, status: 200, body: [] }]);
    const client = new ClobRestClient(fetchFn as unknown as typeof fetch);
    const books = await client.batchGetBooks([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(books).toHaveLength(0);
  });

  it("429 response: backs off, retries; returns empty on second 429 (graceful)", async () => {
    const fetchFn = makeFetch([
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
    ]);

    // Use 1ms backoff to keep test fast
    const client = new ClobRestClient(fetchFn as unknown as typeof fetch, 1);

    // Second 429 → logs error and returns empty (graceful degradation, no crash)
    const result = await client.batchGetBooks(["tok1"]);
    expect(result).toEqual([]);
    // fetch called twice: first attempt + one retry
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("response parsed with Zod; unknown fields stripped", async () => {
    const bookWithExtra = {
      ...makeBookResponse("tok1"),
      unknownField: "extra data",
      anotherExtra: 999,
    };

    const fetchFn = makeFetch([{ ok: true, status: 200, body: [bookWithExtra] }]);
    const client = new ClobRestClient(fetchFn as unknown as typeof fetch);
    const books = await client.batchGetBooks(["tok1"]);

    expect(books).toHaveLength(1);
    expect((books[0] as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it("bids sorted descending, asks sorted ascending", async () => {
    const fetchFn = makeFetch([
      { ok: true, status: 200, body: [makeBookResponse("tok1")] },
    ]);

    const client = new ClobRestClient(fetchFn as unknown as typeof fetch);
    const books = await client.batchGetBooks(["tok1"]);

    const book = books[0];
    expect(book.bids[0].price).toBeGreaterThan(book.bids[1].price); // desc
    expect(book.asks[0].price).toBeLessThan(book.asks[1].price); // asc
  });
});
