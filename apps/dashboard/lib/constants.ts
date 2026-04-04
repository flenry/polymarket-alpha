export const SIGNAL_TYPES = [
  "WHALE_TRADE",
  "ORDER_BOOK_IMBALANCE",
  "PRICE_IMPACT_ANOMALY",
  "SENTIMENT_VELOCITY",
  "NEG_RISK_ARB",
  "NEG_RISK_OUTLIER",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];
