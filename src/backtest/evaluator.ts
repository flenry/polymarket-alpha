import type { SignalType } from "../events/types.js";
import type { BacktestConfig, BacktestMetrics, BacktestResult, SignalOutcome } from "./types.js";

function computeMetrics(outcomes: SignalOutcome[]): BacktestMetrics {
  const totalFired = outcomes.length;
  const resolved = outcomes.filter((o) => o.marketWinner !== null);
  const totalResolved = resolved.length;
  const totalCorrect = resolved.filter((o) => o.marketWinner === true).length;

  const precision = totalFired > 0 ? totalCorrect / totalFired : 0;
  const resolvedHitRate = totalResolved > 0 ? totalCorrect / totalResolved : 0;

  const f1 =
    precision + resolvedHitRate > 0
      ? (2 * precision * resolvedHitRate) / (precision + resolvedHitRate)
      : 0;

  const avgConfidence =
    totalFired > 0
      ? outcomes.reduce((sum, o) => sum + o.confidence, 0) / totalFired
      : 0;

  return { totalFired, totalResolved, totalCorrect, precision, resolvedHitRate, f1, avgConfidence };
}

/**
 * Pure evaluator — takes resolved signal outcomes and computes per-type and overall metrics.
 * No DB access; all data must be provided by the runner.
 */
export function evaluate(outcomes: SignalOutcome[], _config: BacktestConfig): BacktestResult {
  // Group by signal type
  const byTypeMap = new Map<SignalType, SignalOutcome[]>();
  for (const o of outcomes) {
    if (!byTypeMap.has(o.signalType)) byTypeMap.set(o.signalType, []);
    byTypeMap.get(o.signalType)!.push(o);
  }

  const byType: Partial<Record<SignalType, BacktestMetrics>> = {};
  for (const [type, typeOutcomes] of byTypeMap) {
    byType[type] = computeMetrics(typeOutcomes);
  }

  const overall = computeMetrics(outcomes);

  return { config: _config, byType, overall };
}
