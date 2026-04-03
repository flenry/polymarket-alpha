import { EventEmitter } from "node:events";
import { ZGammaMarket } from "../validation/schemas.js";
import type { TokenId } from "../events/types.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { upsertMarket, upsertMarketStats, getWatchlistedTokenIds } from "../db/queries/markets.js";
import { bootstrapMarketStats } from "./stats-bootstrap.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

export interface GammaPollerOptions {
  db: Db;
  pollIntervalMs: number;
  watchlistSize: number;
  fetchFn?: (url: string) => Promise<Response>;
}

export class GammaPoller extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly watchlistSet = new Set<TokenId>();
  private readonly negRiskSet = new Set<TokenId>();
  private readonly options: GammaPollerOptions;

  constructor(options: GammaPollerOptions) {
    super();
    this.options = options;
  }

  getWatchlist(): TokenId[] {
    return [...this.watchlistSet];
  }

  getNegRiskIds(): TokenId[] {
    return [...this.negRiskSet];
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, "GammaPoller: poll error"));
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const { db, watchlistSize, fetchFn } = this.options;
    const fetch_ = fetchFn ?? fetch;

    let markets: unknown[];
    try {
      const url = `${GAMMA_API_BASE}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${watchlistSize}`;
      const resp = await fetch_(url);
      if (!resp.ok) {
        logger.warn({ status: resp.status }, "GammaPoller: non-OK response");
        return;
      }
      markets = (await resp.json()) as unknown[];
    } catch (err) {
      logger.error({ err }, "GammaPoller: fetch failed");
      return;
    }

    const newTokenIds: TokenId[] = [];
    const newNegRiskIds: TokenId[] = [];
    const newlyWatchlisted: TokenId[] = [];

    for (const raw of markets) {
      const parsed = ZGammaMarket.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.errors }, "GammaPoller: skipping invalid market");
        continue;
      }

      const m = parsed.data;
      const tokenIds = m.clobTokenIds ?? [];
      const isNegRisk = m.negRisk ?? false;
      const watchlisted = !isNegRisk;

      for (let i = 0; i < tokenIds.length; i++) {
        const tokenId = tokenIds[i];
        const wasWatchlisted = this.watchlistSet.has(tokenId);

        await upsertMarket(db, {
          ...m,
          tokenId,
          outcomeIndex: i,
          watchlisted,
          negRisk: isNegRisk,
          question: m.question ?? "",
        });

        if (isNegRisk) {
          this.negRiskSet.add(tokenId);
          newNegRiskIds.push(tokenId);
        } else {
          this.watchlistSet.add(tokenId);
          newTokenIds.push(tokenId);

          // Bootstrap stats for newly added tokens
          if (!wasWatchlisted) {
            newlyWatchlisted.push(tokenId);
            bootstrapMarketStats(db, tokenId, m.conditionId).catch((err) =>
              logger.error({ err, tokenId }, "GammaPoller: stats bootstrap failed")
            );
          }
        }

        // Upsert market stats from Gamma data
        await upsertMarketStats(db, {
          tokenId,
          conditionId: m.conditionId,
          volume24hr: m.volume24hr ?? 0,
          bestBid: m.bestBid ?? null,
          bestAsk: m.bestAsk ?? null,
          lastTradePrice: m.lastTradePrice ?? null,
          liquidityUsdc: m.liquidity ?? null,
          oneDayPriceChange: m.oneDayPriceChange ?? null,
        });
      }
    }

    this.emit("markets_updated", newTokenIds, newNegRiskIds);

    if (newlyWatchlisted.length > 0) {
      logger.info({ count: newlyWatchlisted.length }, "GammaPoller: new tokens added to watchlist");
    }
  }

  /**
   * Handle a trade for a token not in the watchlist.
   * Creates a minimal market row and schedules stats bootstrap.
   * Promotes to watchlist if activity crosses threshold.
   */
  async handleUnknownTrade(
    tokenId: TokenId,
    conditionId: string,
    activityCount: number,
    promotionThreshold = 5
  ): Promise<void> {
    const { db } = this.options;

    if (!this.watchlistSet.has(tokenId) && !this.negRiskSet.has(tokenId)) {
      // Create minimal market row
      await upsertMarket(db, {
        tokenId,
        conditionId,
        question: "",
        watchlisted: false,
        negRisk: false,
        active: true,
        closed: false,
        clobTokenIds: [tokenId],
      });

      logger.info({ tokenId }, "GammaPoller: created minimal market row for unknown token");
    }

    if (activityCount >= promotionThreshold && !this.watchlistSet.has(tokenId)) {
      this.watchlistSet.add(tokenId);
      // Re-upsert with watchlisted=true
      await upsertMarket(db, {
        tokenId,
        conditionId,
        question: "",
        watchlisted: true,
        negRisk: false,
        active: true,
        closed: false,
        clobTokenIds: [tokenId],
      });
      await bootstrapMarketStats(db, tokenId, conditionId).catch((err) =>
        logger.error({ err, tokenId }, "GammaPoller: stats bootstrap for promoted token failed")
      );
      logger.info({ tokenId, activityCount }, "GammaPoller: promoted unknown token to watchlist");
    }
  }
}
