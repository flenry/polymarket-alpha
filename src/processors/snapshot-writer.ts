import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { OrderBook, TokenId } from "../events/types.js";
import type { ClobRestClient } from "../sources/clob-rest-client.js";
import { insertBookSnapshot } from "../db/queries/snapshots.js";
import { logger } from "../logger.js";
import crypto from "node:crypto";

type Db = NodePgDatabase<typeof schema>;

export interface BookCacheEntry {
  book: OrderBook;
  capturedAt: Date;
}

/** Compute the sum of (price × size) for the top N levels */
export function computeDepth(levels: Array<{ price: number; size: number }>, topN = 20): number {
  return levels
    .slice(0, topN)
    .reduce((sum, l) => sum + l.price * l.size, 0);
}

/** Compute a short hash of the top-10 bid/ask prices for change detection */
function computeBookHash(book: OrderBook): string {
  const str = JSON.stringify({
    bids: book.bids.slice(0, 10).map((b) => [b.price, b.size]),
    asks: book.asks.slice(0, 10).map((a) => [a.price, a.size]),
  });
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 40);
}

export class SnapshotWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly bookCache = new Map<TokenId, BookCacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly clobClient: ClobRestClient,
    private readonly getWatchlist: () => TokenId[],
    private readonly intervalMs: number
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.snapshot().catch((err) =>
        logger.error({ err }, "SnapshotWriter: snapshot error")
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async snapshot(): Promise<void> {
    const watchlist = this.getWatchlist();
    if (watchlist.length === 0) return;

    const books = await this.clobClient.batchGetBooks(watchlist);

    for (const book of books) {
      const now = new Date();
      const bidDepthUsdc = computeDepth(book.bids, 20);
      const askDepthUsdc = computeDepth(book.asks, 20);
      const imbalanceRatio = askDepthUsdc > 0 ? bidDepthUsdc / askDepthUsdc : null;

      const mid =
        book.bids.length > 0 && book.asks.length > 0
          ? (book.bids[0].price + book.asks[0].price) / 2
          : null;

      const spread =
        book.bids.length > 0 && book.asks.length > 0
          ? book.asks[0].price - book.bids[0].price
          : null;

      const bookHash = computeBookHash(book);

      const entry: BookCacheEntry = { book, capturedAt: now };
      this.bookCache.set(book.tokenId, entry);

      await insertBookSnapshot(this.db, {
        tokenId: book.tokenId,
        conditionId: book.conditionId,
        bids: book.bids.slice(0, 20).map((b) => ({ price: String(b.price), size: String(b.size) })),
        asks: book.asks.slice(0, 20).map((a) => ({ price: String(a.price), size: String(a.size) })),
        bidDepthUsdc,
        askDepthUsdc,
        imbalanceRatio,
        mid,
        spread,
        bookHash,
        snapshotTrigger: "rest_timer",
        capturedAt: now,
      });
    }
  }

  /** Get latest cached book for a token (for WhaleDetector) */
  getLatestBook(tokenId: TokenId): BookCacheEntry | null {
    return this.bookCache.get(tokenId) ?? null;
  }
}
