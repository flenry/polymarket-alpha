import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { NegRiskGroup, NegRiskToken } from "./group-resolver.js";
import { getTokenPriceHistory24h } from "../db/queries/price-history.js";
import { config } from "../config.js";
import type { NegRiskSignal, ConditionId } from "../events/types.js";

type Db = NodePgDatabase<typeof schema>;

function populationStddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function buildArbSignal(
  dominantToken: NegRiskToken,
  group: NegRiskGroup,
  arbSpread: number,
  confidence: number
): NegRiskSignal {
  return {
    signalType: "NEG_RISK_ARB",
    tokenId: dominantToken.tokenId,
    conditionId: group.conditionId,
    direction: "BULLISH",
    confidence,
    strength: Math.abs(arbSpread),
    priceAtSignal: dominantToken.bestAsk,
    createdAt: new Date(),
    payload: {
      arbSpread,
      sumAsk: group.sumAsk,
      sumBid: group.sumBid,
      groupSize: group.tokens.length,
    },
    arbSpread,
    negRiskGroupSize: group.tokens.length,
    negRiskSumBid: group.sumBid,
    negRiskSumAsk: group.sumAsk,
    conditionIdGroup: group.conditionId,
  };
}

function buildOutlierSignal(
  outlierToken: NegRiskToken,
  group: NegRiskGroup,
  deviation: number,
  direction: "BULLISH" | "BEARISH",
  confidence: number
): NegRiskSignal {
  return {
    signalType: "NEG_RISK_OUTLIER",
    tokenId: outlierToken.tokenId,
    conditionId: group.conditionId,
    direction,
    confidence,
    strength: deviation,
    priceAtSignal: outlierToken.bestAsk,
    createdAt: new Date(),
    payload: {
      priceDeviation: deviation,
      direction,
      sumAsk: group.sumAsk,
      sumBid: group.sumBid,
      groupSize: group.tokens.length,
    },
    priceDeviation: deviation,
    negRiskGroupSize: group.tokens.length,
    negRiskSumBid: group.sumBid,
    negRiskSumAsk: group.sumAsk,
    conditionIdGroup: group.conditionId,
  };
}

export class ArbDetector {
  private readonly lastEmit = new Map<ConditionId, number>();
  private readonly arbThreshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly db: Db,
    opts?: { arbThreshold?: number; cooldownMs?: number }
  ) {
    this.arbThreshold = opts?.arbThreshold ?? config.negRiskArbThreshold;
    this.cooldownMs = opts?.cooldownMs ?? config.negRiskCooldownMs;
  }

  async evaluate(group: NegRiskGroup): Promise<NegRiskSignal[]> {
    if (!group.isValid || group.tokens.length < 2) return [];

    const now = Date.now();
    const lastEmitTs = this.lastEmit.get(group.conditionId) ?? 0;
    if (now - lastEmitTs < this.cooldownMs) return [];

    const impliedProb = group.sumAsk;
    const arbSpread = impliedProb - 1.0;
    const dominantToken = group.tokens.reduce((max, t) => (t.bestAsk > max.bestAsk ? t : max));

    const signals: NegRiskSignal[] = [];

    // ─── ARB signal ──────────────────────────────────────────────────────────
    if (arbSpread < this.arbThreshold) {
      const confidence = Math.min(1.0, Math.abs(arbSpread) / 0.05);
      signals.push(buildArbSignal(dominantToken, group, arbSpread, confidence));
    }

    // ─── OUTLIER signal ──────────────────────────────────────────────────────
    let maxDev = 0;
    let outlierToken: NegRiskToken | null = null;
    let outlierDirection: "BULLISH" | "BEARISH" = "BULLISH";

    for (const token of group.tokens) {
      let history;
      try {
        history = await getTokenPriceHistory24h(this.db, token.tokenId);
      } catch {
        continue;
      }

      if (history.length < 5) continue;

      const prices = history.map((r) => r.price);
      const mu = mean(prices);
      const sigma = populationStddev(prices);
      if (sigma < 1e-10) continue; // guard against floating-point near-zero stddev

      const underpricedDev = (mu - token.bestAsk) / sigma; // positive = underpriced
      const overpricedDev = (token.bestAsk - mu) / sigma;  // positive = overpriced

      const absDev = Math.max(underpricedDev, overpricedDev);
      if (absDev > maxDev) {
        maxDev = absDev;
        outlierToken = token;
        outlierDirection = underpricedDev >= overpricedDev ? "BULLISH" : "BEARISH";
      }
    }

    if (maxDev > 3.0 && outlierToken !== null) {
      const confidence = Math.min(1.0, maxDev / 5.0);
      signals.push(buildOutlierSignal(outlierToken, group, maxDev, outlierDirection, confidence));
    }

    if (signals.length > 0) {
      this.lastEmit.set(group.conditionId, now);
    }

    return signals;
  }
}
