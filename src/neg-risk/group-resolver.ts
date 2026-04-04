import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { ClobRestClient } from "../sources/clob-rest-client.js";
import { getNegRiskMarketsByCondition } from "../db/queries/markets.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

/** Minimum token notional size on the ask/bid ladder to count as tradeable */
const MIN_NEG_RISK_SIZE = 10.0;

export interface NegRiskToken {
  tokenId: string;
  conditionId: string;
  bestBid: number;
  bestAsk: number;
  question: string;
}

export interface NegRiskGroup {
  conditionId: string;
  tokens: NegRiskToken[];
  sumBid: number;
  sumAsk: number;
  isValid: boolean;
}

export class GroupResolver {
  constructor(
    private readonly db: Db,
    private readonly clobClient: ClobRestClient
  ) {}

  async resolveGroups(): Promise<NegRiskGroup[]> {
    // 1. Fetch all open neg-risk markets from DB
    let marketRows;
    try {
      marketRows = await getNegRiskMarketsByCondition(this.db);
    } catch (err) {
      logger.error({ err }, "GroupResolver: failed to fetch neg-risk markets");
      return [];
    }

    if (marketRows.length === 0) return [];

    // 2. Group by conditionId
    const byCondition = new Map<string, typeof marketRows>();
    for (const row of marketRows) {
      const existing = byCondition.get(row.conditionId) ?? [];
      existing.push(row);
      byCondition.set(row.conditionId, existing);
    }

    const groups: NegRiskGroup[] = [];

    for (const [conditionId, rows] of byCondition) {
      const tokenIds = rows.map((r) => r.tokenId);

      // 3. Fetch order books
      let books;
      try {
        books = await this.clobClient.batchGetBooks(tokenIds);
      } catch (err) {
        logger.error({ err, conditionId }, "GroupResolver: failed to fetch books");
        continue;
      }

      // Build book lookup map
      const bookMap = new Map(books.map((b) => [b.tokenId, b]));

      // 4. Map rows to NegRiskToken with size-aware top-of-book
      const tokens: NegRiskToken[] = rows.map((row) => {
        const book = bookMap.get(row.tokenId);

        // Ask: walk ladder for first level with size >= MIN_NEG_RISK_SIZE
        let bestAsk = 1.0;
        if (book && book.asks.length > 0) {
          const tradeable = book.asks.find((a) => a.size >= MIN_NEG_RISK_SIZE);
          bestAsk = tradeable?.price ?? 1.0;
        }

        // Bid: top of book only if size >= MIN_NEG_RISK_SIZE
        let bestBid = 0;
        if (book && book.bids.length > 0 && book.bids[0].size >= MIN_NEG_RISK_SIZE) {
          bestBid = book.bids[0].price;
        }

        return {
          tokenId: row.tokenId,
          conditionId: row.conditionId,
          bestBid,
          bestAsk,
          question: row.question,
        };
      });

      // 5. Sum and validate
      const sumBid = tokens.reduce((s, t) => s + t.bestBid, 0);
      const sumAsk = tokens.reduce((s, t) => s + t.bestAsk, 0);

      const isValid =
        tokens.length >= 2 &&
        sumBid <= 1.05 &&
        sumAsk >= 0.95 &&
        sumAsk <= 1.20;

      groups.push({ conditionId, tokens, sumBid, sumAsk, isValid });
    }

    return groups;
  }
}
