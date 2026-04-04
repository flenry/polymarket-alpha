import type { SignalType } from "../events/types.js";

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  signalTypes?: SignalType[];
  minConfidence?: number;
  tokenIds?: string[];
}

export interface BacktestMetrics {
  totalFired: number;
  /** Signals with a resolved market (winner IS NOT NULL) */
  totalResolved: number;
  /** Resolved signals where direction matched the winner outcome */
  totalCorrect: number;
  /** totalCorrect / max(totalFired, 1) */
  precision: number;
  /** totalCorrect / max(totalResolved, 1) — hit rate on resolved markets */
  resolvedHitRate: number;
  /** Harmonic mean of precision and resolvedHitRate */
  f1: number;
  avgConfidence: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  byType: Partial<Record<SignalType, BacktestMetrics>>;
  overall: BacktestMetrics;
}

export interface SignalOutcome {
  signalId: bigint;
  signalType: SignalType;
  /** BULLISH or BEARISH direction from the signal */
  direction: "BULLISH" | "BEARISH";
  confidence: number;
  tokenId: string;
  createdAt: Date;
  /**
   * Whether the market resolved in favour of the signal direction.
   * null = unresolved market (winner IS NULL).
   */
  marketWinner: boolean | null;
}
