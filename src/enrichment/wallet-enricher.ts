import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { WhaleAlert } from "../events/types.js";
import { ZDataApiTrade } from "../validation/schemas.js";
import { upsertWalletProfile, getWalletProfile } from "../db/queries/wallets.js";
import { enrichWhaleAlert } from "../db/queries/whales.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { z } from "zod";

type Db = NodePgDatabase<typeof schema>;

// ── Token bucket (2 req/s by default) ─────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private readonly max: number;
  private readonly refillMs: number;
  private lastRefill: number;

  constructor(rps: number) {
    this.max = rps;
    this.tokens = rps;
    this.refillMs = 1000 / rps;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = () => {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const newTokens = Math.floor(elapsed / this.refillMs);
        if (newTokens > 0) {
          this.tokens = Math.min(this.max, this.tokens + newTokens);
          this.lastRefill = now;
        }
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
        } else {
          const wait = this.refillMs - (now - this.lastRefill);
          setTimeout(attempt, Math.max(1, wait));
        }
      };
      attempt();
    });
  }
}

const WHALE_TRADE_THRESHOLD_USDC = 10_000;
const DATA_API_BASE = "https://data-api.polymarket.com";

export class WalletEnricher {
  private readonly timeoutMs: number;
  private readonly recencyHours: number;
  private readonly bucket: TokenBucket;

  constructor(
    private readonly db: Db,
    opts?: { timeoutMs?: number; rps?: number; recencyHours?: number }
  ) {
    this.timeoutMs = opts?.timeoutMs ?? config.walletEnrichmentTimeoutMs;
    this.recencyHours = opts?.recencyHours ?? config.walletEnrichmentRecencyHours;
    const rps = opts?.rps ?? config.walletEnrichmentRateLimitRps;
    this.bucket = new TokenBucket(rps);
  }

  /** Fire-and-forget enrichment — never throws */
  enrich(alert: WhaleAlert, alertId: bigint): void {
    this._enrich(alert, alertId).catch((err: unknown) => {
      logger.warn({ err, proxyWallet: alert.trade.proxyWallet }, "WalletEnricher: unexpected error");
    });
  }

  async _enrich(alert: WhaleAlert, alertId: bigint): Promise<void> {
    const { proxyWallet } = alert.trade;

    // Guard: truncate if wallet exceeds varchar(42) schema limit
    const wallet = proxyWallet.length > 42
      ? (logger.warn({ proxyWallet }, "WalletEnricher: wallet address exceeds 42 chars, truncating"), proxyWallet.slice(0, 42))
      : proxyWallet;

    // ── Recency guard ────────────────────────────────────────────────────────
    const existing = await getWalletProfile(this.db, wallet);
    if (existing?.lastEnrichedAt) {
      const ageMs = Date.now() - existing.lastEnrichedAt.getTime();
      if (ageMs < this.recencyHours * 3_600_000) {
        // Use cached data — skip API call
        await enrichWhaleAlert(this.db, alertId, {
          walletTotalVolumeUsdc: existing.totalVolumeUsdc ?? undefined,
          walletTradeCount: existing.tradeCount ?? undefined,
          walletFirstSeenAt: existing.firstSeenAt ?? undefined,
        });
        logger.info({ wallet, ageMs }, "WalletEnricher: recency guard hit, used cached profile");
        return;
      }
    }

    // ── Rate limit ────────────────────────────────────────────────────────────
    await this.bucket.acquire();

    // ── Fetch with timeout ─────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let trades: z.infer<typeof ZDataApiTrade>[];
    try {
      const url = `${DATA_API_BASE}/activity?user=${encodeURIComponent(wallet)}&limit=100`;
      const response = await globalThis.fetch(url, { signal: controller.signal });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 10_000;
        logger.warn({ wallet, waitMs }, "WalletEnricher: 429 received, waiting before retry");
        await new Promise((r) => setTimeout(r, waitMs));
        clearTimeout(timer);

        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), this.timeoutMs);
        try {
          const retry = await globalThis.fetch(url, { signal: controller2.signal });
          clearTimeout(timer2);
          if (retry.status === 429) {
            logger.warn({ wallet }, "WalletEnricher: retry also 429, giving up");
            return;
          }
          const raw = await retry.json() as unknown;
          trades = this.parseTrades(raw);
        } catch (err2) {
          clearTimeout(timer2);
          if ((err2 as Error).name === "AbortError") {
            logger.warn({ wallet }, "WalletEnricher: timeout on retry");
          } else {
            logger.warn({ err: err2, wallet }, "WalletEnricher: retry fetch error");
          }
          return;
        }
      } else {
        clearTimeout(timer);
        const raw = await response.json() as unknown;
        trades = this.parseTrades(raw);
      }
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        logger.warn({ wallet }, "WalletEnricher: timeout");
      } else {
        logger.warn({ err, wallet }, "WalletEnricher: fetch error");
      }
      return;
    }

    // ── Compute stats ──────────────────────────────────────────────────────
    const totalVolumeUsdc = trades.reduce((sum, t) => sum + t.size * t.price, 0);
    const tradeCount = trades.length;
    const whaleTradeCount = trades.filter((t) => t.size * t.price > WHALE_TRADE_THRESHOLD_USDC).length;

    let firstSeenAt: Date;
    let lastSeenAt: Date;
    if (trades.length === 0) {
      firstSeenAt = new Date(0);
      lastSeenAt = new Date(0);
    } else {
      const timestamps = trades.map((t) => t.timestamp * 1000);
      firstSeenAt = new Date(Math.min(...timestamps));
      lastSeenAt = new Date(Math.max(...timestamps));
    }

    // ── Upsert wallet profile ──────────────────────────────────────────────
    await upsertWalletProfile(this.db, {
      proxyWallet: wallet,
      totalVolumeUsdc,
      tradeCount,
      whaleTradeCount,
      firstSeenAt,
      lastSeenAt,
    });

    // ── Enrich whale_alert row ─────────────────────────────────────────────
    await enrichWhaleAlert(this.db, alertId, {
      walletTotalVolumeUsdc: totalVolumeUsdc,
      walletTradeCount: tradeCount,
      walletFirstSeenAt: firstSeenAt,
    });

    logger.info({ wallet, tradeCount, totalVolumeUsdc, whaleTradeCount }, "WalletEnricher: enrichment complete");
  }

  private parseTrades(raw: unknown): z.infer<typeof ZDataApiTrade>[] {
    if (!Array.isArray(raw)) return [];
    const result: z.infer<typeof ZDataApiTrade>[] = [];
    for (const item of raw) {
      const parsed = ZDataApiTrade.safeParse(item);
      if (parsed.success) result.push(parsed.data);
    }
    return result;
  }
}
