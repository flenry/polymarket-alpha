import type { TradeEvent, MarketStats } from "../events/types.js";

// ─── Market parsing ────────────────────────────────────────────────────────────

/**
 * Parse the clobTokenIds field which may be a JSON array string, already-parsed
 * array, or any other value. Returns a deduplicated string array.
 */
export function parseClobTokenIds(raw: unknown): string[] {
  let arr: unknown;

  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  } else {
    return [];
  }

  if (!Array.isArray(arr)) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (typeof item === "string" && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

// ─── DataApiTrade interface ───────────────────────────────────────────────────

export interface DataApiTrade {
  asset: string; // tokenId
  conditionId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  proxyWallet: string;
  transactionHash: string;
  timestamp: number; // Unix seconds
  outcome?: string;
  slug?: string;
  eventSlug?: string;
  title?: string;
  pseudonym?: string | null;
  name?: string | null;
}

/**
 * Convert a raw DataApiTrade into the internal TradeEvent shape.
 * valueUsdc = size * price. tradedAt = new Date(timestamp * 1000).
 */
export function buildTradeEventFromDataApi(
  raw: DataApiTrade,
  market: {
    conditionId: string;
    outcome: string;
    slug?: string | null;
    eventSlug?: string | null;
    question: string;
  }
): TradeEvent {
  return {
    tokenId: raw.asset,
    conditionId: raw.conditionId || market.conditionId,
    side: raw.side,
    sizeTokens: raw.size,
    priceUsdc: raw.price,
    valueUsdc: raw.size * raw.price,
    proxyWallet: raw.proxyWallet,
    transactionHash: raw.transactionHash,
    tradedAt: new Date(raw.timestamp * 1000),
    outcome: raw.outcome ?? market.outcome,
    marketSlug: raw.slug ?? market.slug ?? "",
    eventSlug: raw.eventSlug ?? market.eventSlug ?? "",
    marketTitle: raw.title ?? market.question,
    traderName: raw.name ?? undefined,
    traderPseudonym: raw.pseudonym ?? undefined,
    source: "data_api",
  };
}

// ─── Market stats computation ─────────────────────────────────────────────────

/**
 * Compute MarketStats from a list of trade events for a single token.
 * Uses population stddev: sqrt(sum((x - mean)²) / n), 0 when n < 2.
 * calibrated = tradeCount24h >= 30.
 */
export function computeMarketStats(
  tokenId: string,
  _conditionId: string,
  trades: TradeEvent[]
): MarketStats {
  const n = trades.length;

  if (n === 0) {
    return {
      tokenId,
      volume24hr: 0,
      avgTradeSize24h: 0,
      stddevTradeSize24h: 0,
      liquidityUsdc: 0,
      tradeCount24h: 0,
      calibrated: false,
    };
  }

  const volume24hr = trades.reduce((sum, t) => sum + t.valueUsdc, 0);
  const avgTradeSize24h = volume24hr / n;

  let stddevTradeSize24h = 0;
  if (n >= 2) {
    const variance =
      trades.reduce((sum, t) => sum + Math.pow(t.valueUsdc - avgTradeSize24h, 2), 0) / n;
    stddevTradeSize24h = Math.sqrt(variance);
  }

  return {
    tokenId,
    volume24hr,
    avgTradeSize24h,
    stddevTradeSize24h,
    liquidityUsdc: 0, // not derivable from trades alone
    tradeCount24h: n,
    calibrated: n >= 30,
  };
}

// ─── Wallet aggregation ───────────────────────────────────────────────────────

export interface WalletAggregate {
  proxyWallet: string;
  totalVolumeUsdc: number;
  tradeCount: number;
  whaleTradeCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Build per-wallet aggregate stats from a set of trades.
 * whaleLookup is a Set of lookup keys (txHash|tokenId|proxyWallet|tradedAt|price|size)
 * as produced by buildTradeLookupKey.
 */
export function buildWalletAggregates(
  trades: TradeEvent[],
  whaleLookup: Set<string>
): Map<string, WalletAggregate> {
  const map = new Map<string, WalletAggregate>();

  for (const trade of trades) {
    const key = trade.proxyWallet;
    let agg = map.get(key);

    if (!agg) {
      agg = {
        proxyWallet: trade.proxyWallet,
        totalVolumeUsdc: 0,
        tradeCount: 0,
        whaleTradeCount: 0,
        firstSeenAt: trade.tradedAt,
        lastSeenAt: trade.tradedAt,
      };
      map.set(key, agg);
    }

    agg.totalVolumeUsdc += trade.valueUsdc;
    agg.tradeCount += 1;

    const lookupKey = [
      trade.transactionHash,
      trade.tokenId,
      trade.proxyWallet,
      trade.tradedAt.toISOString(),
      trade.priceUsdc.toString(),
      trade.sizeTokens.toString(),
    ].join("|");
    if (whaleLookup.has(lookupKey)) {
      agg.whaleTradeCount += 1;
    }

    if (trade.tradedAt < agg.firstSeenAt) agg.firstSeenAt = trade.tradedAt;
    if (trade.tradedAt > agg.lastSeenAt) agg.lastSeenAt = trade.tradedAt;
  }

  return map;
}
