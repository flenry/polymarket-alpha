import { ZClobBookEvent } from "../validation/schemas.js";
import type { OrderBook, PriceLevel, TokenId } from "../events/types.js";
import { logger } from "../logger.js";

const CLOB_BASE = "https://clob.polymarket.com";
const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_REQUESTS_PER_SECOND = 8;

export interface PricePoint {
  t: number;
  p: number;
}

export interface SamplingMarket {
  conditionId: string;
  tokenId: string;
  neg_risk?: boolean;
}

export class ClobRestClient {
  private lastRequestTime = 0;
  private requestsThisSecond = 0;
  private secondWindow = 0;
  private readonly fetchFn: typeof fetch;
  private readonly rateLimitBackoffMs: number;

  constructor(fetchFn?: typeof fetch, rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as typeof fetch);
    this.rateLimitBackoffMs = rateLimitBackoffMs;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const currentSecond = Math.floor(now / 1000);

    if (currentSecond !== this.secondWindow) {
      this.secondWindow = currentSecond;
      this.requestsThisSecond = 0;
    }

    if (this.requestsThisSecond >= MAX_REQUESTS_PER_SECOND) {
      // Wait until next second
      const msUntilNextSecond = 1000 - (now % 1000);
      await new Promise((r) => setTimeout(r, msUntilNextSecond));
      this.requestsThisSecond = 0;
      this.secondWindow = Math.floor(Date.now() / 1000);
    }

    this.requestsThisSecond++;
  }

  private async fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
    await this.throttle();
    const resp = await this.fetchFn(url, options);

    if (resp.status === 429) {
      logger.warn({ url }, "ClobRestClient: 429, backing off 30s");
      await new Promise((r) => setTimeout(r, this.rateLimitBackoffMs));

      // Retry once
      await this.throttle();
      const retry = await this.fetchFn(url, options);
      if (retry.status === 429) {
        logger.error({ url }, "ClobRestClient: 429 on retry, giving up");
        throw new Error("ClobRestClient: rate limited after retry");
      }
      return retry;
    }

    return resp;
  }

  /**
   * Batch fetch order books for multiple token IDs via POST /books.
   */
  async batchGetBooks(tokenIds: TokenId[]): Promise<OrderBook[]> {
    if (tokenIds.length === 0) return [];

    const body = tokenIds.map((id) => ({ token_id: id }));

    let resp: Response;
    try {
      resp = await this.fetchWithRetry(`${CLOB_BASE}/books`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.error({ err }, "ClobRestClient: batchGetBooks failed");
      return [];
    }

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "ClobRestClient: batchGetBooks non-OK");
      return [];
    }

    let raw: unknown[];
    try {
      raw = (await resp.json()) as unknown[];
    } catch {
      return [];
    }

    const books: OrderBook[] = [];
    const now = new Date();

    for (const item of raw) {
      const parsed = ZClobBookEvent.safeParse(item);
      if (!parsed.success) {
        logger.debug({ errors: parsed.error.errors }, "ClobRestClient: skipping invalid book");
        continue;
      }

      const d = parsed.data;
      const capturedAt = now;

      const bids: PriceLevel[] = d.bids
        .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price); // desc

      const asks: PriceLevel[] = d.asks
        .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price); // asc

      books.push({
        tokenId: d.asset_id,
        conditionId: d.market ?? "",
        bids,
        asks,
        timestamp: parseInt(d.timestamp, 10),
        hash: d.hash,
        capturedAt,
      });
    }

    return books;
  }

  /**
   * Get active sampling markets.
   */
  async getSamplingMarkets(): Promise<SamplingMarket[]> {
    let resp: Response;
    try {
      resp = await this.fetchWithRetry(`${CLOB_BASE}/sampling-markets`);
    } catch {
      return [];
    }
    if (!resp.ok) return [];
    const data = (await resp.json()) as { markets?: SamplingMarket[] } | SamplingMarket[];
    if (Array.isArray(data)) return data;
    return data.markets ?? [];
  }

  /**
   * Fetch price history for a token.
   */
  async getPricesHistory(
    tokenId: TokenId,
    startTs: number,
    endTs: number,
    fidelity = 1
  ): Promise<PricePoint[]> {
    const url = `${CLOB_BASE}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
    let resp: Response;
    try {
      resp = await this.fetchWithRetry(url);
    } catch {
      return [];
    }
    if (!resp.ok) return [];
    const data = (await resp.json()) as { history?: PricePoint[] };
    return data.history ?? [];
  }
}
